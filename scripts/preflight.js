/**
 * scripts/preflight.js
 * ---------------------------------------------------------------------------
 * Checks a deployment before it takes real traffic.
 *
 * Run it on the server after .env is filled in and the process is up:
 *   node scripts/preflight.js                    checks the local process
 *   node scripts/preflight.js https://api.quizpe.in   checks it through Nginx
 *
 * Every check here corresponds to something that fails SILENTLY in production —
 * a wrong value does not crash the server, it just quietly breaks a parent's
 * quiz link, or lets one visitor's rate limit block everyone. Exits non-zero if
 * anything is FAIL, so it can gate a deploy.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const db = require('../src/database/connectDB');

const BASE = (process.argv[2] || `http://localhost:${process.env.PORT || 5008}`).replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

let fails = 0, warns = 0;
const pass = (m, d) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}${d ? `  — ${d}` : ''}`);
const warn = (m, d) => { warns++; console.log(`  \x1b[33mWARN\x1b[0m  ${m}${d ? `  — ${d}` : ''}`); };
const fail = (m, d) => { fails++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${d ? `  — ${d}` : ''}`); };

async function get(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${BASE}${path}`, { ...opts, signal: ctrl.signal, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or plain text */ }
    return { res, text, json };
  } finally { clearTimeout(t); }
}

(async () => {
  console.log(`\nQuizPe preflight against ${BASE}\n`);

  /* ------------------------------------------------------------ environment */
  console.log('environment');
  IS_PROD ? pass('NODE_ENV=production') : warn('NODE_ENV is not production', process.env.NODE_ENV || 'unset');

  process.env.BEHIND_TLS === '1'
    ? pass('BEHIND_TLS=1', 'HSTS on, real client IP for rate limits')
    : (IS_PROD ? fail('BEHIND_TLS is not 1', 'every request will look like 127.0.0.1, so one visitor can rate-limit everyone')
               : warn('BEHIND_TLS is not 1', 'expected for local'));

  const secret = process.env.ADMIN_JWT_SECRET || '';
  secret.length >= 32 ? pass('ADMIN_JWT_SECRET set', `${secret.length} chars`)
                      : fail('ADMIN_JWT_SECRET too short or unset', 'admin tokens would be forgeable');

  (process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY)
    ? pass('Fast2SMS key present', `template ${process.env.FAST2SMS_DLT_MESSAGE_ID || '219444'}`)
    : fail('Fast2SMS key missing', 'nobody can sign into the admin panel');

  const base = process.env.PUBLIC_BASE_URL || '';
  /^https:\/\//.test(base) ? pass('PUBLIC_BASE_URL is https', base)
    : (IS_PROD ? fail('PUBLIC_BASE_URL is not https', base || 'unset') : warn('PUBLIC_BASE_URL not https', base || 'unset'));
  if (/localhost|ngrok/i.test(base)) fail('PUBLIC_BASE_URL still points at a dev host', base);

  for (const [k, host] of [['ADMIN_ORIGINS', 'admin.'], ['SITE_ORIGINS', '']]) {
    const v = process.env[k] || '';
    if (!v) fail(`${k} unset`, 'the browser will be refused');
    else if (IS_PROD && /localhost|127\.0\.0\.1/.test(v)) fail(`${k} still lists localhost`, v);
    else pass(`${k} set`, v);
  }

  if (/^rzp_test_/.test(process.env.RAZORPAY_KEY_ID || ''))
    warn('Razorpay is on TEST keys', 'no real payment can complete — trial-only launch');

  process.env.ADMIN_ALLOW_PIN === '1' ? fail('ADMIN_ALLOW_PIN=1', 'the PIN shortcut must never be on in production')
                                      : pass('PIN shortcut disabled');

  /* ---------------------------------------------------------------- schema */
  console.log('\ndatabase');
  try {
    await db.ping();
    pass('database reachable', process.env.DB_NAME);
    const cols = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='parents' AND column_name='service_paused'`);
    cols.rowCount ? pass('parents.service_paused exists') : fail('parents.service_paused missing', 'run: node scripts/migrate.js');
    const t = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name='admin_otps'`);
    t.rowCount ? pass('admin_otps exists') : fail('admin_otps missing', 'run: node scripts/migrate.js — you could not sign in');

    const q = await db.query('SELECT count(*)::int c FROM question_bank');
    q.rows[0].c > 0 ? pass('question bank populated', `${q.rows[0].c.toLocaleString('en-IN')} questions`)
                    : fail('question bank is EMPTY', 'no quiz can be built');

    const b = await db.query('SELECT count(*)::int c FROM business_details WHERE is_active');
    b.rows[0].c === 1 ? pass('business_details active row present')
                      : fail('business_details has no active row', 'invoices and policies render blank');

    const l = await db.query('SELECT count(*)::int c FROM legal_documents WHERE is_active');
    l.rows[0].c >= 10 ? pass('legal documents seeded', `${l.rows[0].c} documents`)
                      : warn('few legal documents', `${l.rows[0].c} — run scripts/seed-legal.js`);
  } catch (e) {
    fail('database check failed', e.message);
  }

  /* ------------------------------------------------------------- endpoints */
  console.log('\nendpoints');
  try {
    const h = await get('/health');
    h.res.ok ? pass('GET /health', String(h.res.status)) : fail('GET /health', String(h.res.status));

    const s = await get('/public/stats');
    s.res.ok && s.json?.success ? pass('GET /public/stats') : fail('GET /public/stats', String(s.res.status));

    const q = await get('/quiz.html');
    q.res.ok ? pass('GET /quiz.html', 'parents can open a quiz link') : fail('GET /quiz.html', String(q.res.status));

    // Admin API must be shut without a token.
    const a = await get('/admin/api/dashboard');
    a.res.status === 401 ? pass('admin API requires a token') : fail('admin API not protected', `expected 401, got ${a.res.status}`);

    // Security headers, which only appear once helmet is active.
    const csp = h.res.headers.get('content-security-policy');
    csp ? pass('Content-Security-Policy present') : fail('no CSP header', 'helmet is not active');

    const hsts = h.res.headers.get('strict-transport-security');
    if (IS_PROD) hsts ? pass('HSTS present', hsts) : fail('no HSTS header', 'set BEHIND_TLS=1');

    // A stranger's origin must be refused outright.
    const evil = await get('/admin/api/dashboard', { headers: { Origin: 'https://evil.example' } });
    evil.res.status === 403 ? pass('unknown origin refused (403)')
                            : warn('unknown origin not refused', `got ${evil.res.status}`);

    // The login limiter is the only thing standing in front of a 4-digit code.
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await get('/admin/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: '9000000000', code: '0000' }),
      });
      if (r.res.status === 429) limited = true;
    }
    limited ? pass('login rate limit active') : fail('login is NOT rate limited', 'a 4-digit code is brute-forceable');
  } catch (e) {
    fail('endpoint checks failed', e.message);
  }

  /* ---------------------------------------------------------------- verdict */
  console.log(`\n${fails ? '\x1b[31m' : '\x1b[32m'}${fails} fail, ${warns} warn\x1b[0m`);
  console.log(fails ? 'Do NOT take traffic until the failures above are fixed.\n'
                    : 'Ready. Send yourself an OTP and run one live quiz before announcing.\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('preflight crashed:', e.message); process.exit(1); });
