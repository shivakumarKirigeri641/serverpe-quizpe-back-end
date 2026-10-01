/**
 * src/security/tunnel.js
 * ---------------------------------------------------------------------------
 * The admin panel's API, encrypted end to end between the page and this server.
 *
 * WHAT THE NETWORK TAB SHOWS once this is on: a handshake (two public keys),
 * then only `POST /admin/api/_x` with ciphertext going in and ciphertext
 * coming back. No paths, no children's names, no mobile numbers, no JSON — the
 * real method, path, query and body travel inside the envelope.
 *
 * HOW:
 *   1. Handshake. The page makes a fresh P-256 key pair and sends its public
 *      half. The server makes its own; both derive the same secret (ECDH) and
 *      from it an AES-256-GCM key (HKDF). The key never crosses the wire.
 *   2. The server returns a KEY TOKEN: that AES key and its expiry, sealed
 *      with a key derived from ADMIN_JWT_SECRET. Only this server can open it,
 *      so the session key comes back on each request without holding state —
 *      it survives a restart, which matters on a box running pm2.
 *   3. Each request is { method, path, query, body, time, nonce } sealed with
 *      AES-GCM. Older than five minutes, or a nonce already seen, is refused,
 *      so a copied request cannot be replayed.
 *
 * ─── WHY THIS FILE IS PARANOID ABOUT WHERE IT IS MOUNTED ────────────────────
 *
 * This is the one piece of the admin work that could stop a parent's WhatsApp
 * message being processed, and only in one way: by being mounted somewhere it
 * does not belong. It goes on the admin surface ONLY:
 *
 *     app.use('/admin/api', tunnel(), adminRouter);      <- correct
 *     app.use(tunnel());                                 <- would break the webhook
 *
 * The webhook lives under /serverpe/platform/quizpe/v1/public/users, which
 * shares no prefix with /admin/api — Express dispatches by prefix, so a
 * correctly mounted tunnel cannot see it. scripts/test-tunnel.js asserts that
 * from the source, with a real request behind it.
 *
 * ─── TWO SWITCHES, BOTH OFF ─────────────────────────────────────────────────
 *
 *   ADMIN_TUNNEL=1          the handshake works and sealed requests are
 *                           accepted. PLAIN REQUESTS STILL WORK — so turning
 *                           this on cannot break a panel built before it.
 *   ADMIN_TUNNEL_REQUIRE=1  plain requests are now refused. Flip this only
 *                           once the deployed panel is known to be using it.
 *
 * With neither set this is a pass-through that does nothing at all.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

const KEY_TTL_MS = 30 * 60 * 1000;      // a key lifted from a browser dies in 30 min
const MAX_SKEW_MS = 5 * 60 * 1000;
const INFO = Buffer.from('quizpe/tunnel/v1');

const ON = () => process.env.ADMIN_TUNNEL === '1';
const REQUIRE = () => process.env.ADMIN_TUNNEL_REQUIRE === '1';

/* ── the server's own sealing key ─────────────────────────────────────────── */
let master = null;
function masterKey() {
  if (master) return master;
  const secret = process.env.TUNNEL_SECRET || process.env.ADMIN_JWT_SECRET || '';
  if (!secret) {
    console.warn('[tunnel] no TUNNEL_SECRET or ADMIN_JWT_SECRET - using a per-process key; sessions die on restart');
  }
  master = secret
    ? Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('quizpe/token-salt'), Buffer.from('token-key'), 32))
    : crypto.randomBytes(32);
  return master;
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return b64(Buffer.concat([iv, body, c.getAuthTag()]));
}

function open(key, text) {
  const raw = Buffer.from(String(text || ''), 'base64');
  if (raw.length < 29) throw new Error('short envelope');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

/** Seal the session key so it can come back to us on the next request. */
function issueToken(sessionKey, fingerprint) {
  return seal(masterKey(), {
    k: sessionKey.toString('base64'),
    fp: fingerprint,
    exp: Date.now() + KEY_TTL_MS,
  });
}

function readToken(token, fingerprint) {
  const t = open(masterKey(), token);
  if (!t || typeof t.k !== 'string') throw new Error('bad token');
  if (Date.now() > Number(t.exp)) throw new Error('expired');
  if (t.fp && fingerprint && t.fp !== fingerprint) throw new Error('wrong device');
  return Buffer.from(t.k, 'base64');
}

/* ── replay defence ───────────────────────────────────────────────────────── */
const seen = new Map();                 // nonce -> expiry
function usedBefore(nonce) {
  const now = Date.now();
  if (seen.size > 5000) {               // cheap sweep, bounded memory
    for (const [n, exp] of seen) if (exp < now) seen.delete(n);
  }
  if (seen.has(nonce)) return true;
  seen.set(nonce, now + MAX_SKEW_MS * 2);
  return false;
}

/** The browser identity a key is bound to — a key copied elsewhere is refused. */
const fingerprintOf = (req) =>
  crypto.createHash('sha256')
    .update(String(req.headers['x-qp-d'] || ''))
    .update('|')
    .update(String(req.headers['user-agent'] || ''))
    .digest('base64url')
    .slice(0, 22);

/**
 * Express middleware for ONE api surface. Mount it immediately before that
 * surface's router, never at the application root.
 *
 * @param exempt  paths that must stay plain — file downloads chiefly, because
 *                a PDF report is a file and not an envelope.
 */
function tunnel({ exempt = () => false } = {}) {
  return function tunnelMiddleware(req, res, next) {
    if (!ON()) return next();                       // inert

    /* 1. the handshake */
    if (req.path === '/_hs' && req.method === 'POST') {
      try {
        const clientPub = Buffer.from(String(req.body?.pub || ''), 'base64');
        const me = crypto.createECDH('prime256v1');
        const myPub = me.generateKeys();
        const shared = me.computeSecret(clientPub);
        const key = Buffer.from(crypto.hkdfSync(
          'sha256', shared, Buffer.concat([clientPub, myPub]), INFO, 32));
        return res.json({
          k: issueToken(key, fingerprintOf(req)),
          pub: b64(myPub),
          now: Date.now(),
          ttl: KEY_TTL_MS,
        });
      } catch (e) {
        console.warn('[tunnel] handshake failed:', e.message);
        return res.status(400).json({ success: false, error: 'Handshake failed.' });
      }
    }

    /* 2. a sealed call */
    if (req.path === '/_x' && req.method === 'POST') {
      let key;
      try {
        key = readToken(req.body?.k, fingerprintOf(req));
      } catch {
        return res.status(401).json({ success: false, error: 'Session key expired. Reload the panel.' });
      }

      let env;
      try { env = open(key, req.body?.d); }
      catch { return res.status(400).json({ success: false, error: 'Could not read the request.' }); }

      if (Math.abs(Date.now() - Number(env.time || 0)) > MAX_SKEW_MS) {
        return res.status(400).json({ success: false, error: 'Request too old.' });
      }
      if (!env.nonce || usedBefore(env.nonce)) {
        return res.status(400).json({ success: false, error: 'Request replayed.' });
      }

      // Rewrite so the router downstream sees the real call, and seal whatever
      // that router answers with.
      req.method = String(env.method || 'GET').toUpperCase();
      req.url = env.path + (env.query ? `?${env.query}` : '');
      req.body = env.body ?? {};
      req.tunnelled = true;

      const json = res.json.bind(res);
      res.json = (payload) => json({ d: seal(key, payload) });
      return next();
    }

    /* 3. a plain call */
    if (REQUIRE() && !exempt(req)) {
      return res.status(426).json({ success: false, error: 'This panel must use the encrypted channel.' });
    }
    return next();
  };
}

module.exports = { tunnel, seal, open, issueToken, readToken, ON, REQUIRE };
