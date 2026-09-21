/**
 * scripts/test-broadcast-send.js — the broadcaster sends one at a time and
 * stops when it should. Nothing is sent: the WhatsApp client and the database
 * are both replaced with stand-ins, and the real route handler is driven with
 * fake requests.
 *
 *   node scripts/test-broadcast-send.js
 */

const path = require('path');

/* ── stand-ins, installed before the router is loaded ──────────────────── */

let script = [];          // what each successive send should do
let calls = [];           // { start, end } per send, to prove no overlap
const inserts = [];

const waPath = require.resolve(path.join(__dirname, '../src/whatsapp/client'));
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    sendTemplate: async () => {
      const call = { start: Date.now() };
      calls.push(call);
      await new Promise((r) => setTimeout(r, 30));   // a send takes time
      call.end = Date.now();
      const step = script.shift() || { id: 'wamid.ok' };
      if (step.code) { const e = new Error(step.msg || 'fail'); e.code = step.code; throw e; }
      return step.id;                                 // may be undefined: "no id"
    },
  },
};

const dbPath = require.resolve(path.join(__dirname, '../src/database/connectDB'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params = []) => {
      if (/FROM whatsapp_templates/.test(sql)) return { rows: [{ variables: ['parent_name', 'headline', 'details'] }] };
      if (/FROM parents p WHERE p\.parent_mobile_number = ANY/.test(sql)) {
        return { rows: params[0].map((m) => ({ mobile: m, name: 'Parent', service_paused: false, session_id: 1 })) };
      }
      if (/INSERT INTO marketing_broadcasts/.test(sql)) {
        inserts.push({ status: /'sent'/.test(sql) ? 'sent' : 'failed', mobile: params[0], detail: params[3] });
      }
      return { rows: [] };
    },
  },
};

const authPath = require.resolve(path.join(__dirname, '../src/admin/auth'));
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { requireAdmin: (req, res, next) => next() },
};

const router = require('../src/admin/broadcastRoutes');

/* The last function in the route's stack is the handler; the ones before it
   are requireAdmin and express.json(), which a direct call does not need. */
function handler(p) {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods.post);
  const s = layer.route.stack;
  return s[s.length - 1].handle;
}

async function direct(n, steps) {
  script = steps.slice(); calls = []; inserts.length = 0;
  const mobiles = Array.from({ length: n }, (_, i) => String(9000000000 + i)).join(',');
  let body;
  await handler('/broadcast/direct')(
    { body: { template: 'qp_announcement_v1', params: ['Headline', 'Details'], mobiles } },
    { json: (b) => { body = b; }, status() { return this; } });
  return body;
}

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

(async () => {
  console.log('\nBroadcast — one at a time, stop when it should\n');

  let r = await direct(5, []);
  check(r.sent === 5 && r.failed === 0 && !r.stopped, `all accepted -> 5 sent (${r.sent}/${r.failed})`);
  const overlap = calls.some((c, i) => i > 0 && c.start < calls[i - 1].end);
  check(!overlap, 'each send began only after the previous one finished');

  r = await direct(5, [{ id: 'a' }, { id: undefined }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
  check(r.sent === 4 && r.failed === 1,
    `a send with no message id counts as FAILED, not sent (${r.sent} sent, ${r.failed} failed)`);
  check(inserts.find((x) => x.status === 'failed')?.detail?.includes('no message id'),
    'and it is recorded as "not confirmed"');

  r = await direct(5, [{ id: 'a' }, { code: 131026, msg: 'undeliverable' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
  check(r.sent === 4 && r.failed === 1 && !r.stopped,
    'one number not on WhatsApp fails alone — the run carries on');

  r = await direct(5, [{ id: 'a' }, { code: 190, msg: 'token expired' }]);
  check(r.stopped && /token/.test(r.stopped), `an expired token STOPS the run: "${r.stopped}"`);
  check(r.sent === 1 && r.failed === 1 && r.not_attempted === 3,
    `nobody after it is attempted (${r.sent} sent, ${r.failed} failed, ${r.not_attempted} not attempted)`);
  check(inserts.length === 2, 'and no row is written for the unattempted, so a retry is not blocked by the cooldown');
  check(r.remaining.length === 3 && r.remaining[0] === '9000000002',
    `the exact untried numbers come back for a resend (${r.remaining.join(', ')})`);

  const five = Array.from({ length: 5 }, () => ({ code: 131026, msg: 'undeliverable' }));
  r = await direct(8, five);
  check(r.stopped && /in a row/.test(r.stopped) && r.failed === 5 && r.not_attempted === 3,
    `5 failures in a row stop the run even without a known code (${r.failed} failed, ${r.not_attempted} left)`);

  r = await direct(3, [{ code: 132001, msg: 'template missing' }]);
  check(r.stopped && /Template/.test(r.stopped) && r.sent === 0,
    'a template problem stops on the first failure');

  console.log(fails ? `\n  ${fails} FAILURE(S)\n` : '\n  all checks passed\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('\n  ERROR', e.stack || e.message, '\n'); process.exit(1); });
