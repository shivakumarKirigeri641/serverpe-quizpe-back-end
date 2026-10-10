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
router.get('/hq/stopped', requireAdmin, requireCap('parents.view'), wrap(async (_req, res) => ok(res, await hq('families').stopped())));

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
