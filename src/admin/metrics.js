/**
 * src/admin/metrics.js
 * ---------------------------------------------------------------------------
 * Every number the admin dashboard shows, in one place.
 *
 * All comparisons are computed in SQL against Asia/Kolkata, never in JS from
 * UTC timestamps — a date built with toISOString() lands on the wrong day for
 * anything after 18:30 IST, which is exactly when QuizPe is busiest. That bug
 * already cost a broken streak counter once; it is not repeated here.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const TZ = 'Asia/Kolkata';
/** A date expression in IST, for grouping and comparisons. */
const IST_DATE = (col) => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date`;

/** Percentage change, guarding against divide-by-zero. */
const delta = (now, was) => (was === 0 ? (now === 0 ? 0 : 100) : +(((now - was) / was) * 100).toFixed(1));

/** Headline counters plus how each compares with the period before. */
async function overview() {
  const { rows: [r] } = await db.query(`
    WITH d AS (SELECT CURRENT_DATE AS today)
    SELECT
      (SELECT COUNT(*)::int FROM parents WHERE is_active)                              AS parents_total,
      (SELECT COUNT(*)::int FROM students WHERE is_active)                             AS students_total,
      (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans p ON p.id=s.plan_id
        WHERE s.is_active AND p.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS trial_active,
      (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans p ON p.id=s.plan_id
        WHERE s.is_active AND NOT p.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS paid_active,
      (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans p ON p.id=s.plan_id
        WHERE s.is_active AND CURRENT_DATE > s.plan_end_date)                          AS expired,
      (SELECT COALESCE(SUM(total),0)::numeric FROM invoices WHERE is_active)           AS revenue_total,
      (SELECT COUNT(*)::int FROM question_bank WHERE is_active)                        AS questions_total,
      (SELECT COUNT(*)::int FROM support_tickets WHERE status='open')                  AS open_tickets
    FROM d`);
  return r;
}

/**
 * One row per day for the last `days` days: quizzes taken, average score,
 * signups, revenue. Drives both the trend charts and the comparison tiles.
 */
async function daily(days = 30) {
  const { rows } = await db.query(`
    WITH span AS (
      SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day')::date AS d
    )
    SELECT span.d::text AS date,
      COALESCE(q.taken, 0)          AS quizzes_taken,
      COALESCE(q.completed, 0)      AS quizzes_completed,
      COALESCE(q.avg_pct, 0)        AS avg_score_pct,
      COALESCE(s.signups, 0)        AS signups,
      COALESCE(i.revenue, 0)        AS revenue,
      COALESCE(f.avg_rating, 0)     AS avg_rating
    FROM span
    LEFT JOIN (
      SELECT t.quiz_date AS d,
             COUNT(*)::int AS taken,
             COUNT(*) FILTER (WHERE st.status_code='completed')::int AS completed,
             ROUND(AVG(r.score_pct))::int AS avg_pct
        FROM quizpe_tracker t
        JOIN quizpe_status st ON st.id = t.status_id
        LEFT JOIN quiz_reports r ON r.tracker_id = t.id
       GROUP BY t.quiz_date) q ON q.d = span.d
    LEFT JOIN (
      SELECT ${IST_DATE('created_at')} AS d, COUNT(*)::int AS signups
        FROM parents WHERE is_active GROUP BY 1) s ON s.d = span.d
    LEFT JOIN (
      SELECT ${IST_DATE('created_at')} AS d, SUM(total)::numeric AS revenue
        FROM invoices WHERE is_active GROUP BY 1) i ON i.d = span.d
    LEFT JOIN (
      SELECT ${IST_DATE('created_at')} AS d, ROUND(AVG(rating), 2)::numeric AS avg_rating
        FROM feedbacks WHERE rating IS NOT NULL GROUP BY 1) f ON f.d = span.d
    ORDER BY span.d`, [days]);
  return rows;
}

/** Today vs yesterday, this week vs last, this month vs last. */
async function comparisons() {
  const { rows: [r] } = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date = CURRENT_DATE)                       AS quizzes_today,
      (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date = CURRENT_DATE - 1)                   AS quizzes_yesterday,
      (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date > CURRENT_DATE - 7)                   AS quizzes_week,
      (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date > CURRENT_DATE - 14
                                                  AND quiz_date <= CURRENT_DATE - 7)                  AS quizzes_prev_week,
      (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date > CURRENT_DATE - 30)                  AS quizzes_month,
      (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date > CURRENT_DATE - 60
                                                  AND quiz_date <= CURRENT_DATE - 30)                 AS quizzes_prev_month,
      (SELECT COUNT(*)::int FROM parents WHERE ${IST_DATE('created_at')} = CURRENT_DATE)              AS signups_today,
      (SELECT COUNT(*)::int FROM parents WHERE ${IST_DATE('created_at')} = CURRENT_DATE - 1)          AS signups_yesterday,
      (SELECT COUNT(*)::int FROM parents WHERE ${IST_DATE('created_at')} > CURRENT_DATE - 7)          AS signups_week,
      (SELECT COUNT(*)::int FROM parents WHERE ${IST_DATE('created_at')} > CURRENT_DATE - 14
                                           AND ${IST_DATE('created_at')} <= CURRENT_DATE - 7)         AS signups_prev_week,
      (SELECT COALESCE(SUM(total),0)::numeric FROM invoices WHERE ${IST_DATE('created_at')} = CURRENT_DATE)     AS revenue_today,
      (SELECT COALESCE(SUM(total),0)::numeric FROM invoices WHERE ${IST_DATE('created_at')} = CURRENT_DATE - 1) AS revenue_yesterday,
      (SELECT COALESCE(SUM(total),0)::numeric FROM invoices WHERE ${IST_DATE('created_at')} > CURRENT_DATE - 30) AS revenue_month,
      (SELECT COALESCE(SUM(total),0)::numeric FROM invoices WHERE ${IST_DATE('created_at')} > CURRENT_DATE - 60
                                                              AND ${IST_DATE('created_at')} <= CURRENT_DATE - 30) AS revenue_prev_month
  `);
  const pair = (now, was) => ({ now: Number(now), was: Number(was), delta: delta(Number(now), Number(was)) });
  return {
    quizzes: {
      today: pair(r.quizzes_today, r.quizzes_yesterday),
      week: pair(r.quizzes_week, r.quizzes_prev_week),
      month: pair(r.quizzes_month, r.quizzes_prev_month),
    },
    signups: {
      today: pair(r.signups_today, r.signups_yesterday),
      week: pair(r.signups_week, r.signups_prev_week),
    },
    revenue: {
      today: pair(r.revenue_today, r.revenue_yesterday),
      month: pair(r.revenue_month, r.revenue_prev_month),
    },
  };
}

/** Trial vs paid: how many, converting, and what they are worth. */
async function planSplit() {
  const { rows } = await db.query(`
    SELECT pl.plan_code, pl.plan_name, pl.is_trial, pl.price::numeric,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE s.is_active AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)::int AS active,
           COUNT(*) FILTER (WHERE CURRENT_DATE > s.plan_end_date)::int AS lapsed,
           COALESCE(SUM(i.total), 0)::numeric AS revenue
      FROM parents_quizpe_subscriptions s
      JOIN quizpe_plans pl ON pl.id = s.plan_id
      LEFT JOIN invoices i ON i.subscription_id = s.id AND i.is_active
     GROUP BY pl.id, pl.plan_code, pl.plan_name, pl.is_trial, pl.price
     ORDER BY pl.is_trial DESC, pl.price`);

  // trial -> paid conversion, the number that actually matters
  const { rows: [conv] } = await db.query(`
    SELECT
      COUNT(DISTINCT p.id) FILTER (WHERE t.parent_id IS NOT NULL)::int AS tried,
      COUNT(DISTINCT p.id) FILTER (WHERE t.parent_id IS NOT NULL AND pd.parent_id IS NOT NULL)::int AS converted
      FROM parents p
      LEFT JOIN (SELECT DISTINCT s.parent_id FROM parents_quizpe_subscriptions s
                   JOIN quizpe_plans pl ON pl.id=s.plan_id WHERE pl.is_trial) t ON t.parent_id = p.id
      LEFT JOIN (SELECT DISTINCT s.parent_id FROM parents_quizpe_subscriptions s
                   JOIN quizpe_plans pl ON pl.id=s.plan_id WHERE NOT pl.is_trial) pd ON pd.parent_id = p.id
     WHERE p.is_active`);

  return {
    plans: rows,
    conversion: {
      tried: conv.tried,
      converted: conv.converted,
      pct: conv.tried ? +((conv.converted / conv.tried) * 100).toFixed(1) : 0,
    },
  };
}

/** Live feed of enrolments — the "watching view". */
async function enrolmentFeed(limit = 50) {
  const { rows } = await db.query(`
    SELECT s.id, p.parent_name, p.parent_mobile_number, p.state_code,
           pl.plan_code, pl.plan_name, pl.is_trial, pl.price::numeric,
           s.plan_start_date::text, s.plan_end_date::text,
           to_char(s.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}', 'DD Mon HH24:MI') AS at,
           s.created_at,
           (SELECT COUNT(*)::int FROM students st WHERE st.parent_id = p.id AND st.is_active) AS children,
           (SELECT string_agg(st.student_name || ' (' || g.grade_name || ')', ', ')
              FROM students st JOIN grades g ON g.id = st.grade_id
             WHERE st.parent_id = p.id AND st.is_active) AS children_names,
           i.invoice_id, i.total::numeric AS invoice_total
      FROM parents_quizpe_subscriptions s
      JOIN parents p ON p.id = s.parent_id
      JOIN quizpe_plans pl ON pl.id = s.plan_id
      LEFT JOIN invoices i ON i.subscription_id = s.id AND i.is_active
     ORDER BY s.created_at DESC
     LIMIT $1`, [limit]);
  return rows;
}

/** Engagement: who is actually doing their quizzes. */
async function engagement() {
  const { rows } = await db.query(`
    SELECT st.id AS student_id, st.student_name, st.school_name,
           b.board_code, g.grade_name, p.parent_name, p.parent_mobile_number,
           COUNT(t.id)::int AS quizzes,
           COUNT(*) FILTER (WHERE qs.status_code='completed')::int AS completed,
           COUNT(*) FILTER (WHERE qs.status_code='skipped')::int AS skipped,
           COALESCE(ROUND(AVG(r.score_pct)), 0)::int AS avg_pct,
           MAX(t.quiz_date)::text AS last_quiz
      FROM students st
      JOIN parents p ON p.id = st.parent_id
      JOIN boards b ON b.id = st.board_id
      JOIN grades g ON g.id = st.grade_id
      LEFT JOIN quizpe_tracker t ON t.student_id = st.id
      LEFT JOIN quizpe_status qs ON qs.id = t.status_id
      LEFT JOIN quiz_reports r ON r.tracker_id = t.id
     WHERE st.is_active AND p.is_active
     GROUP BY st.id, st.student_name, st.school_name, b.board_code, g.grade_name,
              p.parent_name, p.parent_mobile_number
     ORDER BY completed DESC, st.id`);
  return rows;
}

module.exports = { overview, daily, comparisons, planSplit, enrolmentFeed, engagement, delta };
