/**
 * src/whatsapp/instantQuiz.js
 * ---------------------------------------------------------------------------
 * Instant Quiz — a pay-per-quiz (₹9 + GST), no-subscription, no-validity quiz.
 * A parent pays, gets 12 Maths questions immediately, completes, and can pay
 * again for another. Isolated from the daily-slot machinery via the tracker's
 * `is_instant` flag, so it never affects scheduled daily quizzes.
 *
 * It reuses the existing quiz engine (quiz.startQuiz → nextQuestion →
 * submitAnswer → finishQuiz), so scoring, mastery, streaks and the daily-report
 * PDF all behave exactly as a normal quiz — just one-off and paid.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const quiz = require('./quiz');
const { instantConfig } = require('../get/instantConfig');

/** Create a fresh instant tracker (Maths) with a distinct high slot (10+). The
    question count is admin-configurable (app_settings.instant_quiz). */
async function buildInstantTracker(studentId, exec = db) {
  const { questions } = await instantConfig(exec);
  const subj = (await exec.query(
    `SELECT id FROM subjects WHERE subject_code=$1 AND is_active`, [quiz.BASE_SUBJECT])).rows[0];
  if (!subj) throw new Error('base subject (MATHS) not found');
  // Distinct slot per instant quiz today (10, 11, …) — never collides with the
  // daily slots (1..3) or the daily MAX(quiz_slot) logic (which excludes instant).
  const slot = (await exec.query(
    `SELECT GREATEST(COALESCE(MAX(quiz_slot), 0), 9) + 1 AS slot FROM quizpe_tracker
      WHERE student_id=$1 AND subject_id=$2 AND quiz_date=CURRENT_DATE AND is_instant`,
    [studentId, subj.id])).rows[0].slot;
  const { rows } = await exec.query(
    `INSERT INTO quizpe_tracker (student_id, subject_id, status_id, question_count, quiz_type, quiz_slot, is_instant)
     VALUES ($1,$2,(SELECT id FROM quizpe_status WHERE status_code='scheduled'),$3,'instant',$4,true)
     RETURNING id`, [studentId, subj.id, questions, slot]);
  return { trackerId: rows[0].id, subjectId: subj.id, questions };
}

/** Fallback: fill with any N questions for the child's board/grade/medium (repeats
    allowed). Used only when the adaptive engine has no UNSEEN questions left — a
    paying parent must always receive their 12 questions. */
async function fallbackFill(trackerId, studentId, subjectId, count, exec = db) {
  const ins = await exec.query(
    `INSERT INTO student_quizpe_histories (tracker_id, question_id, serial_number, status_id)
     SELECT $1, q.id, ROW_NUMBER() OVER (ORDER BY q.rnd),
            (SELECT id FROM quizpe_status WHERE status_code='scheduled')
       FROM (
         SELECT qb.id, random() AS rnd
           FROM question_bank qb
           JOIN students st ON st.id = $2
          WHERE qb.subject_id = $3 AND qb.is_active
            AND qb.board_id = st.board_id AND qb.grade_id = st.grade_id AND qb.medium_id = st.medium_id
          ORDER BY random() LIMIT $4
       ) q`,
    [trackerId, studentId, subjectId, count]);
  if (!ins.rowCount) return false;
  await exec.query(
    `UPDATE quizpe_tracker SET status_id=(SELECT id FROM quizpe_status WHERE status_code='in_progress'), modified_at=now()
      WHERE id=$1`, [trackerId]);
  return true;
}

/** Build + start + send the first question of a new instant quiz. */
async function startInstantQuiz(sessionId, mobile, studentId) {
  const wa = require('./client');
  const { trackerId, subjectId, questions } = await buildInstantTracker(studentId);
  const r = await quiz.startQuiz(trackerId);
  if (r.error === 'NO_QUESTIONS') {
    const ok = await fallbackFill(trackerId, studentId, subjectId, questions);
    if (!ok) {
      await wa.sendText(sessionId, mobile,
        `😕 We couldn't find questions for this grade right now. Please contact *Support* (type *menu*) — we'll sort it out.`);
      return { error: 'NO_QUESTIONS', trackerId };
    }
  } else if (r.error) {
    await wa.sendText(sessionId, mobile, `😕 Couldn't build the quiz just now. Please try again in a moment, or type *menu*.`);
    return { error: r.error, trackerId };
  }
  const qn = await quiz.nextQuestion(trackerId);
  if (!qn) return { trackerId, done: true };
  await wa.sendText(sessionId, mobile, `⚡ *Your Instant Quiz is ready!* ${questions} questions — let's go. 🚀`);
  await quiz.sendQuestion(sessionId, mobile, trackerId, qn);
  return { trackerId };
}

/** An unfinished instant quiz for this student today (enforces one-at-a-time). */
async function openInstantTracker(studentId, exec = db) {
  const { rows } = await exec.query(
    `SELECT t.id FROM quizpe_tracker t JOIN quizpe_status qs ON qs.id=t.status_id
      WHERE t.student_id=$1 AND t.is_instant AND t.quiz_date=CURRENT_DATE
        AND qs.status_code IN ('scheduled','delivered','yet_to_start','in_progress')
      ORDER BY t.id DESC LIMIT 1`, [studentId]);
  return rows[0]?.id || null;
}

module.exports = { buildInstantTracker, startInstantQuiz, openInstantTracker };
