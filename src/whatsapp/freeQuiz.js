/**
 * src/whatsapp/freeQuiz.js
 * ---------------------------------------------------------------------------
 * Admin-granted FREE quiz ("free quiz slot").
 *
 * Exists to make good when a quiz did not reach a family because of a fault on
 * our side. An admin grants a quiz to a MOBILE NUMBER; the parent taps
 * "▶️ Start Quiz now" on the template and gets a real quiz — no payment, no
 * invoice, but the usual report and feedback afterwards.
 *
 * Two things make this different from the paid paths, and both are deliberate:
 *
 *   • The permission hangs on the NUMBER, not a subscription — so it works for a
 *     brand-new number with no parent or student row yet, which is exactly the
 *     case a subscription check cannot express.
 *   • It ignores the daily slot cap. The point is to replace a quiz they should
 *     already have had, so "you've used today's quizzes" would defeat it.
 *
 * Everything else is an ordinary quiz: quiz_type stays 'daily', so mastery,
 * streaks, the report and the feedback ask all behave exactly as normal. Only
 * `is_free` is set, purely so revenue reporting stays honest.
 * ---------------------------------------------------------------------------
 */

const db = require('./../database/connectDB');
const quiz = require('./quiz');

/** The live grant for a number, if any. Expired ones are never returned. */
async function pendingGrant(mobile, exec = db) {
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (!m) return null;
  const { rows } = await exec.query(
    `SELECT * FROM free_quiz_grants
      WHERE mobile_number LIKE '%'||$1 AND status='pending' AND expires_at > now()
      ORDER BY id DESC LIMIT 1`, [m]);
  return rows[0] || null;
}

/** Expire a grant that has run out, so the admin list stays truthful. */
async function expireStale(exec = db) {
  await exec.query(
    `UPDATE free_quiz_grants SET status='expired', modified_at=now()
      WHERE status='pending' AND expires_at <= now()`).catch(() => {});
}

/**
 * Build the tracker for a granted quiz. Uses the next free daily slot WITHOUT
 * checking the entitlement cap — see the note at the top of this file.
 */
async function buildFreeTracker(studentId, questionCount, exec = db) {
  const subj = (await exec.query(
    `SELECT id FROM subjects WHERE subject_code=$1 AND is_active`, [quiz.BASE_SUBJECT])).rows[0];
  if (!subj) throw new Error('base subject (MATHS) not found');

  const slot = (await exec.query(
    `SELECT COALESCE(MAX(quiz_slot), 0) + 1 AS slot FROM quizpe_tracker
      WHERE student_id=$1 AND subject_id=$2 AND quiz_date=CURRENT_DATE
        AND NOT COALESCE(is_instant,false)`, [studentId, subj.id])).rows[0].slot;

  const { rows } = await exec.query(
    `INSERT INTO quizpe_tracker
       (student_id, subject_id, status_id, question_count, quiz_type, quiz_slot, is_free)
     VALUES ($1,$2,(SELECT id FROM quizpe_status WHERE status_code='scheduled'),$3,'daily',$4,true)
     RETURNING id`, [studentId, subj.id, questionCount, slot]);
  return { trackerId: rows[0].id, subjectId: subj.id };
}

/**
 * Last-resort fill. The adaptive engine only ever serves UNSEEN questions; a
 * child who has exhausted their grade would otherwise get nothing — and this is
 * an apology quiz, so it must never come up empty. Repeats are allowed here.
 */
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
       ) q`, [trackerId, studentId, subjectId, count]);
  if (!ins.rowCount) return false;
  await exec.query(
    `UPDATE quizpe_tracker SET status_id=(SELECT id FROM quizpe_status WHERE status_code='in_progress'),
            modified_at=now() WHERE id=$1`, [trackerId]);
  return true;
}

/**
 * Start a granted quiz for one child and send the link. Consumes the grant only
 * once the quiz genuinely exists, so a failure part-way leaves the grant intact
 * and the parent can tap again rather than losing what they were owed.
 */
async function startFreeQuiz(sessionId, mobile, studentId, grant) {
  const wa = require('./client');
  const count = grant?.question_count || quiz.QUESTIONS_PER_QUIZ;

  const { trackerId, subjectId } = await buildFreeTracker(studentId, count);
  const r = await quiz.startQuiz(trackerId);
  if (r.error === 'NO_QUESTIONS') {
    const ok = await fallbackFill(trackerId, studentId, subjectId, count);
    if (!ok) {
      await wa.sendText(sessionId, mobile,
        `😕 We couldn't build the quiz just now. Please type *menu* and contact *Support* — we'll sort it out.`);
      return { error: 'NO_QUESTIONS' };
    }
  } else if (r.error) {
    await wa.sendText(sessionId, mobile,
      `😕 We couldn't build the quiz just now. Please try again in a moment, or type *menu*.`);
    return { error: r.error };
  }

  const qn = await quiz.nextQuestion(trackerId);
  if (!qn) return { trackerId, done: true };

  const name = (await db.query(`SELECT student_name FROM students WHERE id=$1`, [studentId]))
    .rows[0]?.student_name || 'your child';

  if (grant?.id) {
    await db.query(
      `UPDATE free_quiz_grants SET status='consumed', consumed_at=now(),
              tracker_id=$2, student_id=COALESCE(student_id,$3), modified_at=now()
        WHERE id=$1`, [grant.id, trackerId, studentId]).catch(() => {});
  }

  const { createQuizLink } = require('./../routers/quizWebRouter');
  const { url } = await createQuizLink(sessionId, mobile, trackerId);
  await wa.sendCtaUrl(sessionId, mobile, {
    header: `🎁 A free quiz for ${name}`.slice(0, 60),
    body: `🙏 *Sorry the last quiz didn't reach you.*\n\n`
        + `Here's a *free quiz* for *${name}* — ${count} questions, about 5 minutes.\n\n`
        + `Tap below to begin. The score and full report come straight back here. 🚀`,
    displayText: '▶️ Start quiz',
    url,
    footer: 'QuizPe by ServerPe App Solutions',
  });
  return { trackerId, url };
}

module.exports = { pendingGrant, expireStale, buildFreeTracker, fallbackFill, startFreeQuiz };
