#!/usr/bin/env node
/**
 * scripts/test-tunnel.js
 * ---------------------------------------------------------------------------
 * Proves the encrypted admin channel cannot touch a parent's WhatsApp message.
 *
 *   node scripts/test-tunnel.js
 *
 * The tunnel is the one piece of the admin work with any power to break the
 * live product, and it can only do so one way: by being mounted where it does
 * not belong. So the first checks are about REACH, not cryptography —
 *
 *   1. src/app.js mounts it on '/admin/api' and nowhere else, and the
 *      webhook's path does not begin with that prefix. Express dispatches by
 *      prefix, so that is not a matter of being careful: the tunnel is never
 *      invoked for a parent's request at all. Checked against the source, so a
 *      future refactor that moves the mount fails here and not in production.
 *   2. With the tunnel switched FULLY on, a POST to the webhook's real path
 *      arrives byte-for-byte unchanged, through a server built as app.js
 *      builds one — while an admin call on the same server is refused.
 *
 * Then ordinary correctness: handshake, round trip, replay, staleness, device
 * binding, and that turning it on cannot break a panel that predates it.
 *
 * No database, no network beyond localhost, nothing sent to anyone.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');

const { tunnel } = require('../src/security/tunnel');

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m/\x1b[0m ${m}`);
const fail = (m) => { failures += 1; console.log(`  \x1b[31mX ${m}\x1b[0m`); };
const is = (c, m) => (c ? pass(m) : fail(m));

const WEBHOOK = '/serverpe/platform/quizpe/v1/public/users/whatsapp/webhook';

/* ── a server shaped exactly like src/app.js ──────────────────────────────── */
function build() {
  const app = express();
  app.use(express.json());

  let webhookSaw = null;
  const isFileRoute = (req) => /\/(file|download|pdf|invoice|export)/i.test(req.path);

  const admin = express.Router();
  admin.get('/ping', (req, res) => res.json({ success: true, where: 'admin', tunnelled: !!req.tunnelled }));
  admin.get('/reports/7/file', (req, res) => res.json({ success: true, file: true }));
  app.use('/admin/api', tunnel({ exempt: isFileRoute }), admin);

  // the webhook — not tunnelled, sharing no prefix with the admin surface
  app.post(WEBHOOK, (req, res) => { webhookSaw = req.body; res.json({ ok: true }); });

  return { app, seen: () => webhookSaw };
}

const listen = (app) => new Promise((resolve) => {
  const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv));
});

const post = (base, p, body, headers = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (base, p, headers = {}) => fetch(base + p, { headers });

/* ── a browser's half of the handshake ────────────────────────────────────── */
async function handshake(base, headers) {
  const me = crypto.createECDH('prime256v1');
  const pub = me.generateKeys();
  const r = await post(base, '/admin/api/_hs', { pub: pub.toString('base64') }, headers);
  const out = await r.json();
  const serverPub = Buffer.from(out.pub, 'base64');
  const shared = me.computeSecret(serverPub);
  const key = Buffer.from(crypto.hkdfSync(
    'sha256', shared, Buffer.concat([pub, serverPub]), Buffer.from('quizpe/tunnel/v1'), 32));
  return { key, token: out.k };
}

function sealFor(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

function openWith(key, text) {
  const raw = Buffer.from(text, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString());
}

async function main() {
  console.log('\n\x1b[1mEncrypted admin channel - reach and correctness\x1b[0m\n');

  console.log('1. src/app.js mounts it on the admin surface and nowhere else');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const mounts = [...src.matchAll(/app\.use\(\s*(?:'([^']+)'|"([^"]+)")?[^)]*tunnel/g)]
      .map((m) => m[1] || m[2] || '(ROOT)');
    is(mounts.length === 1, `mounted exactly once (found ${mounts.length})`);
    is(mounts[0] === '/admin/api', `mounted on ${mounts[0]}`);
    is(!mounts.includes('(ROOT)'), 'never mounted at the application root');
    // Express dispatches by prefix: if the webhook path does not start with the
    // mount point, the tunnel is never invoked for it. Structural, not careful.
    is(!WEBHOOK.startsWith(mounts[0]),
      `the webhook path does not begin with ${mounts[0]}, so the tunnel can never see it`);
  }

  console.log('\n2. With the tunnel fully ON, the webhook is untouched');
  process.env.ADMIN_TUNNEL = '1';
  process.env.ADMIN_TUNNEL_REQUIRE = '1';
  process.env.TUNNEL_SECRET = 'test-secret-for-the-tunnel-check-only';
  {
    const { app, seen } = build();
    const srv = await listen(app);
    const base = `http://127.0.0.1:${srv.address().port}`;

    const payload = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [] }] };
    const r = await post(base, WEBHOOK, payload);
    is(r.status === 200, 'the webhook still answers 200');
    is(JSON.stringify(seen()) === JSON.stringify(payload), 'it received the exact body that was sent');

    const plain = await get(base, '/admin/api/ping');
    is(plain.status === 426, `a plain admin call is refused (${plain.status}) while the webhook is not`);

    const file = await get(base, '/admin/api/reports/7/file');
    is(file.status === 200, 'file routes stay plain even when the tunnel is required');

    srv.close();
  }

  console.log('\n3. A sealed call reaches the right route and comes back sealed');
  {
    const { app } = build();
    const srv = await listen(app);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const headers = { 'x-qp-d': 'device-under-test', 'user-agent': 'test-runner' };

    const { key, token } = await handshake(base, headers);
    is(Boolean(key && token), 'handshake returns a key token');

    const env = { method: 'GET', path: '/ping', query: '', body: {}, time: Date.now(), nonce: 'n-1' };
    const r = await post(base, '/admin/api/_x', { k: token, d: sealFor(key, env) }, headers);
    const out = await r.json();
    is(Boolean(out.d), 'the answer is ciphertext, not JSON');

    const clear = openWith(key, out.d);
    is(clear.where === 'admin', 'it was routed to the real handler');
    is(clear.tunnelled === true, 'the handler saw req.tunnelled');

    const again = await post(base, '/admin/api/_x', { k: token, d: sealFor(key, env) }, headers);
    is(again.status === 400, `a replayed nonce is refused (${again.status})`);

    const old = { ...env, nonce: 'n-2', time: Date.now() - 10 * 60 * 1000 };
    const stale = await post(base, '/admin/api/_x', { k: token, d: sealFor(key, old) }, headers);
    is(stale.status === 400, `a stale request is refused (${stale.status})`);

    const wrong = await post(base, '/admin/api/_x', { k: token, d: sealFor(key, { ...env, nonce: 'n-3' }) },
      { 'x-qp-d': 'someone-elses-browser', 'user-agent': 'test-runner' });
    is(wrong.status === 401, `a key copied to another browser is refused (${wrong.status})`);

    srv.close();
  }

  console.log('\n4. ADMIN_TUNNEL=1 alone cannot break an older panel');
  process.env.ADMIN_TUNNEL_REQUIRE = '';
  {
    const { app } = build();
    const srv = await listen(app);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const r = await get(base, '/admin/api/ping');
    const body = await r.json();
    is(r.status === 200 && body.where === 'admin', 'a plain call still works');
    is(body.tunnelled === false, 'and is correctly marked as not tunnelled');
    srv.close();
  }

  console.log('\n5. With both switches off it does nothing at all');
  process.env.ADMIN_TUNNEL = '';
  {
    const { app } = build();
    const srv = await listen(app);
    const base = `http://127.0.0.1:${srv.address().port}`;
    is((await get(base, '/admin/api/ping')).status === 200, 'plain calls pass straight through');
    const hs = await post(base, '/admin/api/_hs', { pub: 'x' });
    is(hs.status === 404, `the handshake route does not even exist (${hs.status})`);
    srv.close();
  }

  console.log(
    failures
      ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
      : '\n\x1b[32mAll checks passed - the tunnel cannot reach the webhook.\x1b[0m\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\n', e); process.exit(1); });
