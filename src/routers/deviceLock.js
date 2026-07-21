/**
 * src/routers/deviceLock.js
 * ---------------------------------------------------------------------------
 * Binds a quiz link to the FIRST device that opens it.
 *
 * THE PROBLEM
 * A quiz link is delivered on WhatsApp. WhatsApp messages can be forwarded,
 * and a link can be copied and pasted into any chat. Without binding, the
 * token is a bearer credential: whoever holds it can answer. That is not
 * merely untidy — a stranger answering would write a false score into the
 * child's report and, worse, teach the adaptive engine the wrong thing about
 * what that child has mastered. The damage would persist for weeks.
 *
 * THE APPROACH
 * The first browser to open the link is issued a random device id in an
 * httpOnly cookie, and the link records it. Any later request carrying a
 * different id (or none, once claimed) is refused. The child can close and
 * reopen the page, switch from mobile data to wifi, or come back an hour
 * later — the cookie travels with the device, not the network.
 *
 * WHAT THIS DOES AND DOES NOT STOP
 * It stops a forwarded link being used on someone else's phone, which is the
 * realistic case. It cannot stop a parent handing over their own unlocked
 * phone — nothing server-side can, and that is their choice to make.
 *
 * Refusals are counted on the row so the admin panel can surface a link that
 * is being passed around.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const db = require('../database/connectDB');

const COOKIE = 'qp_device';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;     // 30 days

/** Read the device id from the cookie, or mint one and set it. */
function deviceId(req, res) {
  const existing = req.cookies?.[COOKIE];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;

  const id = crypto.randomBytes(16).toString('hex');
  res.cookie(COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    secure: String(process.env.PUBLIC_BASE_URL || '').startsWith('https'),
  });
  // make it readable within this request too, before the browser echoes it back
  req.cookies = { ...(req.cookies || {}), [COOKIE]: id };
  return id;
}

/**
 * Claim the link for this device, or verify an existing claim.
 * @returns {Promise<{ok:true} | {ok:false, code:string, error:string}>}
 */
async function claimOrVerify(table, row, req, res) {
  const id = deviceId(req, res);

  // first open — this device now owns the link
  if (!row.device_id) {
    await db.query(
      `UPDATE ${table} SET device_id = $2, device_ua = $3, claimed_at = now() WHERE id = $1`,
      [row.id, id, String(req.headers['user-agent'] || '').slice(0, 255)])
      .catch(() => {});   // binding must never block a child from starting
    return { ok: true, claimed: true };
  }

  if (row.device_id === id) return { ok: true, claimed: false };

  await db.query(
    `UPDATE ${table} SET foreign_attempts = COALESCE(foreign_attempts,0) + 1 WHERE id = $1`,
    [row.id]).catch(() => {});
  console.warn(`[deviceLock] ${table}#${row.id} opened from a different device (attempt ${(row.foreign_attempts || 0) + 1})`);

  return {
    ok: false,
    code: 'WRONG_DEVICE',
    error: 'This quiz was already opened on another device. For your child\'s score to mean anything, '
         + 'a quiz can only be answered on the phone it was sent to. If this is your quiz, open it from '
         + 'the button in your own WhatsApp chat.',
  };
}

module.exports = { deviceId, claimOrVerify, COOKIE };
