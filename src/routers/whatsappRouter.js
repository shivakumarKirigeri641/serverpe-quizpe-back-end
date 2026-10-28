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
const { checkSignature } = require('../utils/metaSignature');

const router = express.Router();

/* Webhook authenticity.
 *
 * The callback URL is discoverable (it is returned by Meta's own phone-number
 * API), and nothing else proves a POST came from Meta — WHATSAPP_VERIFY_TOKEN
 * only guards the one-time GET handshake. Unverified, anyone who knows the URL
 * could forge a "hi" from any number and start quizzes for children who never
 * asked.
 *
 * Deliberately WARN-ONLY by default: a wrong App Secret would otherwise drop
 * every real parent message silently. Watch the logs until only "ok" appears,
 * then set WHATSAPP_SIGNATURE_ENFORCE=true. */
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const ENFORCE_SIGNATURE = process.env.WHATSAPP_SIGNATURE_ENFORCE === 'true';
let warnedNoSecret = false;

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
  // The 200 goes out before the signature check on purpose — a rejected event
  // should be dropped silently, not retried by Meta for hours.
  res.sendStatus(200);

  const sig = checkSignature(req.rawBody, req.headers['x-hub-signature-256'], APP_SECRET);
  if (sig === 'unset') {
    if (!warnedNoSecret) {
      console.warn('[whatsapp] WHATSAPP_APP_SECRET not set — inbound webhook signatures are NOT verified');
      warnedNoSecret = true;      // once per process, not once per message
    }
  } else if (sig !== 'ok') {
    console.warn(`[whatsapp] webhook signature ${sig} — `
      + `${ENFORCE_SIGNATURE ? 'REJECTING' : 'log-only, processing anyway'} `
      + '(not from Meta, or wrong App Secret)');
    if (ENFORCE_SIGNATURE) return;
  }

  /* META'S ACCOUNT NEWS (2026-10-28, as GaadiPe): restricted / banned, quality, the limit, the display name review,
     template reviews. Each is kept as an admin alert (push + email); a strike is its own alert every time. */
  for (const entry of req.body?.entry || []) {
    for (const ch of entry.changes || []) {
      if (ACCOUNT_FIELDS[ch.field]) accountNews(entry.id, ch.field, ch.value || {}).catch((e) => console.error('[whatsapp] account news:', e.message));
    }
  }

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
const ACCOUNT_FIELDS = {
  account_update: 'Account update',
  account_alerts: 'Account alert',
  account_review_update: 'Account review',
  business_capability_update: 'Business capability update',
  business_status_update: 'Business status',
  phone_number_quality_update: 'Phone number quality / limit',
  phone_number_name_update: 'Display name review',
  message_template_status_update: 'Template review',
  message_template_quality_update: 'Template quality',
  template_category_update: 'Template category change',
  security: 'Security change',
};

/** One account-level webhook, in plain words, as an admin alert (hq_alerts: push + email unless routine). */
async function accountNews(wabaId, field, value) {
  console.log('[whatsapp] meta %s: %s', field, JSON.stringify(value).slice(0, 300));
  const event = value.event || value.decision || value.current_limit || value.alert_type || '';
  const json = JSON.stringify(value);
  const strike = /VIOLATION|DISABLED|BANNED|RESTRICT/i.test(json);
  const bad = /FAILED|REJECT|DEFERRED|NEED_MORE_INFO|FLAGGED|DOWNGRADE|RED\b|PAUSED/i.test(json);
  const routine = field === 'message_template_status_update' && value.event === 'APPROVED';
  const bits = [
    strike && '⛔ Account strike: stop broadcasts and ads, check Business Support Home now.',
    event && `Event: ${event}`,
    value.max_daily_conversations_per_business && `Limit: ${value.max_daily_conversations_per_business}`,
    value.display_phone_number && `Number: ${value.display_phone_number}`,
    value.requested_verified_name && `Name: ${value.requested_verified_name}`,
    value.message_template_name && `Template: ${value.message_template_name}`,
    value.reason && `Reason: ${value.reason}`,
    value.rejection_reason && value.rejection_reason !== 'NONE' && `Reason: ${value.rejection_reason}`,
    value.alert_description,
  ].filter(Boolean);
  await require('../admin/hq/alerts').raise({
    // Every piece of news is its own alert: a second strike must never be swallowed as a repeat of the first.
    key: `meta:${field}:${event || 'x'}:${Date.now()}`,
    severity: strike ? 'critical' : bad ? 'warning' : 'info',
    title: `Meta: ${ACCOUNT_FIELDS[field]}${routine ? ' (approved)' : ''}`,
    description: bits.length ? bits.join('\n') : json.slice(0, 400),
  });
}

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
