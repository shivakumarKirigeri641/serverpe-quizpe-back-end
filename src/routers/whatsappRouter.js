/**
 * src/routers/whatsappRouter.js
 * ---------------------------------------------------------------------------
 * WhatsApp Cloud API webhook.
 *
 *   GET  /whatsapp/webhook  -> verification handshake (Meta calls this once
 *                             when you set the callback URL). Echoes back
 *                             hub.challenge iff hub.verify_token matches
 *                             WHATSAPP_VERIFY_TOKEN from .env.
 *   POST /whatsapp/webhook  -> inbound events (messages, statuses). Must ACK
 *                             with 200 quickly; real processing happens async.
 * ---------------------------------------------------------------------------
 */

const express = require('express');

const router = express.Router();

// --- GET: verification handshake ---------------------------------------------
router.get('/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[whatsapp] webhook verified');
    return res.status(200).send(challenge);
  }
  console.warn('[whatsapp] webhook verification failed');
  return res.sendStatus(403);
});

// --- POST: inbound events ----------------------------------------------------
router.post('/whatsapp/webhook', (req, res) => {
  // ACK immediately so Meta does not retry; process the payload afterwards.
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (message) {
      const from = message.from;
      const type = message.type;
      const text = message.text?.body;
      console.log(`[whatsapp] inbound ${type} from ${from}${text ? `: ${text}` : ''}`);
      // TODO: route into quiz flow (answer capture, next question, etc.)
    } else if (change?.statuses) {
      console.log(`[whatsapp] status update: ${change.statuses[0]?.status}`);
    }
  } catch (e) {
    console.error('[whatsapp] failed to process webhook payload:', e.message);
  }
});

module.exports = router;
