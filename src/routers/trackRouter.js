/**
 * src/routers/trackRouter.js
 * ---------------------------------------------------------------------------
 * Public, unauthenticated tracking beacons for the marketing site.
 *
 *   POST /public/track/view   a landing-page view
 *   POST /public/track/wa     a "Start on WhatsApp" button click
 *
 * These are fire-and-forget from the browser: they always answer 204 quickly
 * and never block or error the visitor, whatever happens server-side. No
 * personal data is required from the client — the server derives IP/geo/UA.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const visits = require('../tracking/visits');

const router = express.Router();

// small JSON body only; a beacon should never carry a payload worth parsing big
const json = express.json({ limit: '4kb' });

function beacon(kind) {
  return async (req, res) => {
    // answer immediately — the visitor must never wait on our bookkeeping
    res.status(204).end();
    try {
      await visits.record(req, {
        kind,
        path: req.body?.path,
        referrer: req.body?.ref || req.get('referer'),
        sid: req.body?.sid,
      });
    } catch (e) {
      console.error(`[track] ${kind} failed:`, e.message);
    }
  };
}

router.post('/track/view', json, beacon('view'));
router.post('/track/wa', json, beacon('wa_click'));

module.exports = router;
