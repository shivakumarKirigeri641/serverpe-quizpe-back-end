/**
 * src/admin/curriculum.js
 * ---------------------------------------------------------------------------
 * The panel seen by grade and by subject — who is in each, how they are doing,
 * and whether there are still questions left to ask them.
 *
 * POOL HEALTH IS THE POINT. QuizPe draws each quiz from a pool and does not
 * repeat recently-used questions, so a pool that runs thin does not fail
 * loudly — it quietly starts repeating, or starves, and the first anyone hears
 * is a parent saying "we have seen this one before". The days-remaining figure
 * here is computed from THIS grade's actual recent consumption rate, never
 * from a guess: questions still unused, divided by how many that grade has
 * actually been getting through per day.
 *
 * Revenue is attributed to a grade through the child's subscription, which
 * means a two-child family on one plan contributes to two grades. That is
 * wrong for accounting and right for "which grade is worth serving", which is
 * what this screen is for — Finance remains the place for money.
 *
 * Read-only throughout, via ./readOnly.
 * ---------------------------------------------------------------------------
 */

const { read, TZ, TODAY } = require('./readOnly');

/* ────────────────────────────────────────────────────────────────────────────
 * Per grade: the families, the quizzes, and the money.
 * ──────────────────────────────────────────────────────────────────────────*/
async function byGrade({ days = 30 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  return read(
    `WITH st AS (
       SELECT s.id, s.grade_id, s.parent_id
         FROM students s
        WHERE s.is_active
     ),
     sub AS (                                   -- newest subscription per parent
       SELECT DISTINCT ON (x.parent_id)
              x.parent_id, p.is_trial, p.plan_name,
              (x.is_active AND CURRENT_DATE BETWEEN x.plan_start_date AND x.plan_end_date) AS live
         FROM parents_quizpe_subscriptions x
         JOIN quizpe_plans p ON p.id = x.plan_id
        ORDER BY x.parent_id, x.plan_end_date DESC, x.id DESC
     ),
     tr AS (
       SELECT t.id, t.student_id, t.question_count
         FROM quizpe_tracker t
        WHERE t.is_active AND t.quiz_date >= ${TODAY} - $1::int
     ),
     ans AS (
       SELECT t.student_id,
              count(*) FILTER (WHERE h.answered_at IS NOT NULL)::int AS answered,
              count(*) FILTER (WHERE h.is_correct)::int              AS correct
         FROM student_quizpe_histories h
         JOIN tr t ON t.id = h.tracker_id
        GROUP BY t.student_id
     ),
     done AS (
       SELECT t.student_id,
              count(*)::int AS quizzes,
              count(*) FILTER (WHERE x.answered >= t.question_count)::int AS completed
         FROM tr t
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE h.answered_at IS NOT NULL)::int AS answered
             FROM student_quizpe_histories h WHERE h.tracker_id = t.id
         ) x ON true
        GROUP BY t.student_id
     ),
     money AS (
       SELECT s2.parent_id, SUM(i.total)::numeric AS paid
         FROM invoices i
         JOIN parents_quizpe_subscriptions s2 ON s2.id = i.subscription_id
        WHERE i.is_active
        GROUP BY s2.parent_id
     ),
     pool AS (
       SELECT q.grade_id,
              count(*) FILTER (WHERE q.is_active)::int AS questions
         FROM question_bank q GROUP BY q.grade_id
     )
     SELECT g.id AS grade_id, g.grade_code, g.grade_name,
            count(st.id)::int                                            AS students,
            count(*) FILTER (WHERE sub.live AND NOT sub.is_trial)::int    AS paid_students,
            count(*) FILTER (WHERE sub.live AND sub.is_trial)::int        AS trial_students,
            count(*) FILTER (WHERE sub.live IS NOT TRUE)::int             AS lapsed_students,
            COALESCE(SUM(done.quizzes), 0)::int                           AS quizzes,
            COALESCE(SUM(done.completed), 0)::int                         AS completed,
            COALESCE(SUM(ans.answered), 0)::int                           AS answered,
            COALESCE(SUM(ans.correct), 0)::int                            AS correct,
            ROUND(SUM(ans.correct) * 100.0 / NULLIF(SUM(ans.answered), 0), 1)   AS accuracy_pct,
            ROUND(SUM(done.completed) * 100.0 / NULLIF(SUM(done.quizzes), 0), 1) AS completion_pct,
            COALESCE(ROUND(SUM(DISTINCT money.paid)::numeric, 0), 0)      AS revenue,
            COALESCE(pool.questions, 0)                                   AS pool_questions
       FROM grades g
       LEFT JOIN st    ON st.grade_id = g.id
       LEFT JOIN sub   ON sub.parent_id = st.parent_id
       LEFT JOIN ans   ON ans.student_id = st.id
       LEFT JOIN done  ON done.student_id = st.id
       LEFT JOIN money ON money.parent_id = st.parent_id
       LEFT JOIN pool  ON pool.grade_id = g.id
      WHERE g.is_active
      GROUP BY g.id, g.grade_code, g.grade_name, g.display_order, pool.questions
      HAVING count(st.id) > 0 OR COALESCE(pool.questions, 0) > 0
      ORDER BY g.display_order, g.id`,
    [d]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Per subject, optionally within one grade.
 * ──────────────────────────────────────────────────────────────────────────*/
async function bySubject({ days = 30, gradeId = null } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const g = gradeId ? Number(gradeId) : null;
  return read(
    `WITH tr AS (
       SELECT t.id, t.subject_id, t.student_id, t.question_count
         FROM quizpe_tracker t
         JOIN students s ON s.id = t.student_id
        WHERE t.is_active AND t.quiz_date >= ${TODAY} - $1::int
          AND ($2::bigint IS NULL OR s.grade_id = $2::bigint)
     ),
     h AS (
       SELECT tr.subject_id,
              count(*) FILTER (WHERE x.answered_at IS NOT NULL)::int AS answered,
              count(*) FILTER (WHERE x.is_correct)::int              AS correct,
              AVG(x.response_seconds)                                 AS avg_secs,
              count(DISTINCT x.question_id)::int                      AS distinct_questions
         FROM student_quizpe_histories x
         JOIN tr ON tr.id = x.tracker_id
        GROUP BY tr.subject_id
     ),
     q AS (
       SELECT qb.subject_id, count(*) FILTER (WHERE qb.is_active)::int AS questions
         FROM question_bank qb
        WHERE ($2::bigint IS NULL OR qb.grade_id = $2::bigint)
        GROUP BY qb.subject_id
     )
     SELECT s.id AS subject_id, s.subject_code, s.subject_name,
            (SELECT count(*)::int FROM tr WHERE tr.subject_id = s.id)                AS quizzes,
            (SELECT count(DISTINCT tr.student_id)::int FROM tr WHERE tr.subject_id = s.id) AS students,
            COALESCE(h.answered, 0)            AS answered,
            COALESCE(h.correct, 0)             AS correct,
            ROUND(h.correct * 100.0 / NULLIF(h.answered, 0), 1) AS accuracy_pct,
            ROUND(h.avg_secs::numeric, 1)      AS avg_seconds,
            COALESCE(h.distinct_questions, 0)  AS questions_used,
            COALESCE(q.questions, 0)           AS pool_questions
       FROM subjects s
       LEFT JOIN h ON h.subject_id = s.id
       LEFT JOIN q ON q.subject_id = s.id
      WHERE s.is_active
      ORDER BY s.display_order, s.id`,
    [d, g]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pool health — how long before a grade starts repeating itself.
 *
 * "Used" means used by anyone in that grade in the lookback window, which is
 * the pool the selector is actually avoiding. The burn rate is measured, not
 * assumed: distinct questions consumed per active day, from real history.
 * ──────────────────────────────────────────────────────────────────────────*/
async function poolHealth({ days = 30 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 7), 180);
  return read(
    `WITH used AS (
       SELECT s.grade_id, t.subject_id,
              count(DISTINCT h.question_id)::int                        AS used,
              count(DISTINCT (t.quiz_date))::int                        AS active_days
         FROM student_quizpe_histories h
         JOIN quizpe_tracker t ON t.id = h.tracker_id
         JOIN students s       ON s.id = t.student_id
        WHERE t.quiz_date >= ${TODAY} - $1::int AND h.sent_at IS NOT NULL
        GROUP BY s.grade_id, t.subject_id
     ),
     have AS (
       SELECT grade_id, subject_id, count(*)::int AS total
         FROM question_bank WHERE is_active
        GROUP BY grade_id, subject_id
     )
     SELECT g.grade_code, g.grade_name, sj.subject_code,
            have.total                                   AS pool,
            COALESCE(used.used, 0)                       AS used,
            GREATEST(have.total - COALESCE(used.used, 0), 0) AS unused,
            COALESCE(used.active_days, 0)                AS active_days,
            ROUND(used.used::numeric / NULLIF(used.active_days, 0), 1) AS per_day,
            CASE WHEN COALESCE(used.active_days, 0) = 0 OR used.used = 0 THEN NULL
                 ELSE FLOOR((have.total - used.used)
                            / NULLIF(used.used::numeric / used.active_days, 0))
            END                                          AS days_left
       FROM have
       JOIN grades   g  ON g.id  = have.grade_id  AND g.is_active
       JOIN subjects sj ON sj.id = have.subject_id AND sj.is_active
       LEFT JOIN used ON used.grade_id = have.grade_id AND used.subject_id = have.subject_id
      WHERE COALESCE(used.used, 0) > 0          -- only pools actually in use
      ORDER BY days_left NULLS LAST, g.display_order`,
    [d]);
}

module.exports = { byGrade, bySubject, poolHealth };
