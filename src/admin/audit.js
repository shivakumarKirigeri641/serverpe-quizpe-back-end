/**
 * src/admin/audit.js
 * ---------------------------------------------------------------------------
 * A record of what administrators did.
 *
 * THIS IS THE ONLY PART OF THE ADMIN WORK THAT WRITES. Everything else reads
 * under a transaction the database refuses writes in. So this file is written
 * defensively, to one rule:
 *
 *     AUDITING MUST NEVER AFFECT THE ACTION BEING AUDITED.
 *
 * The record is written AFTER the response has been sent, from the response's
 * own `finish` event, and only when the action actually succeeded. Any failure
 * writing it is swallowed with a log line. If the audit table is missing, full,
 * locked or renamed, every admin action still works exactly as before — an
 * audit trail is worth a great deal, and it is still worth less than the panel
 * continuing to function.
 *
 * It records only what an admin changed, and never a parent's or child's
 * message content. Request bodies are summarised by the caller, deliberately,
 * so nobody has to remember which field held a mobile number.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const { read, TZ } = require('./readOnly');

let tableMissing = false;      // checked once; a missing table must not nag

/**
 * Write one entry. Fire and forget — the caller never waits for it and never
 * sees it fail.
 */
function record({
  admin, action, targetType = null, targetId = null,
  summary = null, before = null, after = null, ip = null, userAgent = null, status = null,
}) {
  if (tableMissing || !action) return;
  db.query(
    `INSERT INTO admin_audit_log
       (admin_mobile, action, target_type, target_id, summary,
        before_state, after_state, ip, user_agent, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      admin || null, action, targetType, targetId == null ? null : String(targetId),
      summary, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      ip, userAgent ? String(userAgent).slice(0, 400) : null, status,
    ],
  ).catch((e) => {
    if (e.code === '42P01') {          // undefined_table — migration not run yet
      tableMissing = true;
      console.warn('[audit] admin_audit_log does not exist; auditing is off until the migration runs');
    } else {
      console.warn('[audit] could not record:', e.message);
    }
  });
}

/**
 * Express middleware. Mount after requireAdmin on any route worth recording:
 *
 *   router.post('/broadcast', requireAdmin, audit('broadcast.send'), handler)
 *
 * `describe` may return { targetType, targetId, summary, after } from the
 * request, so the caller decides what is worth keeping rather than this file
 * guessing at field names.
 */
function audit(action, describe) {
  return (req, res, next) => {
    res.on('finish', () => {
      // Only successful actions are history. A refused one is not a change.
      if (res.statusCode >= 400) return;
      let extra = {};
      try { extra = (describe ? describe(req, res) : {}) || {}; }
      catch { extra = {}; }
      record({
        admin: req.admin?.sub,
        action,
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
        userAgent: req.headers['user-agent'],
        status: res.statusCode,
        ...extra,
      });
    });
    next();
  };
}

/* ── reading it back ──────────────────────────────────────────────────────── */

async function list({ days = 30, admin = null, action = null, limit = 200 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  try {
    return await read(
      `SELECT id, admin_mobile, action, target_type, target_id, summary, status,
              before_state, after_state, ip,
              to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon HH24:MI:SS') AS at,
              created_at
         FROM admin_audit_log
        WHERE created_at >= now() - make_interval(days => $1::int)
          AND ($2::text IS NULL OR admin_mobile = $2::text)
          AND ($3::text IS NULL OR action = $3::text)
        ORDER BY created_at DESC
        LIMIT $4::int`,
      [d, admin || null, action || null, lim]);
  } catch (e) {
    if (e.code === '42P01') return [];        // not migrated yet — show nothing
    throw e;
  }
}

/** What has been happening, grouped — the summary strip above the log. */
async function summary({ days = 30 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  try {
    return await read(
      `SELECT action,
              count(*)::int                       AS times,
              count(DISTINCT admin_mobile)::int   AS admins,
              to_char(max(created_at) AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS last_at
         FROM admin_audit_log
        WHERE created_at >= now() - make_interval(days => $1::int)
        GROUP BY action
        ORDER BY count(*) DESC`,
      [d]);
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

module.exports = { record, audit, list, summary };
