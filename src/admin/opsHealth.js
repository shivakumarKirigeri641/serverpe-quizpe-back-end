/**
 * src/admin/opsHealth.js
 * ---------------------------------------------------------------------------
 * The operations half of the panel: did the background jobs run, what is
 * stuck, and what has been failing.
 *
 * NO NEW TABLE. `job_queue` and `job_queue_archive` already carry kind,
 * status, attempts, last_error, who locked a job and when, and both timings —
 * which is every column a job monitor needs. They have simply never been read
 * by the admin panel, so a failed job has been something you found out about
 * by noticing a quiz did not arrive.
 *
 * ERRORS ARE GROUPED BY SHAPE, NOT BY TEXT. "tracker 412 not found" and
 * "tracker 907 not found" are one problem seen twice, so the digits and quoted
 * ids are collapsed before grouping. Otherwise an error center shows a hundred
 * rows of the same thing and gets ignored, which is the usual fate of error
 * dashboards.
 *
 * Read-only throughout, via ./readOnly, which the database enforces.
 * ---------------------------------------------------------------------------
 */

const { read, TZ, TODAY } = require('./readOnly');

/* Collapse the parts of a message that vary between occurrences of one fault. */
const SHAPE = (col) => `
  regexp_replace(
    regexp_replace(
      regexp_replace(${col}, '[0-9]+', 'N', 'g'),
      '''[^'']*''', '''X''', 'g'),
    '\\s+', ' ', 'g')`;

/* Jobs live in two tables: the queue, and what has been archived out of it. */
const ALL_JOBS = `(
  SELECT kind, status, attempts, max_attempts, last_error, locked_by, locked_at,
         run_after, created_at, completed_at FROM job_queue
  UNION ALL
  SELECT kind, status, attempts, max_attempts, last_error, locked_by, locked_at,
         run_after, created_at, completed_at FROM job_queue_archive
)`;

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Is the worker alive, and what has it been doing?
 * ──────────────────────────────────────────────────────────────────────────*/
async function jobSummary(days = 7) {
  const d = Math.min(Math.max(Number(days) || 7, 1), 90);
  return read(
    `SELECT j.kind,
            count(*)::int                                          AS total,
            count(*) FILTER (WHERE j.status = 'done')::int           AS done,
            count(*) FILTER (WHERE j.status = 'failed')::int         AS failed,
            count(*) FILTER (WHERE j.status = 'queued')::int         AS queued,
            count(*) FILTER (WHERE j.status = 'running')::int        AS running,
            ROUND(AVG(EXTRACT(EPOCH FROM (j.completed_at - j.created_at)))
                    FILTER (WHERE j.completed_at IS NOT NULL)::numeric, 1) AS avg_seconds,
            to_char(max(j.completed_at) AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS last_finished,
            EXTRACT(EPOCH FROM (now() - max(j.completed_at)))::int   AS seconds_since_last
       FROM ${ALL_JOBS} j
      WHERE j.created_at >= ${TODAY} - ($1::int - 1)
      GROUP BY j.kind
      ORDER BY count(*) FILTER (WHERE j.status = 'failed') DESC, count(*) DESC`,
    [d]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. What is stuck right now.
 *
 * Two different faults, deliberately reported together because both look the
 * same from outside — nothing happened:
 *   · a job locked by a worker that never released it;
 *   · a job whose run_after has passed and is still waiting.
 * ──────────────────────────────────────────────────────────────────────────*/
async function stuck({ lockMinutes = 15 } = {}) {
  const mins = Math.min(Math.max(Number(lockMinutes) || 15, 1), 1440);
  return read(
    `SELECT id, kind, status, attempts, max_attempts,
            locked_by,
            to_char(locked_at  AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS locked_at,
            to_char(run_after  AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS due_at,
            to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS created_at,
            EXTRACT(EPOCH FROM (now() - COALESCE(locked_at, run_after)))::int AS waiting_seconds,
            left(last_error, 180) AS last_error,
            CASE
              WHEN status = 'running' THEN 'locked and never released'
              ELSE 'due but still waiting'
            END AS why
       FROM job_queue
      WHERE (status = 'running' AND locked_at < now() - make_interval(mins => $1::int))
         OR (status = 'queued'  AND run_after < now() - make_interval(mins => $1::int))
      ORDER BY COALESCE(locked_at, run_after)
      LIMIT 100`,
    [mins]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The Error Center — every failure, grouped by shape.
 *
 * Three sources, because a fault shows up wherever it happened: a background
 * job, a WhatsApp send, or a scheduled notification.
 * ──────────────────────────────────────────────────────────────────────────*/
async function errorCenter(days = 14) {
  const d = Math.min(Math.max(Number(days) || 14, 1), 180);
  return read(
    `WITH e AS (
       SELECT 'job'       AS source, kind          AS context, last_error    AS message, created_at
         FROM ${ALL_JOBS} j
        WHERE last_error IS NOT NULL AND created_at >= ${TODAY} - ($1::int - 1)
       UNION ALL
       SELECT 'whatsapp'  AS source,
              COALESCE(payload#>>'{template,name}', message_type) AS context,
              error_message AS message, created_at
         FROM whatsapp_messages
        WHERE error_message IS NOT NULL AND created_at >= ${TODAY} - ($1::int - 1)
       UNION ALL
       SELECT 'notification' AS source, kind AS context, error_message AS message, created_at
         FROM notification_log
        WHERE error_message IS NOT NULL AND created_at >= ${TODAY} - ($1::int - 1)
     )
     SELECT e.source,
            ${SHAPE('e.message')}                                        AS shape,
            left(min(e.message), 200)                                    AS example,
            count(*)::int                                                AS occurrences,
            count(DISTINCT e.context)::int                               AS contexts,
            (array_agg(DISTINCT e.context))[1:4]                         AS where_seen,
            to_char(min(e.created_at) AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS first_seen,
            to_char(max(e.created_at) AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS last_seen,
            EXTRACT(EPOCH FROM (now() - max(e.created_at)))::int          AS seconds_since_last
       FROM e
      GROUP BY e.source, ${SHAPE('e.message')}
      ORDER BY count(*) DESC
      LIMIT 60`,
    [d]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. The webhook, as seen from the inside.
 *
 * Every inbound WhatsApp message is a webhook delivery that arrived and was
 * processed, so inbound volume IS webhook health — if Meta stopped reaching
 * us, this goes flat. whatsapp_session_events adds what the bot then did.
 * ──────────────────────────────────────────────────────────────────────────*/
async function webhookActivity(days = 7) {
  const d = Math.min(Math.max(Number(days) || 7, 1), 90);
  return read(
    `WITH span AS (
       SELECT generate_series(${TODAY} - ($1::int - 1), ${TODAY}, interval '1 day')::date AS day
     ),
     inb AS (
       SELECT (created_at AT TIME ZONE '${TZ}')::date AS day,
              count(*)::int                           AS messages,
              count(DISTINCT mobile_number)::int      AS people
         FROM whatsapp_messages
        WHERE direction = 'inbound' AND created_at >= ${TODAY} - ($1::int - 1)
        GROUP BY 1
     ),
     ev AS (
       SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, count(*)::int AS transitions
         FROM whatsapp_session_events
        WHERE created_at >= ${TODAY} - ($1::int - 1)
        GROUP BY 1
     )
     SELECT to_char(span.day, 'DD Mon')      AS label,
            COALESCE(inb.messages, 0)        AS messages,
            COALESCE(inb.people, 0)          AS people,
            COALESCE(ev.transitions, 0)      AS transitions
       FROM span
       LEFT JOIN inb ON inb.day = span.day
       LEFT JOIN ev  ON ev.day  = span.day
      ORDER BY span.day`,
    [d]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. One row saying whether anything is wrong at all.
 * ──────────────────────────────────────────────────────────────────────────*/
async function health() {
  const rows = await read(
    `SELECT
       (SELECT count(*)::int FROM job_queue WHERE status = 'failed')  AS failed_jobs,
       (SELECT count(*)::int FROM job_queue WHERE status = 'queued')  AS queued_jobs,
       (SELECT count(*)::int FROM job_queue
         WHERE status = 'running' AND locked_at < now() - interval '15 minutes') AS stuck_jobs,
       (SELECT EXTRACT(EPOCH FROM (now() - max(completed_at)))::int
          FROM job_queue WHERE status = 'done')                        AS seconds_since_job,
       -- The web app (2026-10-10), where the WhatsApp webhook used to be: the last family
       -- seen on quizpe.in/app, and reminders (phone notifications / email) not reached.
       (SELECT EXTRACT(EPOCH FROM (now() - max(last_seen_at)))::int
          FROM parent_web_sessions)                                    AS seconds_since_app,
       (SELECT count(*)::int FROM notification_log
         WHERE template_name = 'web' AND status = 'failed'
           AND created_at > now() - interval '24 hours')               AS failed_sends_24h`);

  const r = rows[0] || {};
  // A worker that has not finished anything in two hours, or many reminders not
  // reaching families, is worth a colour — but neither is proof on its own at 3 a.m.
  const verdict = (r.stuck_jobs > 0 || r.failed_jobs > 0) ? 'critical'
    : (Number(r.seconds_since_job) > 7200 || Number(r.failed_sends_24h) > 10) ? 'warning'
      : 'healthy';
  return { ...r, verdict };
}

module.exports = { jobSummary, stuck, errorCenter, webhookActivity, health };
