/**
 * src/whatsapp/client.js
 * ---------------------------------------------------------------------------
 * Thin wrapper over the WhatsApp Cloud API + logging of every outbound message
 * into whatsapp_messages.
 *
 * WhatsApp limits worth remembering:
 *   - reply buttons : max 3
 *   - list rows     : max 10 (total, across all sections)
 *   - free-form text is only allowed inside the 24h customer-service window;
 *     outside it you MUST send an approved template.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const API = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}`;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Set DRY_RUN=1 to print messages to the console instead of calling Meta.
const DRY_RUN = process.env.WA_DRY_RUN === '1';

async function post(payload) {
  if (DRY_RUN) {
    console.log('\n\x1b[36m--- WhatsApp OUT ---\x1b[0m');
    console.log(JSON.stringify(payload, null, 2));
    return { messages: [{ id: 'wamid.DRYRUN' + Date.now() }] };
  }
  const res = await fetch(`${API}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `WhatsApp API ${res.status}`);
  return json;
}

/** Storage form: always the 10-digit local number, matching inbound + sessions. */
function toLocalNumber(mobile) {
  const d = String(mobile).replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

/** Log an outbound message and update the session's last_outbound_at. */
async function logOutbound({ sessionId, waMessageId, to, type, body, payload, error }) {
  to = toLocalNumber(to);
  await db.query(
    `INSERT INTO whatsapp_messages
       (session_id, wa_message_id, direction, mobile_number, message_type, body, payload, status, error_message, sent_at)
     VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [sessionId, waMessageId, to, type, body, payload, error ? 'failed' : 'sent', error || null],
  );
  if (sessionId) {
    await db.query(
      `UPDATE whatsapp_sessions SET last_outbound_at = now(), modified_at = now() WHERE id = $1`,
      [sessionId],
    );
  }
}

/**
 * Meta requires the full international number (no +). We store/lookup on the
 * 10-digit local form, so add the country code back at the send boundary.
 */
function toWaNumber(mobile) {
  const d = String(mobile).replace(/\D/g, '');
  return d.length === 10 ? `${process.env.WA_COUNTRY_CODE || '91'}${d}` : d;
}

async function send(sessionId, to, payload, bodyForLog, type) {
  to = toWaNumber(to);
  try {
    const res = await post({ messaging_product: 'whatsapp', to, ...payload });
    const id = res?.messages?.[0]?.id;
    await logOutbound({ sessionId, waMessageId: id, to, type, body: bodyForLog, payload });
    return id;
  } catch (e) {
    await logOutbound({ sessionId, waMessageId: null, to, type, body: bodyForLog, payload, error: e.message });
    throw e;
  }
}

// WhatsApp payload limits — exceeding any of these returns the unhelpful
// "(#131009) Parameter value is not valid", so check them here instead.
const LIMIT = { text: 4096, interactiveBody: 1024, header: 60, footer: 60, buttonTitle: 20, rowTitle: 24, rowDesc: 72 };

function checkLen(label, value, max) {
  if (value && [...String(value)].length > max) {
    throw new Error(`${label} is ${[...String(value)].length} chars, WhatsApp max is ${max}`);
  }
}

/** Plain text (only valid inside the 24h window). */
function sendText(sessionId, to, text) {
  checkLen('text body', text, LIMIT.text);
  return send(sessionId, to, { type: 'text', text: { body: text, preview_url: false } }, text, 'text');
}

/** Up to 3 reply buttons. `headerImageId` adds a WhatsApp image header. */
function sendButtons(sessionId, to, text, buttons, footer, headerImageId) {
  if (buttons.length > 3) throw new Error('WhatsApp allows max 3 reply buttons');
  checkLen('interactive body', text, LIMIT.interactiveBody);
  checkLen('footer', footer, LIMIT.footer);
  return send(sessionId, to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(headerImageId ? { header: { type: 'image', image: { id: headerImageId } } } : {}),
      body: { text },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  }, text, 'interactive');
}

/**
 * A single call-to-action button that opens `url`. WhatsApp shows only the
 * button label and opens the page in its in-app browser, so the parent never
 * sees a raw link — much tidier than pasting the URL into the message.
 */
function sendCtaUrl(sessionId, to, { body, url, displayText, header, footer }) {
  checkLen('interactive body', body, LIMIT.interactiveBody);
  checkLen('header', header, LIMIT.header);
  checkLen('footer', footer, LIMIT.footer);
  checkLen('button title', displayText, LIMIT.buttonTitle);
  return send(sessionId, to, {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(header ? { header: { type: 'text', text: header } } : {}),
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { name: 'cta_url', parameters: { display_text: displayText, url } },
    },
  }, body, 'interactive');
}

/** Send an image by uploaded media id (or link). */
function sendImage(sessionId, to, { filePath, link, caption }) {
  checkLen('caption', caption, LIMIT.text);
  const go = async () => {
    const image = filePath ? { id: await uploadMedia(filePath, 'image/png') } : { link };
    if (caption) image.caption = caption;
    return send(sessionId, to, { type: 'image', image }, `[image]${caption ? ` — ${caption}` : ''}`, 'image');
  };
  return go();
}

/**
 * Uploaded media ids stay valid ~30 days, so cache the logo's id in-process
 * and refresh well before expiry instead of re-uploading on every welcome.
 */
const _mediaCache = new Map();   // filePath -> { id, at }
async function cachedMediaId(filePath, mime = 'image/png', maxAgeDays = 20) {
  const hit = _mediaCache.get(filePath);
  if (hit && (Date.now() - hit.at) < maxAgeDays * 864e5) return hit.id;
  const id = await uploadMedia(filePath, mime);
  _mediaCache.set(filePath, { id, at: Date.now() });
  return id;
}

/** Up to 10 rows total. */
function sendList(sessionId, to, { header, text, footer, buttonText, rows }) {
  if (rows.length > 10) throw new Error('WhatsApp allows max 10 list rows');
  checkLen('interactive body', text, LIMIT.interactiveBody);
  checkLen('header', header, LIMIT.header);
  checkLen('footer', footer, LIMIT.footer);
  return send(sessionId, to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: header } } : {}),
      body: { text },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        button: buttonText.slice(0, 20),
        sections: [{
          rows: rows.map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        }],
      },
    },
  }, text, 'interactive');
}

const fs = require('fs');
const path = require('path');

/**
 * Upload a local file's bytes to WhatsApp and return its media_id. Sending by
 * media_id is far more reliable than by link — Meta never has to reach back to
 * our server, so it works behind ngrok / private hosts.
 */
async function uploadMedia(filePath, mimeType = 'application/pdf') {
  if (DRY_RUN) return 'media.DRYRUN' + Date.now();
  if (!fs.existsSync(filePath)) throw new Error(`media file not found: ${filePath}`);

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  const bytes = fs.readFileSync(filePath);
  form.append('file', new Blob([bytes], { type: mimeType }), path.basename(filePath));

  const res = await fetch(`${API}/${PHONE_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json.id) throw new Error(json?.error?.message || `media upload failed ${res.status}`);
  return json.id;
}

/**
 * Send a PDF (or any document).
 *   { filePath }  -> upload the bytes, send by media_id (preferred, reliable)
 *   { link }      -> send by public URL (Meta must be able to fetch it)
 */
async function sendDocument(sessionId, to, { filePath, link, filename, caption }) {
  checkLen('caption', caption, LIMIT.text);

  let media;
  if (filePath) {
    const id = await uploadMedia(filePath);
    media = { id, filename, ...(caption ? { caption } : {}) };
  } else {
    media = { link, filename, ...(caption ? { caption } : {}) };
  }
  return send(sessionId, to, { type: 'document', document: media },
    `[document] ${filename}${caption ? ` — ${caption}` : ''}`, 'document');
}

/**
 * Send a published WhatsApp Flow (a form). Static flows use action "navigate",
 * so no encrypted data_exchange endpoint is needed — the completed form comes
 * back as one inbound `nfm_reply` message.
 */
function sendFlow(sessionId, to, { flowId, flowToken, cta, body, header, footer, screen = 'SIGNUP', data }) {
  checkLen('interactive body', body, LIMIT.interactiveBody);
  checkLen('footer', footer, LIMIT.footer);
  return send(sessionId, to, {
    type: 'interactive',
    interactive: {
      type: 'flow',
      ...(header ? { header: { type: 'text', text: header } } : {}),
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: cta.slice(0, 20),
          flow_action: 'navigate',
          // `data` feeds the screen's declared data schema — this is what makes
          // a static flow able to show dynamic content without an endpoint.
          flow_action_payload: { screen, ...(data ? { data } : {}) },
        },
      },
    },
  }, body, 'flow');
}

/** Approved template — the ONLY thing allowed outside the 24h window. */
function sendTemplate(sessionId, to, name, params = [], lang) {
  return send(sessionId, to, {
    type: 'template',
    template: {
      name,
      language: { code: lang || process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
      ...(params.length
        ? { components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] }
        : {}),
    },
  }, `[template:${name}] ${params.join(' | ')}`, 'template');
}

module.exports = {
  sendText, sendButtons, sendList, sendTemplate, sendFlow, sendDocument, sendImage, sendCtaUrl,
  uploadMedia, cachedMediaId, toWaNumber, DRY_RUN,
};
