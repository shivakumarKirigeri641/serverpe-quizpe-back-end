/**
 * src/routers/supportWebRouter.js
 * ---------------------------------------------------------------------------
 * Backs public/support.html — a proper support form instead of "reply with
 * your question", so every query arrives categorised, attributable and with a
 * ticket number the parent can quote.
 *
 *   GET  /support/api/context?token=...  -> name, masked mobile, query types
 *   POST /support/api/submit             -> ticket + WhatsApp acknowledgement
 *
 * The parent's mobile is NEVER sent to the browser in full — only masked. The
 * real number comes from the token's row when the ticket is written, so a
 * tampered page cannot file a ticket against someone else's number.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database/connectDB');

const router = express.Router();
const TTL_HOURS = 24;

const QUERY_TYPES = [
  { code: 'quiz_issue',    label: '📚 Quiz or questions', hint: 'Wrong answer, too hard, not arriving' },
  { code: 'payment',       label: '💳 Payment or invoice', hint: 'Charged twice, invoice, refund' },
  { code: 'subscription',  label: '📄 Plan or subscription', hint: 'Upgrade, renew, cancel, add a child' },
  { code: 'report',        label: '📊 Reports', hint: "Can't open or download a report" },
  { code: 'technical',     label: '🛠️ Technical problem', hint: 'Link not working, page not loading' },
  { code: 'other',         label: '💬 Something else', hint: 'Anything not listed above' },
];

/** 9886122415 -> 98861*****15 — enough to recognise, not enough to leak. */
function maskMobile(m) {
  const d = String(m || '').replace(/\D/g, '');
  if (d.length < 6) return d;
  return `${d.slice(0, 5)}${'*'.repeat(Math.max(0, d.length - 7))}${d.slice(-2)}`;
}

async function createSupportLink(sessionId, mobile, parentId) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const existing = (await db.query(
    `SELECT token FROM support_links
      WHERE mobile_number = $1 AND expires_at > now() AND submitted_at IS NULL
      ORDER BY id DESC LIMIT 1`, [mobile])).rows[0];
  if (existing) return { token: existing.token, url: `${base}/support.html?token=${existing.token}` };

  const token = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO support_links (token, parent_id, whatsapp_session_id, mobile_number, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5||' hours')::interval)`,
    [token, parentId || null, sessionId || null, mobile, String(TTL_HOURS)]);
  return { token, url: `${base}/support.html?token=${token}` };
}

async function load(token) {
  const { rows } = await db.query(
    `SELECT sl.*, p.parent_name
       FROM support_links sl
       LEFT JOIN parents p ON p.id = sl.parent_id
      WHERE sl.token = $1 AND sl.expires_at > now()`, [token]);
  return rows[0] || null;
}

/* ----------------------------------------------------------------- context */
router.get('/api/context', async (req, res) => {
  try {
    const l = await load(req.query.token);
    if (!l) return res.status(410).json({ success: false, error: 'This support link has expired. Type *menu* on WhatsApp for a fresh one.' });
    const biz = (await db.query(
      `SELECT company_name, support_email, product_name FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};
    res.json({
      success: true,
      name: l.parent_name || '',
      mobileMasked: maskMobile(l.mobile_number),
      queryTypes: QUERY_TYPES,
      business: biz,
      submitted: !!l.submitted_at,
    });
  } catch (e) {
    console.error('[support] context failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
});

/* ------------------------------------------------------------------ submit */
router.post('/api/submit', async (req, res) => {
  try {
    const { token, queryType, message, name } = req.body || {};
    const l = await load(token);
    if (!l) return res.status(410).json({ success: false, error: 'This support link has expired.' });

    if (!QUERY_TYPES.some(q => q.code === queryType)) {
      return res.status(400).json({ success: false, error: 'Please choose what your query is about.' });
    }
    const text = String(message || '').trim();
    if (text.length < 10) {
      return res.status(400).json({ success: false, error: 'Please describe the issue in at least 10 characters.' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ success: false, error: 'Please keep it under 2000 characters.' });
    }

    // Ticket number: QP + YYYYMMDD + sequence, unique by construction.
    const { rows: [{ n }] } = await db.query(`SELECT nextval('support_ticket_seq')::bigint AS n`);
    const d = new Date();
    const ticketNo = `QP${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${n}`;

    // mobile comes from the token row, NEVER from the request body
    await db.query(
      `INSERT INTO support_tickets (ticket_no, parent_id, whatsapp_session_id, mobile_number,
                                    user_name, query_type, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ticketNo, l.parent_id, l.whatsapp_session_id, l.mobile_number,
       (name || l.parent_name || '').slice(0, 120) || null, queryType, text]);

    await db.query(`UPDATE support_links SET submitted_at = now() WHERE id = $1`, [l.id]);

    const label = QUERY_TYPES.find(q => q.code === queryType).label;
    try {
      const wa = require('../whatsapp/client');
      await wa.sendText(l.whatsapp_session_id, l.mobile_number,
`✅ *Support request received*

Ticket: *${ticketNo}*
About: ${label}

We reply here within 24–48 hours, during our support hours of 9 AM – 6 PM.
Please keep this ticket number handy.

_Type *menu* for other options._`);
    } catch (e) {
      console.error('[support] acknowledgement failed:', e.message);
    }

    const num = String(process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
    res.json({ success: true, ticketNo, whatsapp_url: num ? `https://wa.me/${num}` : null });
  } catch (e) {
    console.error('[support] submit failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not send your request. Please try again.' });
  }
});

module.exports = router;
module.exports.createSupportLink = createSupportLink;
module.exports.QUERY_TYPES = QUERY_TYPES;
module.exports.maskMobile = maskMobile;
