/**
 * src/admin/auth.js
 * ---------------------------------------------------------------------------
 * Admin authentication for the QuizPe panel.
 *
 * Sign-in is mobile number + a one-time code sent by SMS (see ./otp.js).
 *
 * The panel exposes children's names, parents' mobile numbers, payments and
 * GST records, so it is gated hard:
 *   • only numbers in ADMIN_MOBILES may request a code or sign in
 *   • the code is single use, expires in minutes, and is stored hashed
 *   • attempts are rate-limited per number and per IP
 *   • the process REFUSES TO START in production without a real JWT secret
 *
 * The old fixed PIN is gone. ADMIN_PIN is still read, but only as a local
 * development shortcut, and only when ADMIN_ALLOW_PIN=1 outside production —
 * so it can never become the way in by accident.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../database/connectDB');

const otp = require('./otp');

// Bootstrap admins from the environment; the live list is the `admins` table
// (env numbers are seeded there at startup). Env acts only as a fallback so a
// misconfigured DB can never lock the founder out.
const ENV_MOBILES = String(process.env.ADMIN_MOBILES || '9886122415')
  .split(',').map(s => s.replace(/\D/g, '').slice(-10)).filter(Boolean);
const MOBILES = ENV_MOBILES;   // kept for the startup guard / seed

/** Active admin numbers = DB table ∪ env fallback. */
async function adminMobiles() {
  try {
    const { rows } = await db.query(`SELECT mobile_number FROM admins WHERE is_active`);
    const set = new Set(rows.map(r => norm(r.mobile_number)));
    ENV_MOBILES.forEach(m => set.add(m));
    return set;
  } catch { return new Set(ENV_MOBILES); }
}

/** Is this number a super admin (may manage other admins / mode switches)? */
async function isSuperAdmin(mobile) {
  const m = norm(mobile);
  if (ENV_MOBILES[0] === m) return true;   // founder is always super
  const { rows } = await db.query(
    `SELECT 1 FROM admins WHERE mobile_number LIKE '%'||$1 AND is_super AND is_active LIMIT 1`, [m]).catch(() => ({ rows: [] }));
  return rows.length > 0;
}

// Local-only shortcut, off unless explicitly switched on and never in prod.
const ALLOW_PIN = process.env.ADMIN_ALLOW_PIN === '1' && process.env.NODE_ENV !== 'production';
const PIN = process.env.ADMIN_PIN || '';

const SECRET = process.env.ADMIN_JWT_SECRET
  // A derived fallback keeps development working, but it must never be the
  // production secret: anyone who knows the inputs can mint an admin token.
  || crypto.createHash('sha256').update(`quizpe:dev:${MOBILES.join()}`).digest('hex');
// Short by design: a stolen admin token is a full read of every child's data.
// 12 hours meant a token lifted from a closed laptop stayed valid all night.
const TOKEN_HOURS = Number(process.env.ADMIN_TOKEN_HOURS) || 2;
const IS_PROD = process.env.NODE_ENV === 'production';

// naive in-memory throttle; enough for a single-admin panel
const attempts = new Map();               // key -> { n, until }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;

/**
 * Loud start-up guard. These are the two ways a production panel ends up
 * effectively unprotected, and both are silent failures at runtime — so the
 * process refuses to boot instead.
 */
function assertNotProductionPin() {
  if (!IS_PROD) return;
  if (!process.env.ADMIN_JWT_SECRET || process.env.ADMIN_JWT_SECRET.length < 32) {
    throw new Error(
      'ADMIN AUTH: ADMIN_JWT_SECRET must be set to a long random value in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  }
  if (!(process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY)) {
    throw new Error(
      'ADMIN AUTH: FAST2SMSAPIKEY is not set, so no sign-in code can be delivered. ' +
      'Set it, or do not run with NODE_ENV=production.');
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

/** Ask the SMS provider to send a fresh code. */
async function requestCode(rawMobile, ip) {
  assertNotProductionPin();
  const mobile = norm(rawMobile);
  const key = `req|${mobile}|${ip}`;
  const wait = throttled(key);
  if (wait) return { error: `Too many requests. Try again in ${Math.ceil(wait / 60)} minute(s).` };
  noteFailure(key);                     // counts requests, not just failures
  return otp.request(mobile, [...await adminMobiles()], ip);
}

/** The ONLY place a credential is checked. */
async function verifyCredential(mobile, credential) {
  assertNotProductionPin();
  if (!(await adminMobiles()).has(mobile)) return false;
  if (await otp.verify(mobile, credential)) return true;

  // Development shortcut only — never reachable in production.
  if (ALLOW_PIN && PIN) {
    const a = Buffer.from(String(credential || ''));
    const b = Buffer.from(PIN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
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
    return { error: 'That code is not valid or has expired.' };
  }
  clearFailures(key);

  const superAdmin = await isSuperAdmin(mobile);
  const token = jwt.sign({ sub: mobile, role: 'admin', super: superAdmin }, SECRET, { expiresIn: `${TOKEN_HOURS}h` });
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

/** Gate for super-admin-only actions (managing admins, switching payment mode). */
function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (!req.admin?.super) {
      return res.status(403).json({ success: false, error: 'Only the super admin can do this.' });
    }
    next();
  });
}

module.exports = {
  login, requestCode, requireAdmin, requireSuperAdmin, assertNotProductionPin,
  adminMobiles, isSuperAdmin, MOBILES, TOKEN_HOURS,
};
