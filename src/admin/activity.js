/**
 * src/admin/activity.js
 * ---------------------------------------------------------------------------
 * One chronological stream of everything happening in QuizPe, for the watch
 * view: quizzes started and finished, trials and paid subscriptions, feedback
 * ratings, and support tickets.
 *
 * Built as a UNION of small, individually-indexed queries rather than a giant
 * join. Each arm is cheap and independently limited, so the feed stays fast
 * even once the history tables are large.
 *
 * Times are formatted in Asia/Kolkata in SQL. Doing it in JS from a UTC
 * timestamp puts anything after 18:30 IST on the wrong day — which is exactly
 * when QuizPe is busiest.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const TZ = 'Asia/Kolkata';
const IST = (col) => `to_char(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}', 'DD Mon HH24:MI')`;

/**
 * @param {object} opts
 * @param {number} opts.limit   max rows overall
 * @param {string} opts.since   ISO timestamp — only newer events (for polling)
 * @param {string[]} opts.kinds filter, e.g. ['quiz_completed','paid']
 */
async function feed({ limit = 60, since = null, kinds = null } = {}) {
  const { rows } = await db.query(
    `WITH events AS (
       -- a child finished a quiz
       SELECT 'quiz_completed'::text AS kind, t.modified_at AS at,
              st.student_name AS who, p.parent_name AS parent, p.parent_mobile_number AS mobile,
              (r.score_correct || '/' || r.score_total || ' (' || r.score_pct || '%) grade ' || r.grade) AS detail,
              t.id AS ref_id, st.id AS student_id, p.id AS parent_id, NULL::numeric AS amount
         FROM quizpe_tracker t
         JOIN quizpe_status qs ON qs.id = t.status_id AND qs.status_code = 'completed'
         JOIN students st ON st.id = t.student_id
         JOIN parents  p  ON p.id = st.parent_id
         LEFT JOIN quiz_reports r ON r.tracker_id = t.id
        WHERE p.is_active
        ORDER BY t.modified_at DESC LIMIT 40
     ), started AS (
       -- a child opened today's quiz but has not finished it
       SELECT 'quiz_started'::text, t.created_at,
              st.student_name, p.parent_name, p.parent_mobile_number,
              ((SELECT COUNT(*) FROM student_quizpe_histories h
                 WHERE h.tracker_id = t.id AND h.answered_option IS NOT NULL)
               || ' of ' || t.question_count || ' answered'),
              t.id, st.id, p.id, NULL::numeric
         FROM quizpe_tracker t
         JOIN quizpe_status qs ON qs.id = t.status_id AND qs.status_code = 'in_progress'
         JOIN students st ON st.id = t.student_id
         JOIN parents  p  ON p.id = st.parent_id
        WHERE p.is_active
        ORDER BY t.created_at DESC LIMIT 20
     ), orphan_reports AS (
       -- A completed quiz whose tracker no longer exists (archived, or removed
       -- during maintenance). The report is still proof it happened, so the
       -- timeline should not silently lose the event.
       SELECT 'quiz_completed'::text, r.created_at,
              st.student_name, p.parent_name, p.parent_mobile_number,
              (r.score_correct || '/' || r.score_total || ' (' || r.score_pct || '%) grade ' || r.grade),
              r.id, st.id, p.id, NULL::numeric
         FROM quiz_reports r
         JOIN students st ON st.id = r.student_id
         JOIN parents  p  ON p.id = st.parent_id
        WHERE r.tracker_id IS NULL AND r.report_type = 'daily' AND r.is_active AND p.is_active
        ORDER BY r.created_at DESC LIMIT 40
     ), subs AS (
       -- trial and paid enrolments
       SELECT CASE WHEN pl.is_trial THEN 'trial' ELSE 'paid' END, s.created_at,
              COALESCE((SELECT string_agg(x.student_name, ', ') FROM students x
                         WHERE x.parent_id = p.id AND x.is_active), '—'),
              p.parent_name, p.parent_mobile_number,
              (pl.plan_name || ' until ' || s.plan_end_date),
              s.id, NULL::bigint, p.id,
              CASE WHEN pl.is_trial THEN NULL ELSE pl.price::numeric END
         FROM parents_quizpe_subscriptions s
         JOIN quizpe_plans pl ON pl.id = s.plan_id
         JOIN parents p ON p.id = s.parent_id
        ORDER BY s.created_at DESC LIMIT 40
     ), fb AS (
       SELECT 'feedback'::text, f.created_at,
              COALESCE(st.student_name, '—'), p.parent_name, p.parent_mobile_number,
              (COALESCE(f.rating::text, '?') || '★'
                 || COALESCE(' · ' || NULLIF(f.message, ''), '')
                 || COALESCE(' · ' || array_to_string(f.tags, ', '), '')),
              f.id, f.student_id, p.id, NULL::numeric
         FROM feedbacks f
         JOIN parents p ON p.id = f.parent_id
         LEFT JOIN students st ON st.id = f.student_id
        WHERE f.rating IS NOT NULL
        ORDER BY f.created_at DESC LIMIT 30
     ), tick AS (
       SELECT 'support'::text, t.created_at,
              COALESCE(t.user_name, '—'), COALESCE(t.user_name, ''), t.mobile_number,
              (t.ticket_no || ' · ' || t.query_type || ' · ' || t.status),
              t.id, NULL::bigint, t.parent_id, NULL::numeric
         FROM support_tickets t
        ORDER BY t.created_at DESC LIMIT 30
     )
     SELECT kind, at, who, parent, mobile, detail, ref_id, student_id, parent_id, amount,
            ${IST('at')} AS at_ist
       FROM (
         SELECT * FROM events UNION ALL SELECT * FROM started UNION ALL
         SELECT * FROM orphan_reports UNION ALL
         SELECT * FROM subs   UNION ALL SELECT * FROM fb      UNION ALL SELECT * FROM tick
       ) all_events
      WHERE ($1::timestamptz IS NULL OR at > $1::timestamptz)
        AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
      ORDER BY at DESC
      LIMIT $3`,
    [since, kinds && kinds.length ? kinds : null, Math.min(Math.max(limit, 1), 200)]);
  return rows;
}

/** Counts per kind for today — the tiles above the feed. */
async function todayCounts() {
  const { rows: [r] } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN quizpe_status s ON s.id=t.status_id
         WHERE t.quiz_date = CURRENT_DATE AND s.status_code='completed')
       + (SELECT COUNT(*)::int FROM quiz_reports
           WHERE tracker_id IS NULL AND report_type='daily' AND is_active
             AND quiz_date = CURRENT_DATE)                                    AS quizzes_completed,
       (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN quizpe_status s ON s.id=t.status_id
         WHERE t.quiz_date = CURRENT_DATE AND s.status_code='in_progress')    AS quizzes_in_progress,
       (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans p ON p.id=s.plan_id
         WHERE p.is_trial AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = CURRENT_DATE) AS trials,
       (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans p ON p.id=s.plan_id
         WHERE NOT p.is_trial AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = CURRENT_DATE) AS paid,
       (SELECT COUNT(*)::int FROM feedbacks
         WHERE rating IS NOT NULL
           AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = CURRENT_DATE) AS feedback,
       (SELECT COUNT(*)::int FROM support_tickets
         WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = CURRENT_DATE) AS support`);
  return r;
}

module.exports = { feed, todayCounts };
