/**
 * src/whatsapp/feedback.js
 * ---------------------------------------------------------------------------
 * Asking parents for feedback, without nagging them.
 *
 *   trial plan -> after EVERY day's quiz  (short trial, we want fast signal)
 *   paid plan  -> ONCE PER WEEK           (long subscription, keep it light)
 *
 * A parent is asked at most once per period (UNIQUE on parent+type+period),
 * so restarts, second quizzes or multiple children never double-ask.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

/** Which feedback (if any) is due for this parent right now. */
async function feedbackDue(parentId, exec = db) {
  if (!parentId) return { due: false };

  const sub = (await exec.query(
    `SELECT pl.is_trial
       FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE s.parent_id = $1 AND s.is_active
      ORDER BY s.id DESC LIMIT 1`, [parentId])).rows[0];
  if (!sub) return { due: false };

  const type = sub.is_trial ? 'daily' : 'weekly';
  const planType = sub.is_trial ? 'trial' : 'paid';
  // daily -> '2026-07-19' ; weekly -> ISO week '2026-W29'
  const periodKey = (await exec.query(
    type === 'daily'
      ? `SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') k`
      : `SELECT to_char(CURRENT_DATE,'IYYY-"W"IW') k`)).rows[0].k;

  const already = (await exec.query(
    `SELECT 1 FROM feedbacks WHERE parent_id=$1 AND feedback_type=$2 AND period_key=$3`,
    [parentId, type, periodKey])).rowCount;

  return { due: !already, type, planType, periodKey };
}

/**
 * Mark the period as ASKED (rating stays NULL until they tap). Without this a
 * parent who ignores the prompt would be asked again the next day.
 */
async function markAsked({ parentId, studentId, trackerId, mobile, userName, type, planType, periodKey }, exec = db) {
  const { rows } = await exec.query(
    `INSERT INTO feedbacks (parent_id, student_id, tracker_id, mobile_number, user_name,
                            feedback_type, plan_type, period_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (parent_id, feedback_type, period_key) DO NOTHING
     RETURNING id`,
    [parentId, studentId, trackerId, mobile, userName, type, planType, periodKey]);
  return rows[0]?.id || null;
}

/** Record the tapped rating (creates the row); returns the feedback id. */
async function saveRating({ parentId, studentId, trackerId, mobile, userName, rating, type, planType, periodKey }, exec = db) {
  const { rows } = await exec.query(
    `INSERT INTO feedbacks (parent_id, student_id, tracker_id, mobile_number, user_name,
                            rating, feedback_type, plan_type, period_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (parent_id, feedback_type, period_key) DO UPDATE
       SET rating = EXCLUDED.rating, user_name = COALESCE(EXCLUDED.user_name, feedbacks.user_name),
           tracker_id = COALESCE(EXCLUDED.tracker_id, feedbacks.tracker_id), modified_at = now()
     RETURNING id`,
    [parentId, studentId, trackerId, mobile, userName, rating, type, planType, periodKey]);
  return rows[0].id;
}

/** Attach the optional free-text message to an existing feedback row. */
async function saveMessage(feedbackId, message, exec = db) {
  const { rowCount } = await exec.query(
    `UPDATE feedbacks SET message=$2, modified_at=now() WHERE id=$1`,
    [feedbackId, String(message).trim().slice(0, 1000)]);
  return rowCount > 0;
}

/** Copy for the ask, tuned to the cadence. */
function askText(type, studentName) {
  return type === 'daily'
    ? `_How was today's quiz for ${studentName || 'your child'}?_`
    : `_How has this week been for ${studentName || 'your child'}?_`;
}

module.exports = { feedbackDue, markAsked, saveRating, saveMessage, askText };
