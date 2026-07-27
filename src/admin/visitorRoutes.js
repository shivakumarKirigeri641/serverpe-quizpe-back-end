/**
 * src/admin/visitorRoutes.js
 * ---------------------------------------------------------------------------
 * Admin-only views over first-party site traffic:
 *
 *   GET   /visitors            full analytics (windowed from the launch date)
 *   GET   /visitors/recent     recent individual visits, for the Inbox feed
 *   GET   /visitors/settings   { inbox_on }
 *   PATCH /visitors/settings   { inbox_on: bool }  toggle the Inbox feed
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const { requireAdmin } = require('./auth');
const visits = require('../tracking/visits');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

router.get('/visitors', requireAdmin, async (req, res) => {
  try { ok(res, { analytics: await visits.analytics() }); }
  catch (e) { console.error('[admin] visitors:', e.message); fail(res, 500, 'Could not load visitor analytics.'); }
});

router.get('/visitors/recent', requireAdmin, async (req, res) => {
  try {
    const [rows, inbox_on] = await Promise.all([visits.recent(req.query.limit), visits.inboxOn()]);
    ok(res, { rows, inbox_on });
  } catch (e) { console.error('[admin] visitors/recent:', e.message); fail(res, 500, 'Could not load visits.'); }
});

router.get('/visitors/settings', requireAdmin, async (req, res) => {
  try { ok(res, { inbox_on: await visits.inboxOn() }); }
  catch (e) { console.error('[admin] visitors/settings:', e.message); fail(res, 500, 'Could not load setting.'); }
});

router.patch('/visitors/settings', requireAdmin, express.json(), async (req, res) => {
  if (typeof req.body?.inbox_on !== 'boolean') return fail(res, 400, 'inbox_on must be true or false.');
  try { ok(res, { inbox_on: await visits.setInboxOn(req.body.inbox_on) }); }
  catch (e) { console.error('[admin] visitors/settings set:', e.message); fail(res, 500, 'Could not save setting.'); }
});

module.exports = router;
