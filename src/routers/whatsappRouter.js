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

// Our own WhatsApp number. Meta may deliver a webhook for any number under the
// same App/WABA (e.g. the sibling ChallanAlerts number). We only act on events
// addressed to OUR number, otherwise two products reply to one "hi".
const OWN_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

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
  if (!change) return;

  // Only handle events addressed to OUR number. If the sibling ChallanAlerts
  // number shares this Meta App, its events are dropped here so QuizPe never
  // replies on their behalf. Skipped only if our own id is unset (mis-config).
  const targetId = change.metadata?.phone_number_id;
  if (!OWN_PHONE_NUMBER_ID) {
    console.warn('[whatsapp] WHATSAPP_PHONE_NUMBER_ID not set — cannot verify webhook target; processing anyway');
  } else if (targetId && targetId !== OWN_PHONE_NUMBER_ID) {
    console.log(`[whatsapp] ignoring webhook for phone_number_id=${targetId} (not ours=${OWN_PHONE_NUMBER_ID})`);
    return;
  }

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
