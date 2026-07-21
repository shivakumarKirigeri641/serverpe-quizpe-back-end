/**
 * src/admin/whatsappRoutes.js
 * ---------------------------------------------------------------------------
 * Read-only access to WhatsApp conversation data for the admin panel.
 *
 *   GET /admin/api/whatsapp/sessions            one row per mobile number
 *   GET /admin/api/whatsapp/sessions/:id        full thread + state history
 *   GET /admin/api/whatsapp/messages/:id/raw    the exact webhook payload
 *
 * DELIBERATELY READ-ONLY. These rows are the evidential record of what was
 * actually said to a parent and when — including the consent messages. If a
 * parent ever disputes a charge, a message or a consent, this is the proof.
 * Allowing edits would destroy that value, so there is no write path here at
 * all, not even a soft delete.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const { requireAdmin } = require('./auth');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const clamp = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);

const TZ = 'Asia/Kolkata';
const IST = (col) => `to_char(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI:SS')`;

/* --------------------------------------------------------------- sessions */
router.get('/whatsapp/sessions', requireAdmin, async (req, res) => {
  const limit = clamp(req.query.limit, 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = `%${String(req.query.q || '').trim()}%`;

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.mobile_number, s.state, s.is_active, s.context,
              ${IST('s.created_at')}     AS started_ist,
              ${IST('s.last_inbound_at')} AS last_inbound_ist,
              s.last_inbound_at,
              p.id AS parent_id, p.parent_name,
              (SELECT COUNT(*)::int FROM whatsapp_messages m WHERE m.session_id = s.id) AS messages,
              (SELECT COUNT(*)::int FROM whatsapp_messages m
                WHERE m.session_id = s.id AND m.direction = 'inbound')                  AS inbound,
              (SELECT COUNT(*)::int FROM whatsapp_messages m
                WHERE m.session_id = s.id AND m.direction = 'outbound')                 AS outbound,
              (SELECT COUNT(*)::int FROM whatsapp_messages m
                WHERE m.session_id = s.id AND m.status = 'failed')                      AS failed,
              (SELECT COUNT(*)::int FROM whatsapp_session_events e
                WHERE e.session_id = s.id)                                              AS events,
              (SELECT LEFT(COALESCE(m.body, m.message_type), 90) FROM whatsapp_messages m
                WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1)                   AS last_message,
              COUNT(*) OVER()::int AS total
         FROM whatsapp_sessions s
         LEFT JOIN parents p ON p.parent_mobile_number = s.mobile_number
        WHERE ($1 = '%%' OR s.mobile_number ILIKE $1 OR p.parent_name ILIKE $1)
        ORDER BY s.last_inbound_at DESC NULLS LAST, s.id DESC
        LIMIT $2 OFFSET $3`, [q, limit, offset]);
    ok(res, { rows, total: rows[0]?.total || 0 });
  } catch (e) {
    console.error('[admin] wa sessions:', e.message);
    fail(res, 500, 'Could not load conversations.');
  }
});

/** One conversation: every message, plus how the state machine moved. */
router.get('/whatsapp/sessions/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad session id.');

  try {
    const session = (await db.query(
      `SELECT s.*, ${IST('s.created_at')} AS started_ist, p.id AS parent_id, p.parent_name
         FROM whatsapp_sessions s
         LEFT JOIN parents p ON p.parent_mobile_number = s.mobile_number
        WHERE s.id = $1`, [id])).rows[0];
    if (!session) return fail(res, 404, 'Conversation not found.');

    const [messages, events] = await Promise.all([
      db.query(
        `SELECT id, wa_message_id, direction, message_type, body, status,
                error_message, ${IST('created_at')} AS at_ist, created_at,
                ${IST('delivered_at')} AS delivered_ist, ${IST('read_at')} AS read_ist
           FROM whatsapp_messages WHERE session_id = $1 ORDER BY id`, [id]),
      db.query(
        `SELECT id, from_state, to_state, event, payload, ${IST('created_at')} AS at_ist
           FROM whatsapp_session_events WHERE session_id = $1 ORDER BY id`, [id]),
    ]);

    ok(res, { session, messages: messages.rows, events: events.rows });
  } catch (e) {
    console.error('[admin] wa thread:', e.message);
    fail(res, 500, 'Could not load the conversation.');
  }
});

/** The untouched webhook payload — for diagnosing an odd message. */
router.get('/whatsapp/messages/:id/raw', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad message id.');
  try {
    const row = (await db.query(
      `SELECT id, wa_message_id, direction, message_type, payload
         FROM whatsapp_messages WHERE id = $1`, [id])).rows[0];
    if (!row) return fail(res, 404, 'Message not found.');
    ok(res, { message: row });
  } catch (e) {
    console.error('[admin] wa raw:', e.message);
    fail(res, 500, 'Could not load the payload.');
  }
});

module.exports = router;
