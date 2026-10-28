/**
 * src/admin/hqRoutes.js — the admin revamp's API (user, 2026-10-05), under
 * /admin/api/hq/… so it can never collide with an existing route. Every
 * route needs a signed-in admin; actions that send or change something need
 * the matching capability (logged, and enforced once ADMIN_CAPS_ENFORCE=1).
 *
 *   frame      /hq/status /hq/badges /hq/limit /hq/meta /hq/meta-news(/:id/seen)
 *   home       /hq/home
 *   graphs     /hq/graphs/:page   /hq/drill/:kind/:day
 *   families   /hq/hot-leads /hq/journey/:parentId /hq/quizzes-per-child /hq/stopped
 *   broadcast  /hq/plans (GET, POST) /hq/plans/:id/:action
 *   money      /hq/pnl  (GET, PUT assumptions)
 *   ops        /hq/alerts /hq/alerts/:id/resolve /hq/push/key /hq/push/subscribe /hq/push/test
 */

const express = require('express');
const { requireAdmin } = require('./auth');
const { requireCap } = require('./capabilities');
const { audit } = require('./audit');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const hq = (name) => require(`./hq/${name}`);
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error('[hq] %s %s: %s', req.method, req.path, e.message);
    fail(res, e.status || 500, e.status ? e.message : 'Something went wrong.');
  }
};

/* ── the frame ── */
router.get('/hq/status', requireAdmin, wrap(async (_req, res) => ok(res, { rows: await hq('shared').status() })));
router.get('/hq/badges', requireAdmin, wrap(async (_req, res) => ok(res, await hq('shared').badges())));
router.get('/hq/limit', requireAdmin, wrap(async (_req, res) => ok(res, await hq('shared').waLimit())));
router.get('/hq/meta', requireAdmin, wrap(async (req, res) => ok(res, await hq('shared').metaStatus({ fresh: req.query.fresh === '1' }))));
router.get('/hq/meta-news', requireAdmin, wrap(async (_req, res) => ok(res, { rows: await hq('shared').metaNews() })));
router.post('/hq/meta-news/:id/seen', requireAdmin, wrap(async (req, res) =>
  ok(res, await hq('shared').metaSeen(req.params.id, req.admin?.sub))));

/* ── home and graphs ── */
router.get('/hq/home', requireAdmin, requireCap('dashboard.view'), wrap(async (_req, res) => ok(res, await hq('insights').home())));

/* ── the website: quizpe.in/app (hq/web.js, 2026-10-10 — WhatsApp is gone) ── */
router.get('/hq/web/overview', requireAdmin, requireCap('dashboard.view'), wrap(async (_req, res) => ok(res, await hq('web').overview())));
router.get('/hq/web/sign-ins', requireAdmin, requireCap('parents.view'), wrap(async (req, res) =>
  ok(res, await hq('web').signIns({ days: req.query.days, q: req.query.q }))));
router.get('/hq/web/families', requireAdmin, requireCap('parents.view'), wrap(async (req, res) =>
  ok(res, await hq('web').families({ q: req.query.q, filter: req.query.filter }))));
/* The event log and who is here now (hq/events.js, 2026-10-21) — from the tables that already record it. */
router.get('/hq/events', requireAdmin, requireCap('dashboard.view'), wrap(async (req, res) =>
  ok(res, await hq('events').log({ hours: req.query.hours, kind: req.query.kind, q: req.query.q, visits: req.query.visits === '1' }))));
router.get('/hq/live-now', requireAdmin, requireCap('dashboard.view'), wrap(async (_req, res) => ok(res, await hq('events').live())));
/* Broadcast email (2026-10-21, web/email.js): to confirmed, subscribed families who agreed; a test to you first. */
router.get('/hq/email', requireAdmin, requireCap('dashboard.view'), wrap(async (_req, res) =>
  ok(res, { ...(await require('../web/email').audienceCounts()), campaigns: await require('../web/email').campaigns() })));
router.post('/hq/email', requireAdmin, requireCap('whatsapp.send'), express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.test && String(b.confirm || '') !== 'SEND') return fail(res, 400, 'Type SEND to confirm.');
  const out = await require('../web/email').queueCampaign({ adminMobile: req.admin?.sub, category: b.category, audience: b.audience,
    subject: b.subject, body: b.body, test: Boolean(b.test) });
  if (!out.ok) return fail(res, 400, out.error);
  if (!out.test) console.log('[hq] email broadcast %s queued %d by %s', out.campaign_id, out.queued, req.admin?.sub || '?');
  ok(res, { ...out, message: out.test ? `Test sent to ${out.sent_to}` : `${out.queued} emails queued — they go out a few a minute` });
}));
/* The comeback offer (2026-10-10): how many it is for, and the switch — off until the SMS is approved. */
router.get('/hq/web/comeback', requireAdmin, requireCap('dashboard.view'), wrap(async (_req, res) =>
  ok(res, await require('../web/comeback').stats())));
router.put('/hq/web/comeback', requireAdmin, requireCap('settings.view'),
  audit('comeback.offer', (req) => ({ targetType: 'settings', targetId: 'comeback_trial',
    summary: `comeback trial ${req.body?.on ? 'on' : 'off'}${req.body?.days ? `, ${req.body.days} days` : ''}` })),
  express.json(), wrap(async (req, res) =>
    ok(res, { ...(await require('../web/comeback').set({ on: req.body?.on, days: req.body?.days })), message: 'Saved' })));
router.get('/hq/graphs/:page', requireAdmin, requireCap('analytics.view'), wrap(async (req, res) => {
  const out = await hq('insights').page(req.params.page, req.query.days);
  if (!out) return fail(res, 404, 'No such graph page.');
  ok(res, out);
}));
router.get('/hq/drill/:kind/:day', requireAdmin, requireCap('analytics.view'), wrap(async (req, res) => {
  const rows = await hq('insights').drill(req.params.kind, req.params.day);
  if (!rows) return fail(res, 400, 'Nothing to show for that.');
  ok(res, { rows });
}));

/* ── families ── */
router.get('/hq/hot-leads', requireAdmin, requireCap('parents.view'), wrap(async (_req, res) => ok(res, await hq('families').hotLeads())));
router.get('/hq/journey/:parentId', requireAdmin, requireCap('parents.view'), wrap(async (req, res) => {
  const out = await hq('families').journey(String(req.params.parentId).replace(/\D/g, '') || '0');
  if (!out) return fail(res, 404, 'No such family.');
  ok(res, out);
}));
router.get('/hq/quizzes-per-child', requireAdmin, requireCap('parents.view'), wrap(async (req, res) =>
  ok(res, await hq('families').quizzesPerChild({ days: req.query.days, minMissed: req.query.missed }))));

/* ── pay as you answer (2026-10-28): a family's MCQ balance, where it went, and a support top-up ── */
router.get('/hq/mcq/:parentId', requireAdmin, requireCap('parents.view'), wrap(async (req, res) => {
  const id = String(req.params.parentId).replace(/\D/g, '') || '0';
  const W = require('../prepaid/wallet');
  const db = require('../database/connectDB');
  const lots = (await db.query(
    `SELECT id, source, mcqs, used, mcqs - used AS left, expires_at, rupees, note, created_at
       FROM mcq_lots WHERE parent_id = $1 ORDER BY created_at DESC LIMIT 50`, [id])).rows;
  const usage = (await db.query(
    `SELECT u.used_on, st.student_name, u.source, count(*)::int AS mcqs
       FROM mcq_usage u JOIN students st ON st.id = u.student_id
      WHERE u.parent_id = $1 GROUP BY 1, 2, 3 ORDER BY 1 DESC LIMIT 60`, [id])).rows;
  ok(res, { balance: await W.balance(id), free_eligible: await W.freeEligible(id), lots, usage });
}));
router.post('/hq/mcq/:parentId/topup', requireAdmin, requireCap('settings.view'), express.json(),
  audit('mcq.topup', (req) => ({ targetType: 'parent', targetId: String(req.params.parentId),
    summary: `+${Number(req.body?.mcqs) || 0} MCQs: ${String(req.body?.note || '').slice(0, 120)}` })),
  wrap(async (req, res) => {
    const id = String(req.params.parentId).replace(/\D/g, '') || '0';
    const mcqs = Math.floor(Number(req.body?.mcqs));
    const note = String(req.body?.note || '').trim().slice(0, 200);
    if (!(mcqs >= 1 && mcqs <= 2000)) return fail(res, 400, 'MCQs must be between 1 and 2000.');
    if (note.length < 3) return fail(res, 400, 'Please give a reason (it is kept in the audit log).');
    const db = require('../database/connectDB');
    if (!(await db.query(`SELECT 1 FROM parents WHERE id = $1`, [id])).rowCount) return fail(res, 404, 'No such family.');
    const W = require('../prepaid/wallet');
    const lot = await W.addLot(db, { parentId: id, source: 'admin', mcqs, note: `${note} — by ${req.admin?.sub || 'admin'}` });
    ok(res, { lot, balance: await W.balance(id), message: `${mcqs} MCQs added (valid till 31 Mar).` });
  }));

/* ── broadcast in batches ── */
router.get('/hq/plans', requireAdmin, requireCap('whatsapp.view'), wrap(async (_req, res) => ok(res, await hq('plans').list())));
router.post('/hq/plans', requireAdmin, requireCap('whatsapp.send'),
  audit('broadcast.plan', (req) => ({ targetType: 'template', targetId: req.body?.template, summary: `batches of ${req.body?.batch_size} to ${(req.body?.mobiles || []).length}` })),
  express.json(), wrap(async (req, res) => {
    if (req.body?.confirm !== 'SEND') return fail(res, 400, 'Type SEND to confirm.');
    const out = await hq('plans').create(req.body || {}, req.admin?.sub);
    if (!out.ok) return fail(res, 400, out.error);
    ok(res, { ...out, message: `Started — ${out.people} families in ${out.batches} batch(es).` });
  }));
// Express 5 path syntax: no inline regex — plans.act() accepts only pause / resume / cancel.
router.post('/hq/plans/:id/:action', requireAdmin, requireCap('whatsapp.send'),
  audit('broadcast.plan_action', (req) => ({ targetType: 'plan', targetId: req.params.id, summary: req.params.action })),
  wrap(async (req, res) => {
    const out = await hq('plans').act(String(req.params.id).replace(/\D/g, '') || '0', req.params.action);
    if (!out.ok) return fail(res, 400, out.error);
    ok(res, { message: { pause: 'Paused', resume: 'Resumed', cancel: 'Cancelled' }[req.params.action] });
  }));

/* ── profit & loss ── */
router.get('/hq/pnl', requireAdmin, requireCap('finance.view'), wrap(async (req, res) => ok(res, await hq('pnl').statement(req.query.days))));
router.put('/hq/pnl', requireAdmin, requireCap('settings.view'),
  audit('pnl.assumptions', () => ({ targetType: 'settings', targetId: 'pnl', summary: 'ads / fixed costs' })),
  express.json(), wrap(async (req, res) => ok(res, { ...(await hq('pnl').saveAssumptions(req.body || {})), message: 'Saved' })));

/* ── operations ── */
router.get('/hq/alerts', requireAdmin, wrap(async (req, res) => ok(res, { rows: await hq('alerts').list({ status: req.query.status === 'all' ? 'all' : 'open' }) })));
router.post('/hq/alerts/:id/resolve', requireAdmin, express.json(), wrap(async (req, res) =>
  ok(res, { ...(await hq('alerts').resolve(String(req.params.id).replace(/\D/g, '') || '0', req.body?.note)), message: 'Resolved' })));
router.get('/hq/push/key', requireAdmin, wrap(async (_req, res) =>
  ok(res, { key: await hq('push').publicKey(), available: hq('push').available(), devices: await hq('push').count() })));
router.post('/hq/push/subscribe', requireAdmin, express.json(), wrap(async (req, res) =>
  ok(res, { ...(await hq('push').subscribe(req.body?.subscription, req.admin?.sub)), message: 'This device will get alerts' })));
router.post('/hq/push/unsubscribe', requireAdmin, express.json(), wrap(async (req, res) =>
  ok(res, { ...(await hq('push').unsubscribe(req.body?.endpoint)), message: 'Turned off on this device' })));
router.post('/hq/push/test', requireAdmin, wrap(async (_req, res) =>
  ok(res, { ...(await hq('push').send({ title: 'QuizPe admin', body: 'Phone alerts are working ✅', url: '/' })), message: 'Test sent' })));

module.exports = router;
