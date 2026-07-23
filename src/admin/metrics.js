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

/**
 * Enrolled vs attended, one row per day.
 *
 * The existing daily() answers "how many quizzes happened", which flatters a
 * shrinking cohort: ten quizzes is excellent from twelve children and dismal
 * from a hundred. This pairs each day's attendance with the number of children
 * who were actually DUE a quiz that day, so the gap between the two bars is
 * the thing you read.
 *
 * "Expected" is reconstructed per day from subscription date ranges rather than
 * from today's roster — a child who joined last Tuesday must not appear in last
 * Monday's denominator, or every historical day looks like a failure.
 */
async function participationDaily(days = 30) {
  const { rows } = await db.query(`
    WITH span AS (
      SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day')::date AS d
    ),
    expected AS (
      SELECT span.d, COUNT(DISTINCT st.id)::int AS n
        FROM span
        JOIN parents_quizpe_subscriptions s
          ON span.d BETWEEN s.plan_start_date AND s.plan_end_date AND s.is_active
        JOIN parents pa ON pa.id = s.parent_id AND pa.is_active
        JOIN students st ON st.parent_id = pa.id AND st.is_active
       GROUP BY span.d
    ),
    actual AS (
      SELECT t.quiz_date AS d,
             COUNT(*) FILTER (WHERE qs.status_code = 'completed')::int      AS completed,
             COUNT(*) FILTER (WHERE qs.status_code = 'in_progress')::int    AS started_only,
             COUNT(*) FILTER (WHERE qs.status_code IN
                     ('skipped','closed','expired','idle_closed'))::int     AS missed
        FROM quizpe_tracker t
        JOIN quizpe_status qs ON qs.id = t.status_id
       GROUP BY t.quiz_date
    )
    SELECT span.d::text                        AS date,
           COALESCE(e.n, 0)                    AS enrolled,
           COALESCE(a.completed, 0)            AS attended,
           COALESCE(a.started_only, 0)         AS started_only,
           COALESCE(a.missed, 0)               AS missed,
           CASE WHEN COALESCE(e.n,0) = 0 THEN 0
                ELSE ROUND(COALESCE(a.completed,0) * 100.0 / e.n) END::int AS attendance_pct
      FROM span
      LEFT JOIN expected e ON e.d = span.d
      LEFT JOIN actual   a ON a.d = span.d
     ORDER BY span.d`, [days]);
  return rows;
}

/**
 * Cohort health for a single day, as percentages.
 *
 * Counts and percentages answer different questions, and the percentages are
 * the ones that stay meaningful as the cohort grows: "42 quizzes today" means
 * nothing without knowing how many children were expected. Everything here is
 * therefore a share of a stated denominator, and every denominator is returned
 * alongside its percentage so a reassuring 100% built on 2 children is visible
 * as such rather than flattering.
 *
 * `day` defaults to today. Comparisons are against each child's OWN previous
 * quiz, not against yesterday's cohort — a different set of children sat
 * yesterday, so a cohort-to-cohort average would mostly measure who showed up.
 */
async function cohort(day = null) {
  const D = day || null;

  const { rows: [p] } = await db.query(`
    WITH day AS (SELECT COALESCE($1::date, CURRENT_DATE) AS d),
    -- children who SHOULD have had a quiz: active, with a live subscription
    expected AS (
      SELECT st.id
        FROM students st
        JOIN parents pa ON pa.id = st.parent_id AND pa.is_active
        JOIN parents_quizpe_subscriptions s ON s.parent_id = pa.id AND s.is_active
        CROSS JOIN day
       WHERE st.is_active AND NOT pa.service_paused
         AND day.d BETWEEN s.plan_start_date AND s.plan_end_date
       GROUP BY st.id
    ),
    today AS (
      SELECT t.student_id, qs.status_code, r.score_pct
        FROM quizpe_tracker t
        JOIN quizpe_status qs ON qs.id = t.status_id
        LEFT JOIN quiz_reports r ON r.tracker_id = t.id
        CROSS JOIN day
       WHERE t.quiz_date = day.d
    )
    SELECT
      (SELECT COUNT(*) FROM expected)::int                                          AS expected,
      -- 'scheduled' means the row exists but nothing has reached the parent
      -- yet, so counting it as delivered overstates the evening. Only statuses
      -- that imply the message actually went out count here.
      (SELECT COUNT(*) FROM today WHERE status_code <> 'scheduled')::int            AS delivered,
      (SELECT COUNT(*) FROM today WHERE status_code = 'scheduled')::int             AS pending,
      (SELECT COUNT(*) FROM today WHERE status_code IN ('in_progress','completed'))::int AS started,
      (SELECT COUNT(*) FROM today WHERE status_code = 'completed')::int             AS completed,
      (SELECT COUNT(*) FROM today WHERE status_code IN ('skipped','closed','expired','idle_closed'))::int AS missed,
      (SELECT COUNT(*) FROM today WHERE score_pct >= 80)::int                       AS excellent,
      (SELECT COUNT(*) FROM today WHERE score_pct >= 60 AND score_pct < 80)::int    AS fair,
      (SELECT COUNT(*) FROM today WHERE score_pct IS NOT NULL AND score_pct < 60)::int AS needs_help,
      (SELECT ROUND(AVG(score_pct)) FROM today WHERE score_pct IS NOT NULL)::int    AS avg_pct,
      (SELECT COUNT(*) FROM today WHERE score_pct IS NOT NULL)::int                 AS scored
  `, [D]);

  // Improvement is per child against their own previous completed quiz.
  const { rows: [t] } = await db.query(`
    WITH day AS (SELECT COALESCE($1::date, CURRENT_DATE) AS d),
    scored AS (
      SELECT t.student_id, t.quiz_date, r.score_pct,
             LAG(r.score_pct) OVER (PARTITION BY t.student_id ORDER BY t.quiz_date) AS prev_pct
        FROM quizpe_tracker t
        JOIN quiz_reports r ON r.tracker_id = t.id
       WHERE r.score_pct IS NOT NULL
    )
    SELECT
      COUNT(*) FILTER (WHERE prev_pct IS NOT NULL)::int                  AS comparable,
      COUNT(*) FILTER (WHERE score_pct > prev_pct)::int                  AS improved,
      COUNT(*) FILTER (WHERE score_pct = prev_pct)::int                  AS held,
      COUNT(*) FILTER (WHERE score_pct < prev_pct)::int                  AS declined,
      COALESCE(ROUND(AVG(score_pct - prev_pct) FILTER (WHERE prev_pct IS NOT NULL)), 0)::int AS avg_change
      FROM scored, day WHERE quiz_date = day.d
  `, [D]);

  const pct = (n, of) => (of ? Math.round((n * 100) / of) : 0);

  return {
    date: D,
    participation: {
      expected: p.expected, delivered: p.delivered, pending: p.pending,
      started: p.started, completed: p.completed, missed: p.missed,
      delivered_pct: pct(p.delivered, p.expected),
      started_pct: pct(p.started, p.expected),
      completed_pct: pct(p.completed, p.expected),
      // of those who opened it, how many saw it through
      finish_rate_pct: pct(p.completed, p.started),
    },
    scoring: {
      scored: p.scored, avg_pct: p.avg_pct || 0,
      excellent: p.excellent, excellent_pct: pct(p.excellent, p.scored),
      fair: p.fair, fair_pct: pct(p.fair, p.scored),
      needs_help: p.needs_help, needs_help_pct: pct(p.needs_help, p.scored),
    },
    trend: {
      comparable: t.comparable,
      improved: t.improved, improved_pct: pct(t.improved, t.comparable),
      held: t.held, held_pct: pct(t.held, t.comparable),
      declined: t.declined, declined_pct: pct(t.declined, t.comparable),
      avg_change: t.avg_change,
    },
  };
}

/**
 * Enrolment and participation broken down by board and grade.
 *
 * This is the view that answers "where actually are my students, and which
 * segments are quiet?" — so it deliberately returns EVERY board×grade we sell,
 * including the ones with nobody in them. Returning only populated rows would
 * hide exactly the gaps worth acting on.
 *
 * The three measures are aggregated separately and joined, never stacked as
 * joins onto students: enrolment × attempts would fan out and inflate counts.
 */
async function boardGradeBreakdown(day) {
  const d = day || null;
  const { rows } = await db.query(
    `WITH grid AS (
       SELECT b.id AS board_id, b.board_code, b.board_name,
              g.id AS grade_id, g.grade_name, g.display_order
         FROM boards b CROSS JOIN grades g
        WHERE b.is_active AND g.is_active),
     enrolled AS (
       SELECT st.board_id, st.grade_id,
              COUNT(*)::int AS students,
              COUNT(DISTINCT st.parent_id)::int AS families,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM parents_quizpe_subscriptions s
                  JOIN quizpe_plans p ON p.id = s.plan_id
                 WHERE s.parent_id = st.parent_id AND s.is_active
                   AND COALESCE(p.is_trial,false) = false
                   AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date))::int AS paid
         FROM students st WHERE st.is_active
        GROUP BY st.board_id, st.grade_id),
     today AS (
       SELECT st.board_id, st.grade_id,
              COUNT(*)::int AS delivered,
              COUNT(*) FILTER (WHERE s.status_code IN ('completed','closed'))::int AS attempted,
              COUNT(*) FILTER (WHERE s.status_code IN ('skipped','expired'))::int  AS skipped,
              COUNT(*) FILTER (WHERE s.status_code IN ('delivered','yet_to_start','in_progress'))::int AS pending
         FROM quizpe_tracker t
         JOIN quizpe_status s ON s.id = t.status_id
         JOIN students st ON st.id = t.student_id
        WHERE t.quiz_date = COALESCE($1::date, CURRENT_DATE)
        GROUP BY st.board_id, st.grade_id),
     perf AS (
       SELECT st.board_id, st.grade_id,
              ROUND(AVG(r.score_pct),1)::numeric AS avg_pct,
              COUNT(*)::int AS scored,
              COUNT(*) FILTER (WHERE r.score_pct >= 80)::int AS strong,
              COUNT(*) FILTER (WHERE r.score_pct <  50)::int AS struggling
         FROM quiz_reports r JOIN students st ON st.id = r.student_id
        WHERE r.is_active AND r.quiz_date > CURRENT_DATE - 28
        GROUP BY st.board_id, st.grade_id)
     SELECT gr.board_code, gr.board_name, gr.grade_name, gr.display_order,
            COALESCE(e.students,0)  AS students,
            COALESCE(e.families,0)  AS families,
            COALESCE(e.paid,0)      AS paid,
            COALESCE(t.delivered,0) AS delivered,
            COALESCE(t.attempted,0) AS attempted,
            COALESCE(t.skipped,0)   AS skipped,
            COALESCE(t.pending,0)   AS pending,
            COALESCE(p.avg_pct,0)   AS avg_pct,
            COALESCE(p.scored,0)    AS scored,
            COALESCE(p.strong,0)    AS strong,
            COALESCE(p.struggling,0) AS struggling
       FROM grid gr
       LEFT JOIN enrolled e ON e.board_id=gr.board_id AND e.grade_id=gr.grade_id
       LEFT JOIN today    t ON t.board_id=gr.board_id AND t.grade_id=gr.grade_id
       LEFT JOIN perf     p ON p.board_id=gr.board_id AND p.grade_id=gr.grade_id
      ORDER BY gr.board_code, gr.display_order`, [d]);

  const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return rows.map((r) => ({
    ...r,
    students: Number(r.students), families: Number(r.families), paid: Number(r.paid),
    delivered: Number(r.delivered), attempted: Number(r.attempted),
    skipped: Number(r.skipped), pending: Number(r.pending),
    avg_pct: Number(r.avg_pct), scored: Number(r.scored),
    strong: Number(r.strong), struggling: Number(r.struggling),
    attendance_pct: pctOf(Number(r.attempted), Number(r.delivered)),
  }));
}

/** Board-level roll-up of the same figures, for the summary chart. */
async function boardTotals(day) {
  const rows = await boardGradeBreakdown(day);
  const by = {};
  for (const r of rows) {
    const b = (by[r.board_code] ||= {
      board_code: r.board_code, board_name: r.board_name,
      students: 0, families: 0, paid: 0, delivered: 0, attempted: 0,
      skipped: 0, pending: 0, strong: 0, struggling: 0, scored: 0, _sum: 0,
    });
    for (const k of ['students', 'families', 'paid', 'delivered', 'attempted', 'skipped', 'pending', 'strong', 'struggling', 'scored']) b[k] += r[k];
    b._sum += r.avg_pct * r.scored;           // weight by how many were scored
  }
  return Object.values(by).map(({ _sum, ...b }) => ({
    ...b,
    avg_pct: b.scored > 0 ? Math.round((_sum / b.scored) * 10) / 10 : 0,
    attendance_pct: b.delivered > 0 ? Math.round((b.attempted / b.delivered) * 100) : 0,
  }));
}

module.exports = { overview, daily, comparisons, planSplit, enrolmentFeed, engagement, cohort, participationDaily, delta, boardGradeBreakdown, boardTotals };
