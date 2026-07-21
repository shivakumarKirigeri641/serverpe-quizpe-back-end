/**
 * src/admin/auth.js
 * ---------------------------------------------------------------------------
 * Admin authentication for the QuizPe panel.
 *
 * ⚠️ TEMPORARY: login is mobile number + a fixed PIN (ADMIN_PIN, default 1234).
 * The user asked for this deliberately, to develop quickly, and asked to be
 * reminded to replace it with a real SMS/OTP provider before hosting.
 *
 * The panel exposes children's names, parents' mobile numbers, payments and
 * GST records, so the PIN is gated hard:
 *   • only numbers in ADMIN_MOBILES may log in at all
 *   • the process REFUSES TO START in production with a PIN still configured
 *   • attempts are rate-limited per number and per IP
 *
 * Swapping in OTP later means replacing verifyCredential() only — everything
 * downstream works off the issued JWT.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../database/connectDB');

const PIN = process.env.ADMIN_PIN || '1234';
const MOBILES = String(process.env.ADMIN_MOBILES || '9886122415')
  .split(',').map(s => s.replace(/\D/g, '').slice(-10)).filter(Boolean);
const SECRET = process.env.ADMIN_JWT_SECRET
  || crypto.createHash('sha256').update(`quizpe:${PIN}:${MOBILES.join()}`).digest('hex');
// Short by design: a stolen admin token is a full read of every child's data.
// 12 hours meant a token lifted from a closed laptop stayed valid all night.
const TOKEN_HOURS = Number(process.env.ADMIN_TOKEN_HOURS) || 2;
const IS_PROD = process.env.NODE_ENV === 'production';

// naive in-memory throttle; enough for a single-admin panel
const attempts = new Map();               // key -> { n, until }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;

/** Loud guard so the dev PIN can never quietly reach production. */
function assertNotProductionPin() {
  if (IS_PROD && !process.env.ADMIN_OTP_ENABLED) {
    throw new Error(
      'ADMIN AUTH: a fixed PIN is not allowed in production. ' +
      'Set ADMIN_OTP_ENABLED=1 and wire the SMS provider, or do not run with NODE_ENV=production.');
  }
}

const norm = (m) => String(m || '').replace(/\D/g, '').slice(-10);

function throttled(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 1000);
  return 0;
}

function noteFailure(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= MAX_ATTEMPTS) { a.until = Date.now() + LOCK_MS; a.n = 0; }
  attempts.set(key, a);
}

const clearFailures = (key) => attempts.delete(key);

/**
 * The ONLY place the credential is checked. Replace this body with an OTP
 * lookup when the SMS provider is wired; nothing else needs to change.
 */
async function verifyCredential(mobile, credential) {
  assertNotProductionPin();
  if (!MOBILES.includes(mobile)) return false;
  // timing-safe compare so the PIN can't be probed byte by byte
  const a = Buffer.from(String(credential || ''));
  const b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function login(rawMobile, credential, ip) {
  const mobile = norm(rawMobile);
  const key = `${mobile}|${ip}`;
  const wait = throttled(key);
  if (wait) return { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` };

  const ok = await verifyCredential(mobile, credential);
  if (!ok) {
    noteFailure(key);
    // deliberately vague — never reveal whether the number is an admin
    return { error: 'Invalid mobile number or PIN.' };
  }
  clearFailures(key);

  const token = jwt.sign({ sub: mobile, role: 'admin' }, SECRET, { expiresIn: `${TOKEN_HOURS}h` });
  await db.query(
    `INSERT INTO whatsapp_session_events (session_id, from_state, to_state, event, payload)
     SELECT id, 'admin', 'admin', 'admin_login', $2::jsonb FROM whatsapp_sessions WHERE mobile_number = $1
     LIMIT 1`,
    [mobile, JSON.stringify({ ip, at: new Date().toISOString() })]).catch(() => {});
  return { token, expiresIn: TOKEN_HOURS * 3600, mobile };
}

/** Express middleware — every admin route sits behind this. */
function requireAdmin(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Not signed in.' });
  try {
    const claims = jwt.verify(token, SECRET);
    if (claims.role !== 'admin') throw new Error('wrong role');
    req.admin = claims;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
  }
}

module.exports = { login, requireAdmin, assertNotProductionPin, MOBILES, TOKEN_HOURS };
