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
const db = require('../database/connectDB');
const { handleInbound } = require('../whatsapp/flow');

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

  const change = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = change?.messages?.[0];

  if (message) {
    const contactName = change?.contacts?.[0]?.profile?.name;
    console.log(`[whatsapp] inbound ${message.type} from ${message.from}`);
    // Processed after the ACK; never let a failure bubble into the response.
    handleInbound(message, contactName).catch((e) => {
      console.error('[whatsapp] flow error:', e.message, e.stack?.split('\n')[1]?.trim());
    });
  } else if (change?.statuses) {
    const s = change.statuses[0];
    console.log(`[whatsapp] status ${s?.status} for ${s?.id}`);
    // Keep delivery state in sync (sent -> delivered -> read).
    updateStatus(s).catch((e) => console.error('[whatsapp] status update failed:', e.message));
  }
});

/** Reflect Meta's delivery receipts back onto the outbound message row. */
async function updateStatus(s) {
  if (!s?.id || !s?.status) return;
  const col = { delivered: 'delivered_at', read: 'read_at' }[s.status];
  await db.query(
    `UPDATE whatsapp_messages
        SET status = $2 ${col ? `, ${col} = now()` : ''},
            error_message = $3
      WHERE wa_message_id = $1`,
    [s.id, s.status, s.errors?.[0]?.title || null],
  );
}

module.exports = router;
