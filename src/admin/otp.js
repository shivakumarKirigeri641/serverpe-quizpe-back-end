/**
 * src/admin/otp.js
 * ---------------------------------------------------------------------------
 * One-time passcodes for admin sign-in, delivered by Fast2SMS on the DLT route.
 *
 * Replaces the fixed development PIN. The panel exposes children's names,
 * parents' mobile numbers, payments and GST records, so the rules here are
 * deliberately strict:
 *
 *   • only numbers in ADMIN_MOBILES can be sent a code at all
 *   • the code is stored as a SHA-256 hash, never in plain text — a database
 *     dump must not hand someone a live session
 *   • one live code per number: requesting a new one voids the previous one,
 *     so two codes are never valid at the same time
 *   • 5 wrong guesses burns the code; a 4-digit code is only 10,000 wide, so
 *     without that cap it is guessable in seconds
 *   • codes expire after OTP_TTL_MIN minutes and are single use
 *
 * Sending is best-effort in development: with no API key configured the code is
 * printed to the server log instead, so the flow can be exercised end to end
 * before SMS credits exist. That fallback is refused in production.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const db = require('../database/connectDB');

// Names match the existing .env entries; the _API_KEY / _TEMPLATE_ID
// spellings are accepted too so either convention works.
const API_KEY   = process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY || '';
const SENDER_ID = process.env.FAST2SMS_SENDER_ID || 'SRVRPE';
const TEMPLATE  = process.env.FAST2SMS_DLT_MESSAGE_ID || process.env.FAST2SMS_TEMPLATE_ID || '219444';
const ROUTE     = process.env.FAST2SMS_ROUTE || 'dlt';
const TTL_MIN   = Number(process.env.ADMIN_OTP_TTL_MIN) || 3;
const MAX_TRIES = 5;
const IS_PROD   = process.env.NODE_ENV === 'production';

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** 4 digits, drawn from a CSPRNG rather than Math.random. */
function generate() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

/**
 * Hand the code to Fast2SMS. Returns the provider's message id, or null when
 * running without a key in development.
 */
async function deliver(mobile, code) {
  if (!API_KEY) {
    if (IS_PROD) throw new Error('FAST2SMSAPIKEY is not set — cannot send admin OTP.');
    console.warn(`[admin-otp] no FAST2SMS_API_KEY — dev fallback, code for ${mobile} is ${code}`);
    return null;
  }

  // DLT route: `message` is the approved template id and `variables_values`
  // fills its placeholders in order — {#var#} 1 is the code, 2 the validity.
  const url = new URL('https://www.fast2sms.com/dev/bulkV2');
  url.searchParams.set('authorization', API_KEY);
  url.searchParams.set('route', ROUTE);
  url.searchParams.set('sender_id', SENDER_ID);
  url.searchParams.set('message', TEMPLATE);
  url.searchParams.set('variables_values', `${code}|${TTL_MIN}`);
  url.searchParams.set('numbers', mobile);
  url.searchParams.set('flash', '0');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res, body;
  try {
    res = await fetch(url, { signal: ctrl.signal });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'The SMS provider did not respond. Please try again.'
      : `Could not reach the SMS provider: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || body.return === false) {
    // Never echo the provider's raw text to the browser — it can contain the
    // account balance and other details that do not belong on a login screen.
    console.error('[admin-otp] fast2sms rejected:', res.status, JSON.stringify(body).slice(0, 300));
    throw new Error('Could not send the code right now. Please try again shortly.');
  }
  return Array.isArray(body.request_id) ? body.request_id[0] : (body.request_id || null);
}

/**
 * Issue a code to an allowed admin number.
 * `allowed` is passed in rather than imported, so auth.js stays the single
 * place that decides who is an admin.
 */
async function request(mobile, allowed, ip) {
  // Silently succeed for unknown numbers: telling a stranger that a number is
  // not an admin turns this endpoint into a way to enumerate admins.
  if (!allowed.includes(mobile)) return { ok: true, ttlMin: TTL_MIN };

  const recent = await db.query(
    `SELECT created_at FROM admin_otps
      WHERE mobile_number = $1 AND created_at > now() - interval '45 seconds'
      ORDER BY id DESC LIMIT 1`, [mobile]);
  if (recent.rowCount) {
    return { error: 'A code was just sent. Please wait a moment before asking for another.' };
  }

  const code = generate();
  // Void every earlier code first, so a screenshot of an old SMS is worthless.
  await db.query(
    `UPDATE admin_otps SET consumed_at = now()
      WHERE mobile_number = $1 AND consumed_at IS NULL`, [mobile]);

  const ref = await deliver(mobile, code);

  await db.query(
    `INSERT INTO admin_otps (mobile_number, otp_hash, expires_at, request_ip, provider_ref)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4, $5)`,
    [mobile, hash(code), String(TTL_MIN), ip || null, ref]);

  return { ok: true, ttlMin: TTL_MIN };
}

/**
 * Check a code. Consumes it on success, and counts the failure on a miss.
 * The row is locked FOR UPDATE so two racing submissions cannot both win.
 */
async function verify(mobile, code) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, otp_hash, attempts FROM admin_otps
        WHERE mobile_number = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1
        FOR UPDATE`, [mobile]);

    if (!rows.length) { await client.query('COMMIT'); return false; }
    const row = rows[0];

    if (row.attempts >= MAX_TRIES) {
      await client.query('UPDATE admin_otps SET consumed_at = now() WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return false;
    }

    const given = Buffer.from(hash(String(code || '')));
    const want = Buffer.from(row.otp_hash);
    const match = given.length === want.length && crypto.timingSafeEqual(given, want);

    await client.query(
      match ? 'UPDATE admin_otps SET consumed_at = now() WHERE id = $1'
            : 'UPDATE admin_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    await client.query('COMMIT');
    return match;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { request, verify, TTL_MIN, generate };
