/**
 * src/admin/deliveryHealth.js
 * ---------------------------------------------------------------------------
 * Whether WhatsApp is actually delivering — and which numbers are costing us
 * the account's quality rating.
 *
 * This exists because of a measurement, not a hunch: in one seven-day window
 * 132 of 394 template sends failed, every one of them "Message undeliverable",
 * across 55 distinct numbers — 40% of everyone contacted. Those sends never
 * become conversations, so they earn nothing toward the messaging limit, and
 * their failures drag down the quality rating that governs it. They are pure
 * loss, and nothing in the panel showed them, so they kept being sent to.
 *
 * Read-only throughout, via ./readOnly, which the database enforces.
 * ---------------------------------------------------------------------------
 */

const { read, TZ, TODAY } = require('./readOnly');

/* ── day by day ───────────────────────────────────────────────────────────── */
async function daily(days = 14) {
  const d = Math.min(Math.max(Number(days) || 14, 1), 90);
  return read(
    `WITH span AS (
       SELECT generate_series(${TODAY} - ($1::int - 1), ${TODAY}, interval '1 day')::date AS day
     ),
     m AS (
       SELECT (created_at AT TIME ZONE '${TZ}')::date                    AS day,
              count(*)::int                                              AS sent,
              count(*) FILTER (WHERE delivered_at IS NOT NULL)::int       AS delivered,
              count(*) FILTER (WHERE read_at      IS NOT NULL)::int       AS read,
              count(*) FILTER (WHERE status = 'failed')::int              AS failed,
              count(DISTINCT mobile_number)::int                          AS numbers
         FROM whatsapp_messages
        WHERE direction = 'outbound'
          AND created_at >= ${TODAY} - ($1::int - 1)
        GROUP BY 1
     )
     SELECT to_char(span.day, 'DD Mon') AS label,
            span.day::text              AS day,
            COALESCE(m.sent, 0)      AS sent,
            COALESCE(m.delivered, 0) AS delivered,
            COALESCE(m.read, 0)      AS read,
            COALESCE(m.failed, 0)    AS failed,
            COALESCE(m.numbers, 0)   AS numbers
       FROM span LEFT JOIN m ON m.day = span.day
      ORDER BY span.day`,
    [d]);
}

/* ── per template ─────────────────────────────────────────────────────────── */
async function byTemplate(days = 14) {
  const d = Math.min(Math.max(Number(days) || 14, 1), 90);
  return read(
    `SELECT COALESCE(payload#>>'{template,name}', '(free-form)')          AS template,
            count(*)::int                                                 AS sent,
            count(DISTINCT mobile_number)::int                            AS numbers,
            count(*) FILTER (WHERE delivered_at IS NOT NULL)::int          AS delivered,
            count(*) FILTER (WHERE read_at      IS NOT NULL)::int          AS read,
            count(*) FILTER (WHERE status = 'failed')::int                 AS failed,
            to_char(max(created_at) AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS last_sent
       FROM whatsapp_messages
      WHERE direction = 'outbound'
        AND created_at >= ${TODAY} - ($1::int - 1)
      GROUP BY 1
      ORDER BY count(*) DESC`,
    [d]);
}

/* ── the dead numbers ─────────────────────────────────────────────────────── */
async function undeliverable({ days = 90, limit = 200 } = {}) {
  const d = Math.min(Math.max(Number(days) || 90, 1), 365);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return read(
    `WITH bad AS (
       SELECT right(mobile_number, 10) AS mobile,
              count(*)::int            AS failures,
              max(created_at)          AS last_try,
              min(created_at)          AS first_try
         FROM whatsapp_messages
        WHERE direction = 'outbound' AND status = 'failed'
          AND error_message ILIKE '%undeliverable%'
          AND created_at >= ${TODAY} - $1::int
        GROUP BY 1
     ),
     ever AS (
       SELECT DISTINCT right(mobile_number, 10) AS mobile
         FROM whatsapp_messages WHERE direction = 'inbound'
     )
     SELECT bad.mobile, bad.failures,
            to_char(bad.last_try  AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS last_try,
            to_char(bad.first_try AT TIME ZONE '${TZ}', 'DD Mon')         AS first_try,
            (ever.mobile IS NOT NULL) AS ever_replied,
            p.parent_name
       FROM bad
       LEFT JOIN ever ON ever.mobile = bad.mobile
       LEFT JOIN parents p ON p.parent_mobile_number = bad.mobile
      ORDER BY bad.failures DESC, bad.last_try DESC
      LIMIT $2::int`,
    [d, lim]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Numbers broadcast at repeatedly with no reply.
 *
 * Meta caps marketing per RECIPIENT, not per sender, so no delay between
 * sends avoids it — the only remedy is to stop sending to people who never
 * answer. This names them.
 * ──────────────────────────────────────────────────────────────────────────*/
async function unanswered({ days = 30, minSends = 3, limit = 200 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 180);
  const min = Math.max(Number(minSends) || 3, 2);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return read(
    `WITH out AS (
       SELECT right(mobile_number, 10) AS mobile,
              count(*)::int            AS sends,
              max(created_at)          AS last_send
         FROM whatsapp_messages
        WHERE direction = 'outbound' AND message_type = 'template'
          AND created_at >= ${TODAY} - $1::int
        GROUP BY 1
       HAVING count(*) >= $2::int
     ),
     inb AS (
       SELECT right(mobile_number, 10) AS mobile
         FROM whatsapp_messages
        WHERE direction = 'inbound' AND created_at >= ${TODAY} - $1::int
        GROUP BY 1
     )
     SELECT out.mobile, out.sends,
            to_char(out.last_send AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS last_send,
            p.parent_name
       FROM out
       LEFT JOIN inb ON inb.mobile = out.mobile
       LEFT JOIN parents p ON p.parent_mobile_number = out.mobile
      WHERE inb.mobile IS NULL          -- not one reply in the whole period
      ORDER BY out.sends DESC, out.last_send DESC
      LIMIT $3::int`,
    [d, min, lim]);
}

/* ── did today's scheduled sends run, and land? ───────────────────────────── */
async function jobsToday() {
  return read(
    `SELECT kind,
            count(*)::int                                 AS attempts,
            count(*) FILTER (WHERE status = 'sent')::int   AS sent,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            to_char(min(created_at) AT TIME ZONE '${TZ}', 'HH24:MI') AS first_at,
            to_char(max(created_at) AT TIME ZONE '${TZ}', 'HH24:MI') AS last_at
       FROM notification_log
      WHERE (created_at AT TIME ZONE '${TZ}')::date = ${TODAY}
      GROUP BY kind
      ORDER BY min(created_at)`);
}

/* ── headline numbers for the delivery dials ──────────────────────────────── */
async function summary(days = 7) {
  const d = Math.min(Math.max(Number(days) || 7, 1), 90);
  const rows = await read(
    `SELECT count(*)::int                                        AS sent,
            count(DISTINCT mobile_number)::int                   AS numbers,
            count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
            count(*) FILTER (WHERE read_at      IS NOT NULL)::int AS read,
            count(*) FILTER (WHERE status = 'failed')::int        AS failed,
            count(DISTINCT mobile_number) FILTER (
              WHERE status = 'failed' AND error_message ILIKE '%undeliverable%')::int AS dead_numbers
       FROM whatsapp_messages
      WHERE direction = 'outbound' AND created_at >= ${TODAY} - ($1::int - 1)`,
    [d]);

  const replies = await read(
    `SELECT count(DISTINCT right(mobile_number, 10))::int AS n
       FROM whatsapp_messages
      WHERE direction = 'inbound' AND created_at >= ${TODAY} - ($1::int - 1)`,
    [d]);

  const r = rows[0] || {};
  const sent = Number(r.sent || 0);
  const replied = replies[0]?.n ?? 0;

  return {
    ...r,
    replied_numbers: replied,
    delivery_pct: sent ? Math.round((Number(r.delivered) / sent) * 1000) / 10 : null,
    failure_pct: sent ? Math.round((Number(r.failed) / sent) * 1000) / 10 : null,
    reply_pct: r.numbers ? Math.round((replied / Number(r.numbers)) * 1000) / 10 : null,
  };
}

module.exports = { summary, daily, byTemplate, undeliverable, unanswered, jobsToday };
