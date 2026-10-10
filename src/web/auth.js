/**
 * src/web/auth.js — parents sign in at quizpe.in/app (user, 2026-10-08:
 * WhatsApp is gone; QuizPe runs on the web the way GaadiPe does).
 * ---------------------------------------------------------------------------
 *   requestCode(mobile, ip)              a 6-digit code by SMS (Fast2SMS DLT)
 *   verifyCode(mobile, code, meta)       -> a session token for the browser
 *   sessionOf(req)                       the signed-in mobile, or null
 *   signOut(req)
 *
 * The mobile number IS the account, exactly as on WhatsApp: a parent who used
 * QuizPe on WhatsApp signs in with the same number and finds their children,
 * plan and reports already there.
 *
 * Rules, as for the admin codes (src/admin/otp.js):
 *   • codes are stored hashed, single use, and one live code per number
 *   • 5 wrong tries burn the code; codes expire after CODE_TTL_MIN
 *   • a new code can be asked for only every RESEND_SEC seconds
 *   • Terms and Privacy must be ticked before a code is checked; the moment
 *     is kept on the session row
 *   • session tokens are random and stored only as a SHA-256 hash
 *
 * Codes go out by SMS on GaadiPe's registered OTP template (src/web/sms.js).
 * Off production, the owner's own number(s) take a fixed code and are never
 * sent an SMS, so local testing never spends credits or messages anyone
 * (PARENT_FIXED_CODE; PARENT_FIXED_CODE_MOBILES, default ADMIN_MOBILES).
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const db = require('../database/connectDB');

const CODE_TTL_MIN = Number(process.env.PARENT_CODE_TTL_MIN) || 10;
const MAX_TRIES = 5;
const RESEND_SEC = Number(process.env.PARENT_CODE_RESEND_SEC) || 30;
// 30 days, counted from the last time the app was used (user, 2026-10-10: "the
// session will be for 30 days"): open it at least once a month and it stays signed in.
const SESSION_DAYS = Number(process.env.PARENT_SESSION_DAYS) || 30;
const FIXED_CODE = process.env.PARENT_FIXED_CODE || '641641';
// Real SMS for everyone on the live server (user, 2026-10-08: "go with
// realtime SMS"). The fixed owner code works only off production, or when
// PARENT_FIXED_CODE_MOBILES is set there on purpose.
const FIXED_MOBILES = String(process.env.PARENT_FIXED_CODE_MOBILES
  || (process.env.NODE_ENV === 'production' ? '' : process.env.ADMIN_MOBILES) || '')
  .split(',').map((m) => m.replace(/\D/g, '').slice(-10)).filter((m) => m.length === 10);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normMobile = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};
const validMobile = (m) => /^[6-9]\d{9}$/.test(m);
const fail = (status, error) => Object.assign(new Error(error), { status });

async function requestCode(rawMobile, ip) {
  const mobile = normMobile(rawMobile);
  if (!validMobile(mobile)) throw fail(400, 'Enter your 10-digit mobile number.');

  const recent = await db.query(
    `SELECT 1 FROM parent_web_codes
      WHERE mobile_number = $1 AND created_at > now() - ($2 || ' seconds')::interval LIMIT 1`,
    [mobile, String(RESEND_SEC)]);
  if (recent.rowCount) throw fail(429, 'A code was just sent. Please wait a few seconds before asking again.');

  const fixed = FIXED_MOBILES.includes(mobile);
  const code = fixed ? FIXED_CODE : String(crypto.randomInt(100000, 1000000));
  await db.query(`UPDATE parent_web_codes SET consumed_at = now() WHERE mobile_number = $1 AND consumed_at IS NULL`, [mobile]);

  let ref = null;
  if (!fixed) ref = await require('./sms').sendSignInCode(mobile, code, CODE_TTL_MIN);

  await db.query(
    `INSERT INTO parent_web_codes (mobile_number, code_hash, expires_at, request_ip, provider_ref)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4, $5)`,
    [mobile, sha(code), String(CODE_TTL_MIN), ip || null, ref]);
  return { ok: true, mobile, ttl_min: CODE_TTL_MIN };
}

async function verifyCode(rawMobile, code, { termsAccepted, ip, userAgent } = {}) {
  const mobile = normMobile(rawMobile);
  if (!validMobile(mobile)) throw fail(400, 'Enter your 10-digit mobile number.');
  // Checked before the code, so a refused sign-in does not use the code up.
  if (termsAccepted !== true) throw fail(400, 'Please accept the Terms and Privacy Policy to continue.');

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `SELECT id, code_hash, attempts FROM parent_web_codes
        WHERE mobile_number = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [mobile]);
    const row = rows[0];
    if (!row) { await c.query('COMMIT'); throw fail(400, 'That code has expired. Please ask for a new one.'); }

    const given = Buffer.from(sha(String(code || '').trim()));
    const want = Buffer.from(row.code_hash);
    const match = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!match) {
      const tries = row.attempts + 1;
      await c.query(
        tries >= MAX_TRIES ? `UPDATE parent_web_codes SET attempts = $2, consumed_at = now() WHERE id = $1`
                           : `UPDATE parent_web_codes SET attempts = $2 WHERE id = $1`, [row.id, tries]);
      await c.query('COMMIT');
      throw fail(400, tries >= MAX_TRIES ? 'Too many wrong tries. Please ask for a new code.' : 'That code is not right. Please check and try again.');
    }
    await c.query(`UPDATE parent_web_codes SET consumed_at = now() WHERE id = $1`, [row.id]);

    const token = crypto.randomBytes(32).toString('base64url');
    await c.query(
      `INSERT INTO parent_web_sessions (token_hash, mobile_number, ip, user_agent, terms_accepted_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' days')::interval)`,
      [sha(token), mobile, ip || null, String(userAgent || '').slice(0, 400) || null, String(SESSION_DAYS)]);

    // The agreement is also kept where the WhatsApp one was (once per number
    // per policy version — consent_once), so the admin panel's consent records
    // cover web sign-ins too. Each sign-in's own tick is on its session row.
    await c.query(
      `INSERT INTO policy_consents (parent_id, policy_id, mobile_number)
       SELECT (SELECT id FROM parents WHERE parent_mobile_number = $1), pol.id, $1
         FROM policies pol WHERE pol.policy_code = 'terms' AND pol.is_active
       ON CONFLICT (mobile_number, policy_id) DO NOTHING`, [mobile]);
    await c.query('COMMIT');
    // Signing in again withdraws the parent's own deactivation (2026-10-10), as on GaadiPe:
    // reminders and quizzes come back. An admin's deactivation or a STOP is not touched.
    let reactivated = false;
    try {
      const r = await db.query(
        `UPDATE parents SET is_active = true, service_paused = false, reminders_enabled = true, paused_at = NULL,
                deactivated_at = NULL, deactivated_reason = NULL, modified_at = now()
          WHERE parent_mobile_number = $1 AND deactivated_at IS NOT NULL`, [mobile]);
      reactivated = r.rowCount > 0;
    } catch { /* the column comes with migrate.js parent_self_deactivate */ }
    return { token, mobile, reactivated };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const tokenOf = (req) => {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

/** The signed-in parent's mobile, or null. Moves last_seen at most once a minute. */
async function sessionOf(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE parent_web_sessions
        SET last_seen_at = CASE WHEN last_seen_at < now() - interval '1 minute' THEN now() ELSE last_seen_at END,
            expires_at   = CASE WHEN last_seen_at < now() - interval '1 minute' THEN now() + ($2 || ' days')::interval ELSE expires_at END
      WHERE token_hash = $1 AND ended_at IS NULL AND expires_at > now()
      RETURNING id, mobile_number`, [sha(token), String(SESSION_DAYS)]);
  return rows[0] ? { id: rows[0].id, mobile: rows[0].mobile_number } : null;
}

async function signOut(req) {
  const token = tokenOf(req);
  if (token) await db.query(`UPDATE parent_web_sessions SET ended_at = now() WHERE token_hash = $1 AND ended_at IS NULL`, [sha(token)]);
}

/** "Sign out from all devices": every session of this number, and its phone notifications. */
async function signOutAll(mobile) {
  const { rowCount } = await db.query(
    `UPDATE parent_web_sessions SET ended_at = now() WHERE mobile_number = $1 AND ended_at IS NULL`, [mobile]);
  await db.query(`DELETE FROM parent_push WHERE mobile_number = $1`, [mobile]);
  return { ended: rowCount };
}

/** Express middleware: 401 unless signed in; sets req.parentMobile. */
async function requireParent(req, res, next) {
  try {
    const s = await sessionOf(req);
    if (!s) return res.status(401).json({ success: false, code: 'SIGN_IN', error: 'Please sign in again.' });
    req.parentMobile = s.mobile;
    req.parentSessionId = s.id;
    return next();
  } catch (e) { return next(e); }
}

module.exports = { requestCode, verifyCode, sessionOf, signOut, signOutAll, requireParent, normMobile, SESSION_DAYS };
