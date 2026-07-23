/**
 * src/whatsapp/userContext.js
 * ---------------------------------------------------------------------------
 * Resolves WHO is messaging us, in one query, before any menu is built.
 *
 * A mobile number is not simply "new" or "existing" — these all behave
 * differently and each needs its own menu:
 *
 *   NEW              no parents row at all           → offer free trial
 *   INCOMPLETE       parent exists, no student       → resume signup
 *   NO_SUBSCRIPTION  student exists, never paid      → offer trial/plans
 *   TRIAL_ACTIVE     on TRY0, still inside dates     → normal menu
 *   ACTIVE           on a paid plan, inside dates    → normal menu
 *   EXPIRED          had a subscription, now lapsed  → renew
 *
 * trial_used matters on its own: policy is ONE free trial per mobile number,
 * so an EXPIRED user who already used the trial must not be offered it again.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

/** Normalise 919886122415 / +91-98861 22415 / 9886122415 -> 9886122415 */
function normaliseMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * @param rawMobile  number in any format
 * @param exec       optional pg client — pass one when calling inside a
 *                   transaction, otherwise the pool can't see uncommitted rows
 */
async function getUserContext(rawMobile, exec = db) {
  const mobile = normaliseMobile(rawMobile);

  const { rows } = await exec.query(
    `SELECT p.id                AS parent_id,
            p.parent_name,
            p.is_active         AS parent_active,
            p.state_code,
            s.id                AS subscription_id,
            s.plan_start_date,
            s.plan_end_date,
            s.quiz_time,
            s.is_active         AS subscription_active,
            pl.plan_code,
            pl.plan_name,
            pl.is_trial,
            pl.student_count,
            (s.id IS NOT NULL AND s.is_active
              AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS in_window,
            (SELECT COUNT(*)::int FROM students st
              WHERE st.parent_id = p.id AND st.is_active)                     AS student_count_actual,
            EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s2
                      JOIN quizpe_plans p2 ON p2.id = s2.plan_id
                     WHERE s2.parent_id = p.id AND p2.is_trial)               AS trial_used
       FROM parents p
       LEFT JOIN LATERAL (
            SELECT * FROM parents_quizpe_subscriptions x
             WHERE x.parent_id = p.id
             ORDER BY x.plan_end_date DESC, x.id DESC
             LIMIT 1
       ) s ON true
       LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE p.parent_mobile_number = $1`,
    [mobile],
  );

  // is a free trial plan currently on offer at all?
  const trialPlan = (await exec.query(
    `SELECT duration FROM quizpe_plans WHERE is_trial AND is_active ORDER BY id LIMIT 1`)).rows[0];
  const trialOffered = !!trialPlan;
  const trialDays = trialPlan?.duration || null;

  if (!rows.length) {
    return { mobile, exists: false, status: 'NEW', trialUsed: false, canStartTrial: trialOffered, trialDays };
  }

  const r = rows[0];
  let status;
  if (r.student_count_actual === 0) status = 'INCOMPLETE';
  else if (!r.subscription_id) status = 'NO_SUBSCRIPTION';
  else if (r.in_window) status = r.is_trial ? 'TRIAL_ACTIVE' : 'ACTIVE';
  else status = 'EXPIRED';

  const daysLeft = r.plan_end_date
    ? Math.ceil((new Date(r.plan_end_date) - new Date()) / 864e5) : null;

  return {
    mobile,
    exists: true,
    status,
    parentId: r.parent_id,
    parentName: r.parent_name,
    stateCode: r.state_code,
    subscriptionId: r.subscription_id,
    planCode: r.plan_code,
    planName: r.plan_name,
    isTrial: r.is_trial,
    startDate: r.plan_start_date,
    endDate: r.plan_end_date,
    quizTime: r.quiz_time,
    daysLeft,
    studentCount: r.student_count_actual,
    seatLimit: r.student_count,
    trialUsed: r.trial_used,
    trialDays,
    // policy: one free trial per mobile number
    canStartTrial: trialOffered && !r.trial_used && ['INCOMPLETE', 'NO_SUBSCRIPTION'].includes(status),
    isSubscribed: ['TRIAL_ACTIVE', 'ACTIVE'].includes(status),
  };
}

/** Children of this parent, with board/grade — used by menus and quiz delivery. */
async function getStudents(parentId, exec = db) {
  if (!parentId) return [];
  const { rows } = await exec.query(
    `SELECT st.id, st.student_name, st.school_name, b.board_code, g.grade_name
       FROM students st
       JOIN boards b ON b.id = st.board_id
       JOIN grades g ON g.id = st.grade_id
      WHERE st.parent_id = $1 AND st.is_active
      ORDER BY st.id`,
    [parentId],
  );
  return rows;
}

/**
 * The main menu, branched by status. WhatsApp lists allow max 10 rows,
 * so this must never exceed 10 entries.
 */
function buildMainMenu(ctx) {
  // NOTE: WhatsApp truncates list row titles at 24 chars — keep them short and
  // put the detail in `description` (72 chars).
  const rows = [];
  // free trial first when it's on offer and unused — it's the easiest yes
  if (ctx.canStartTrial) {
    rows.push({ id: 'start_trial', title: '🎁 Start free trial',
                description: `${ctx.trialDays || 7} days free · no payment details needed` });
  }
  if (!ctx.isSubscribed && ctx.status !== 'EXPIRED') {
    rows.push({ id: 'subscribe', title: '🚀 Subscribe',
                description: 'Start daily quizzes — from just ₹99' });
  }
  if (ctx.status === 'EXPIRED') {
    rows.push({ id: 'renew', title: '🔄 Renew plan',
                description: 'Your plan ended — resubscribe to continue' });
  }
  if (ctx.isSubscribed) {
    rows.push({ id: 'start_quiz', title: '▶️ Start quiz now',
                description: "Today's quiz — opens at your daily quiz time" });
  }
  rows.push(
    { id: 'my_subscription', title: '📄 My subscription', description: 'Plan, validity and children enrolled' },
    { id: 'quiz_report',     title: '📊 Quiz reports',    description: 'Recent scores and progress' },
    { id: 'quiz_schedule',   title: '📅 Quiz schedule',   description: 'When the next quizzes arrive' },
  );
  // Only offered to enrolled parents: someone still deciding has nothing to
  // recommend yet, and asking them to would be presumptuous.
  if (ctx.exists) {
    rows.push({ id: 'refer_friend', title: '🎁 Refer a friend',
                description: 'You both get free days when they subscribe' });
  }
  rows.push(
    { id: 'view_plans',      title: '💎 Premium plans',   description: 'Upgrade from just ₹99' },
    { id: 'support',         title: '💬 Support',         description: 'Get help from our team' },
  );
  return rows.slice(0, 10);
}

module.exports = { getUserContext, getStudents, buildMainMenu, normaliseMobile };
