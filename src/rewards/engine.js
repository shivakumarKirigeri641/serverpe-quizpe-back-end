/**
 * src/rewards/engine.js
 * ---------------------------------------------------------------------------
 * Streaks, badges, the leaderboard and certificate eligibility.
 *
 * Everything here is DERIVED from quizpe_tracker and quiz_reports rather than
 * kept in a running counter. A counter drifts the moment a job is retried, a
 * quiz is re-scored or a row is corrected by hand — and a child who is told
 * their 30-day streak is broken when it is not will not come back. Deriving is
 * a little more work per query and always tells the truth.
 *
 * A "day counted" is a quiz the child actually COMPLETED. Delivered-but-ignored
 * does not keep a streak alive, or the streak means nothing.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

/** Only these count as the child having shown up. */
const DONE = `('completed','closed')`;

/* --------------------------------------------------------------- streaks -- */
/**
 * Current and longest run of consecutive days completed.
 *
 * Uses the classic gaps-and-islands trick: subtracting a dense row number from
 * the date leaves the same value for every date in a consecutive run, so
 * grouping by it gives the runs.
 *
 * Today is treated gently. A child whose quiz arrives at 8 PM has not "broken"
 * their streak at 9 AM, so a run ending yesterday still counts as current.
 */
async function streak(studentId, client = db) {
  const { rows } = await client.query(
    `WITH done AS (
       SELECT DISTINCT t.quiz_date AS d
         FROM quizpe_tracker t
         JOIN quizpe_status s ON s.id = t.status_id
        WHERE t.student_id = $1 AND s.status_code IN ${DONE}),
     runs AS (
       SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM done),
     spans AS (
       SELECT grp, COUNT(*)::int AS len, MIN(d) AS started, MAX(d) AS ended
         FROM runs GROUP BY grp)
     SELECT
       COALESCE(MAX(len), 0)::int AS longest,
       COALESCE(MAX(len) FILTER (WHERE ended >= CURRENT_DATE - 1), 0)::int AS current,
       -- as text, so it does not come back as a Date that shifts a day when
       -- serialised to UTC from IST
       to_char(MAX(ended), 'YYYY-MM-DD') AS last_done,
       (SELECT COUNT(*)::int FROM done) AS total_days
       FROM spans`, [studentId]);
  const r = rows[0] || {};
  return {
    current: r.current || 0,
    longest: r.longest || 0,
    total_days: r.total_days || 0,
    last_done: r.last_done || null,
  };
}

/* ---------------------------------------------------------------- totals -- */
async function stats(studentId, client = db) {
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN quizpe_status s ON s.id=t.status_id
         WHERE t.student_id=$1 AND s.status_code IN ${DONE})              AS quizzes_done,
       (SELECT COUNT(*)::int FROM quiz_reports WHERE student_id=$1 AND is_active
          AND score_correct = score_total AND score_total > 0)            AS perfect_quizzes,
       (SELECT COALESCE(ROUND(AVG(score_pct),1),0)::numeric FROM quiz_reports
         WHERE student_id=$1 AND is_active)                               AS accuracy_pct,
       (SELECT COALESCE(SUM(score_correct),0)::int FROM quiz_reports
         WHERE student_id=$1 AND is_active)                               AS correct_answers,
       (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN quizpe_status s ON s.id=t.status_id
         WHERE t.student_id=$1 AND s.status_code IN ('skipped','expired')) AS missed`, [studentId]);
  const r = rows[0];
  return {
    quizzes_done: r.quizzes_done,
    perfect_quizzes: r.perfect_quizzes,
    accuracy_pct: Number(r.accuracy_pct),
    correct_answers: r.correct_answers,
    missed: r.missed,
  };
}

/* ---------------------------------------------------------------- badges -- */
/**
 * Awards any badge whose rule the child now satisfies.
 *
 * Insert-only and idempotent: a badge already held is left alone (so its
 * earned_on date never moves), and a badge is never taken away. Losing a badge
 * because of a re-scored quiz would feel like a punishment for our own bug.
 *
 * @returns the badges newly earned by this call, for announcing on WhatsApp
 */
async function awardBadges(studentId, client = db) {
  const [st, sk] = [await stats(studentId, client), await streak(studentId, client)];
  const { rows: catalogue } = await client.query(
    `SELECT id, badge_code, badge_name, description, icon, tier, rule_type, rule_value
       FROM badges WHERE is_active ORDER BY display_order`);

  const earned = [];
  for (const b of catalogue) {
    let ok = false;
    switch (b.rule_type) {
      case 'streak':        ok = sk.longest >= b.rule_value; break;
      case 'quizzes_done':  ok = st.quizzes_done >= b.rule_value; break;
      case 'perfect_quiz':  ok = st.perfect_quizzes >= b.rule_value; break;
      // accuracy needs volume behind it, or one lucky quiz mints a badge
      case 'accuracy':      ok = st.quizzes_done >= 20 && st.accuracy_pct >= b.rule_value; break;
      case 'early_finish':  ok = false; break;   // not tracked yet; badge stays unearned
      default:              ok = false;
    }
    if (!ok) continue;
    const ins = await client.query(
      `INSERT INTO student_badges (student_id, badge_id) VALUES ($1,$2)
       ON CONFLICT (student_id, badge_id) DO NOTHING RETURNING id`, [studentId, b.id]);
    if (ins.rowCount) earned.push(b);
  }
  return earned;
}

async function badgesOf(studentId, client = db) {
  const { rows } = await client.query(
    `SELECT b.badge_code, b.badge_name, b.description, b.icon, b.tier, sb.earned_on
       FROM student_badges sb JOIN badges b ON b.id = sb.badge_id
      WHERE sb.student_id = $1 ORDER BY sb.earned_on DESC, b.display_order`, [studentId]);
  return rows;
}

/* ----------------------------------------------------------- leaderboard -- */
/**
 * Ranked within the child's OWN board and grade — never a single global list.
 *
 * A Grade 2 child cannot meaningfully be ranked against a Grade 9 child, and a
 * table topped by children who joined months earlier would tell a newcomer they
 * are last and always will be. Ranking is by current streak first, because
 * turning up is the habit we actually want to build, and accuracy only breaks
 * ties. That keeps it winnable by effort rather than by raw ability.
 *
 * Names are shortened by the caller before display — see publicName().
 */
async function leaderboard({ boardId, gradeId, limit = 10, days = 28 }, client = db) {
  const { rows } = await client.query(
    // The two measures are aggregated SEPARATELY and then joined. Joining both
    // straight onto students would fan out — 27 completed days × 27 reports is
    // 729 rows, and SUM(score_correct) would report nine times the real points.
    `WITH days AS (
       SELECT t.student_id, COUNT(DISTINCT t.quiz_date)::int AS days_done
         FROM quizpe_tracker t JOIN quizpe_status s ON s.id = t.status_id
        WHERE s.status_code IN ${DONE}
          AND t.quiz_date > CURRENT_DATE - $3::int
        GROUP BY t.student_id),
     scores AS (
       SELECT r.student_id,
              ROUND(AVG(r.score_pct), 1)::numeric AS accuracy,
              SUM(r.score_correct)::int           AS points
         FROM quiz_reports r
        WHERE r.is_active AND r.quiz_date > CURRENT_DATE - $3::int
        GROUP BY r.student_id),
     agg AS (
       SELECT st.id AS student_id, st.student_name, d.days_done,
              COALESCE(sc.accuracy, 0)::numeric AS accuracy,
              COALESCE(sc.points, 0)::int       AS points
         FROM students st
         JOIN days d ON d.student_id = st.id
         LEFT JOIN scores sc ON sc.student_id = st.id
        WHERE st.is_active AND st.board_id = $1 AND st.grade_id = $2)
     SELECT *, RANK() OVER (ORDER BY days_done DESC, accuracy DESC, points DESC)::int AS rank
       FROM agg ORDER BY rank, student_name LIMIT $4`, [boardId, gradeId, days, limit]);
  return rows;
}

/**
 * "Aarav K." — enough for a child to recognise themselves, not enough for a
 * stranger to identify them. These boards are shown to other families, so a
 * full name has no business appearing on one.
 */
function publicName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (!parts[0]) return 'A student';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

/* ---------------------------------------------------- certificates ------- */
/**
 * The current academic year's consistency window: enrolment → 31 March.
 *
 * The school year runs June–March, so 31 March is the finish line for everyone.
 * A child who joined in June has a long run to it; one who joined in January has
 * a short one — same finish line, same reward, and only unbroken effort counts.
 *
 * @param joinedAt the child's (or plan's) start date
 * @returns {{ from, to }} 'YYYY-MM-DD', where `to` is the coming 31 March
 */
function academicYearWindow(joinedAt, today = new Date()) {
  const d = new Date(joinedAt || today);
  // If we are already past 1 April, the finish line is next year's 31 March.
  const y = today.getMonth() >= 3 ? today.getFullYear() + 1 : today.getFullYear();
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: iso(d), to: `${y}-03-31` };
}

/**
 * Whether a child has earned the free consistency certificate.
 *
 * "Full consistency" is read strictly, because a certificate that everyone gets
 * is worth nothing: every single quiz in the window attempted, and no gap in
 * cover. `minDays` is the floor below which the run is too short to certify —
 * a child who joined on 28 March has not shown the consistency this rewards,
 * even though they reached 31 March unbroken.
 */
async function certificateEligibility(studentId, { from, to, minDays = 40 }, client = db) {
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE s.status_code IN ${DONE})::int          AS done,
       COUNT(*) FILTER (WHERE s.status_code IN ('skipped','expired'))::int AS missed,
       COUNT(*)::int                                                   AS delivered
       FROM quizpe_tracker t JOIN quizpe_status s ON s.id = t.status_id
      WHERE t.student_id = $1 AND t.quiz_date BETWEEN $2::date AND $3::date`,
    [studentId, from, to]);
  const r = rows[0];

  // A gap in cover disqualifies: the offer rewards unbroken participation, and
  // letting a plan lapse then rejoining is exactly the gap it excludes.
  const { rows: gaps } = await client.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT s.plan_end_date,
              LEAD(s.plan_start_date) OVER (ORDER BY s.plan_start_date) AS next_start
         FROM parents_quizpe_subscriptions s
         JOIN students st ON st.parent_id = s.parent_id
        WHERE st.id = $1 AND s.plan_end_date >= $2::date AND s.plan_start_date <= $3::date
     ) x WHERE next_start IS NOT NULL AND next_start > plan_end_date + 1`,
    [studentId, from, to]);

  const sk = await streak(studentId, client);
  const st = await stats(studentId, client);
  const eligible = r.delivered >= minDays && r.missed === 0 && gaps[0].n === 0 && r.done >= minDays;

  return {
    eligible,
    quizzes_taken: r.done,
    missed: r.missed,
    delivered: r.delivered,
    renewal_gaps: gaps[0].n,
    longest_streak: sk.longest,
    accuracy_pct: st.accuracy_pct,
    // why they missed out, so the message can be specific rather than a flat no
    reason: eligible ? null
      : r.delivered < minDays ? 'not_enough_days'
      : r.missed > 0 ? 'missed_quizzes'
      : gaps[0].n > 0 ? 'renewal_gap'
      : 'incomplete',
  };
}

module.exports = { streak, stats, awardBadges, badgesOf, leaderboard, publicName,
  certificateEligibility, academicYearWindow };
