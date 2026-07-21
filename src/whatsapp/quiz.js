/**
 * src/whatsapp/quiz.js
 * ---------------------------------------------------------------------------
 * The quiz loop: start → Q1..Q10 → score.
 *
 * NOTE: an MCQ has 4 options but WhatsApp reply buttons max out at 3, so the
 * options are sent as an interactive LIST (up to 10 rows), not buttons.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const wa = require('./client');
const mastery = require('./mastery');
const jobs = require('../jobs/jobQueue');

const QUESTIONS_PER_QUIZ = 10;   // default; per-quiz count lives on quizpe_tracker.question_count
const LETTERS = ['A', 'B', 'C', 'D'];
const BASE_SUBJECT = 'MATHS';   // included in every plan; extras come from add-ons

/** Academic serving month: Jun..Mar (Apr/May fall back to June). */
function servingMonth(d = new Date()) {
  const m = d.getMonth() + 1;
  return (m === 4 || m === 5) ? 6 : m;
}
function academicYear(d = new Date()) {
  return d.getMonth() + 1 >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

/**
 * Every subject a student is entitled to: the base plan subject (Maths) plus
 * any active add-on subjects bought for that child.
 */
async function subjectsForStudent(studentId, exec = db) {
  // Only subjects that (a) are the base subject or a purchased add-on AND
  // (b) actually apply to this student's grade (grade_subjects). So a Grade-1
  // child never gets Science, and a Grade-6 child never gets EVS.
  const { rows } = await exec.query(
    `WITH kid AS (SELECT grade_id FROM students WHERE id = $1)
     SELECT s.id, s.subject_code, s.subject_name, true AS is_base
       FROM subjects s
       JOIN grade_subjects gs ON gs.subject_id = s.id AND gs.grade_id = (SELECT grade_id FROM kid) AND gs.is_active
      WHERE s.subject_code = $2 AND s.is_active
     UNION
     SELECT s.id, s.subject_code, s.subject_name, false
       FROM student_addons_subscriptions sas
       JOIN quizpe_addons a ON a.id = sas.addon_id
       JOIN subjects s      ON s.id = a.subject_id
       JOIN grade_subjects gs ON gs.subject_id = s.id AND gs.grade_id = (SELECT grade_id FROM kid) AND gs.is_active
      WHERE sas.student_id = $1 AND sas.is_active AND a.is_active AND s.is_active
     ORDER BY is_base DESC, subject_code`,
    [studentId, BASE_SUBJECT]);
  return rows;
}

/**
 * Step 2 — create one 'scheduled' tracker row per subject for today.
 * Idempotent: the UNIQUE (student_id, subject_id, quiz_date) constraint means
 * re-running (or a restart) never duplicates a day's quizzes.
 */
async function scheduleDailyQuizzes(studentId, exec = db, opts = {}) {
  // Quiz length adapts per child+subject: 10 when doing well, up to 20 when
  // they're carrying unmastered chapters. A test day can override explicitly.
  const quizType = opts.quizType || 'daily';

  const subjects = await subjectsForStudent(studentId, exec);
  const created = [];
  for (const s of subjects) {
    const questionCount = opts.questionCount
      || await mastery.recommendedQuestionCount(studentId, s.id, exec);
    const { rows } = await exec.query(
      `INSERT INTO quizpe_tracker (student_id, subject_id, status_id, question_count, quiz_type)
       VALUES ($1,$2,(SELECT id FROM quizpe_status WHERE status_code='scheduled'),$3,$4)
       ON CONFLICT (student_id, subject_id, quiz_date) DO NOTHING
       RETURNING id`,
      [studentId, s.id, questionCount, quizType]);
    created.push({ subject: s.subject_code, trackerId: rows[0]?.id || null, questionCount, alreadyExisted: !rows[0] });
  }
  return { subjects, created };
}

/** Today's trackers for a student that are not finished yet. */
async function pendingTrackers(studentId) {
  const { rows } = await db.query(
    `SELECT t.id, t.quiz_date, t.question_count, t.quiz_type,
            s.subject_code, s.subject_name, qs.status_code
       FROM quizpe_tracker t
       JOIN subjects s       ON s.id = t.subject_id
       JOIN quizpe_status qs ON qs.id = t.status_id
      WHERE t.student_id = $1 AND t.quiz_date = CURRENT_DATE
        AND qs.status_code IN ('scheduled','delivered','yet_to_start','in_progress')
      ORDER BY (s.subject_code = $2) DESC, s.subject_code`,
    [studentId, BASE_SUBJECT]);
  return rows;
}

/**
 * Step 3 — fill a scheduled tracker with QUESTIONS_PER_QUIZ questions the
 * student has NEVER been asked before, all at status 'scheduled'.
 */
async function startQuiz(trackerId) {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    const t = (await c.query(
      `SELECT t.id, t.student_id, t.subject_id, t.question_count, t.quiz_type, s.subject_code
         FROM quizpe_tracker t JOIN subjects s ON s.id = t.subject_id
        WHERE t.id = $1 FOR UPDATE`, [trackerId])).rows[0];
    if (!t) { await c.query('ROLLBACK'); return { error: 'NO_TRACKER' }; }
    const wanted = t.question_count || QUESTIONS_PER_QUIZ;

    const existing = (await c.query(
      `SELECT COUNT(*)::int n FROM student_quizpe_histories WHERE tracker_id=$1`, [trackerId])).rows[0].n;

    if (existing === 0) {
      // Adaptive selection: mostly the child's current (frontier) chapter, plus
      // spaced revision of mastered chapters — all unseen, no repeats ever.
      const { ids, frontierChapter } = await mastery.selectQuestions(t.student_id, t.subject_id, wanted, c);
      if (!ids.length) { await c.query('ROLLBACK'); return { error: 'NO_QUESTIONS' }; }

      await c.query(
        `INSERT INTO student_quizpe_histories (tracker_id, question_id, serial_number, status_id)
         SELECT $1, q.id, ROW_NUMBER() OVER (ORDER BY ord),
                (SELECT id FROM quizpe_status WHERE status_code='scheduled')
           FROM unnest($2::bigint[]) WITH ORDINALITY AS q(id, ord)`,
        [trackerId, ids]);

      if (ids.length < wanted) {
        console.warn(`[quiz] student ${t.student_id} ${t.subject_code}: wanted ${wanted}, only ${ids.length} unseen (frontier: ${frontierChapter})`);
      }
    }

    await c.query(
      `UPDATE quizpe_tracker
          SET status_id=(SELECT id FROM quizpe_status WHERE status_code='in_progress'), modified_at=now()
        WHERE id=$1`, [trackerId]);

    await c.query('COMMIT');
    return { trackerId, resumed: existing > 0 };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** The next unanswered question (with the quiz's total count), or null when done. */
async function nextQuestion(trackerId) {
  const { rows } = await db.query(
    `SELECT h.id, h.serial_number, qb.question_whatsapp, qb.chapter,
            qb.option_a, qb.option_b, qb.option_c, qb.option_d,
            (SELECT COUNT(*)::int FROM student_quizpe_histories x WHERE x.tracker_id = $1) AS total
       FROM student_quizpe_histories h
       JOIN question_bank qb ON qb.id = h.question_id
      WHERE h.tracker_id = $1 AND h.answered_option IS NULL
      ORDER BY h.serial_number LIMIT 1`, [trackerId]);
  return rows[0] || null;
}

async function sendQuestion(sessionId, mobile, trackerId, q) {
  // stamp when the question went out, so we can measure how fast they answer
  await db.query(
    `UPDATE student_quizpe_histories SET sent_at = COALESCE(sent_at, now())
      WHERE tracker_id=$1 AND serial_number=$2`, [trackerId, q.serial_number]);

  const total = q.total || QUESTIONS_PER_QUIZ;   // actual number in THIS quiz
  const opts = [q.option_a, q.option_b, q.option_c, q.option_d]
    .map((text, i) => ({ letter: LETTERS[i], text }))
    .filter(o => o.text);

  // Preferred: a Flow screen with real radio buttons + "Submit & Next".
  if (process.env.WHATSAPP_QUIZ_FLOW_ID) {
    await wa.sendFlow(sessionId, mobile, {
      flowId: process.env.WHATSAPP_QUIZ_FLOW_ID,
      flowToken: `quiz_${trackerId}_${q.serial_number}`,
      screen: 'QUESTION',
      cta: `Question ${q.serial_number}`,
      body: `Question ${q.serial_number} of ${total} — tap to answer`,
      footer: 'QuizPe',
      data: {
        serial: String(q.serial_number),
        total: String(total),
        chapter: q.chapter,
        question: q.question_whatsapp,
        tracker_id: String(trackerId),
        options: opts.map(o => ({ id: o.letter, title: `${o.letter})  ${o.text}`.slice(0, 30) })),
      },
    });
    return;
  }

  // Fallback: interactive list (works with no Meta setup).
  await wa.sendList(sessionId, mobile, {
    text: `*Question ${q.serial_number} of ${total}*\n_${q.chapter}_\n\n${q.question_whatsapp}`,
    buttonText: 'Choose answer',
    footer: 'Tap your answer below',
    rows: opts.map(o => ({
      id: `ans_${trackerId}_${q.serial_number}_${o.letter}`,
      title: `${o.letter}) ${o.text}`.slice(0, 24),
    })),
  });
}

/**
 * Record an answer. NO correct/wrong feedback here — answers and explanations
 * are revealed only after the whole quiz is finished, so the child cannot be
 * nudged mid-quiz and the assessment stays fair.
 *
 * opts.allowChange lets the web quiz revise an answer via "<< Previous" (chat
 * keeps the IS NULL guard so a double-tapped button can't replay). Even then
 * response_seconds keeps its FIRST value, so the speed tiles measure thinking
 * time rather than time spent second-guessing.
 */
async function submitAnswer(sessionId, mobile, trackerId, serial, letter, opts = {}) {
  const { rows } = await db.query(
    `UPDATE student_quizpe_histories h
        SET answered_option  = $3,
            is_correct       = (qb.answer = $3),
            answered_at      = now(),
            response_seconds = COALESCE(
                                 h.response_seconds,
                                 CASE WHEN h.sent_at IS NOT NULL
                                      THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - h.sent_at))::int)
                                 END),
            status_id        = (SELECT id FROM quizpe_status WHERE status_code='completed'),
            modified_at      = now()
       FROM question_bank qb
      WHERE qb.id = h.question_id
        AND h.tracker_id = $1 AND h.serial_number = $2
        AND ($4 OR h.answered_option IS NULL)
      RETURNING h.is_correct`,
    [trackerId, serial, letter, opts.allowChange === true]);

  if (!rows.length) return { alreadyAnswered: true };

  // neutral acknowledgement only — never reveals whether it was right
  const { rows: [p] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE answered_option IS NOT NULL)::int done,
            COUNT(*)::int total
       FROM student_quizpe_histories WHERE tracker_id=$1`, [trackerId]);
  // the web quiz shows its own progress, so it answers silently
  if (!opts.silent && p.done < p.total) {
    await wa.sendText(sessionId, mobile, `✔️ Answer saved — ${p.done}/${p.total} done.`);
  }
  return { isCorrect: rows[0].is_correct, done: p.done, total: p.total };
}

/** Mark the tracker complete and send the score card. */
async function finishQuiz(sessionId, mobile, trackerId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE is_correct)::int correct
       FROM student_quizpe_histories WHERE tracker_id=$1`, [trackerId]);
  const { total, correct } = rows[0];

  // Never announce a "completed" quiz that has no questions — that only
  // happens when the tracker is missing or was never filled.
  if (!trackerId || total === 0) {
    console.error(`[quiz] finishQuiz called with no questions (trackerId=${trackerId})`);
    await wa.sendText(sessionId, mobile,
      `😕 Sorry — we couldn't load today's quiz. Please type *menu* and tap *Start quiz now* again.`);
    return { total: 0, correct: 0, pct: 0, error: 'EMPTY_TRACKER' };
  }
  const pct = total ? Math.round(correct * 100 / total) : 0;

  // ---- STATUS CASCADE -----------------------------------------------------
  // 1) any history row still unanswered when the quiz closes -> 'closed'
  //    (answered rows were already set to 'completed' in submitAnswer)
  // 2) the tracker -> 'completed' if every question was answered,
  //    otherwise 'closed' (partial attempt, still scored)
  const unanswered = total - (await db.query(
    `SELECT COUNT(*)::int n FROM student_quizpe_histories
      WHERE tracker_id=$1 AND answered_option IS NOT NULL`, [trackerId])).rows[0].n;

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    if (unanswered > 0) {
      await c.query(
        `UPDATE student_quizpe_histories
            SET status_id=(SELECT id FROM quizpe_status WHERE status_code='closed'), modified_at=now()
          WHERE tracker_id=$1 AND answered_option IS NULL`, [trackerId]);
    }
    await c.query(
      `UPDATE quizpe_tracker
          SET status_id=(SELECT id FROM quizpe_status WHERE status_code=$2), modified_at=now()
        WHERE id=$1`, [trackerId, unanswered > 0 ? 'closed' : 'completed']);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }

  // Adaptive promotion: did this child just master their current chapter?
  let promo = null;
  try {
    const t = (await db.query(`SELECT student_id, subject_id FROM quizpe_tracker WHERE id=$1`, [trackerId])).rows[0];
    if (t) promo = await mastery.evaluateAndPromote(t.student_id, t.subject_id);
  } catch (e) { console.error('[quiz] promotion check failed:', e.message); }

  const chapters = (await db.query(
    `SELECT qb.chapter, COUNT(*)::int asked, COUNT(*) FILTER (WHERE h.is_correct)::int correct
       FROM student_quizpe_histories h JOIN question_bank qb ON qb.id=h.question_id
      WHERE h.tracker_id=$1 GROUP BY qb.chapter ORDER BY 1`, [trackerId])).rows;

  const badge = pct >= 90 ? '🏆 Outstanding!' : pct >= 70 ? '🌟 Great job!'
              : pct >= 50 ? '👍 Good effort!' : '💪 Keep practising!';

  // ---- speed + streak (engagement) ----
  let speedLine = '';
  try {
    const t = (await db.query(`SELECT student_id FROM quizpe_tracker WHERE id=$1`, [trackerId])).rows[0];
    const s = (await db.query(
      `SELECT ROUND(AVG(response_seconds))::int avg_s, MIN(response_seconds)::int fast_s
         FROM student_quizpe_histories WHERE tracker_id=$1 AND response_seconds IS NOT NULL`, [trackerId])).rows[0];
    const best = (await db.query(
      `SELECT MIN(h.response_seconds)::int best FROM student_quizpe_histories h
         JOIN quizpe_tracker tr ON tr.id=h.tracker_id
        WHERE tr.student_id=$1 AND h.response_seconds IS NOT NULL AND h.is_correct`, [t?.student_id])).rows[0];
    const streak = t ? await mastery.currentStreak(t.student_id) : 0;

    const bits = [];
    if (s?.avg_s != null) bits.push(`⏱ Avg ${s.avg_s}s per question`);
    if (s?.fast_s != null) {
      const isPB = best?.best != null && s.fast_s <= best.best;
      bits.push(`⚡ Fastest ${s.fast_s}s${isPB ? ' — *new personal best!*' : ''}`);
    }
    if (streak > 1) bits.push(`🔥 ${streak}-day streak!`);
    if (bits.length) speedLine = `\n\n${bits.join('\n')}`;
  } catch (e) { console.error('[quiz] speed stats failed:', e.message); }

  // Adaptive progress line — celebrate a chapter mastered / syllabus done.
  let progressLine = '';
  if (promo?.promoted && promo.status === 'completed') {
    progressLine = `\n\n🎓 *Syllabus complete!* You've mastered every chapter — from here it's all revision to stay sharp. 🌟`;
  } else if (promo?.promoted && promo.to) {
    progressLine = `\n\n🚀 *New chapter unlocked!* You've mastered *${promo.from}* — next up: *${promo.to}*.`;
  }

  await wa.sendText(sessionId, mobile,
`🎯 *Quiz Complete!*

${badge}

*Score: ${correct}/${total}* (${pct}%)

*Chapter-wise:*
${chapters.map(c => `• ${c.chapter}: ${c.correct}/${c.asked}`).join('\n')}${speedLine}${progressLine}

_Full answers & explanations are in the report below._ 📄`);

  // The answer review used to be sent as long chat messages too — dropped,
  // because the PDF report carries it with the drawn explanations.

  // ---- daily report PDF ---------------------------------------------------
  // Rendering a PDF and uploading it to Meta takes seconds of single-threaded
  // work. At 8 PM many children finish within the same minute, so this runs
  // AFTER the caller is answered rather than inside the request — the score
  // card is instant and the report follows. The result is already saved, so a
  // PDF or send failure can never lose it.
  // Durable enqueue: only ids, so the job survives a restart and can run in
  // any process. dedupeKey means a retried finishQuiz cannot queue two reports
  // for the same quiz. The score is already committed above, so nothing here
  // can lose a child's result.
  await jobs.push('daily_report', { trackerId, sessionId, mobile },
    { dedupeKey: `report:${trackerId}` });

  return { total, correct, pct };
}

/** Store a one-tap rating against the current feedback period. */
async function saveFeedback(trackerId, rating, userName) {
  const fb = require('./feedback');
  const info = (await db.query(
    `SELECT t.student_id, st.parent_id, p.parent_mobile_number
       FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id
       JOIN parents  p  ON p.id = st.parent_id
      WHERE t.id = $1`, [trackerId])).rows[0];
  if (!info) return null;

  const due = await fb.feedbackDue(info.parent_id);
  // even if the period was already answered, keep the latest rating
  const type = due.type || 'daily';
  const periodKey = due.periodKey
    || (await db.query(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') k`)).rows[0].k;

  const id = await fb.saveRating({
    parentId: info.parent_id, studentId: info.student_id, trackerId,
    mobile: info.parent_mobile_number, userName,
    rating, type, planType: due.planType || null, periodKey,
  });
  return { id, rating };
}

module.exports = {
  scheduleDailyQuizzes, subjectsForStudent, pendingTrackers, saveFeedback,
  startQuiz, nextQuestion, sendQuestion, submitAnswer, finishQuiz,
  QUESTIONS_PER_QUIZ, BASE_SUBJECT, servingMonth, academicYear,
};
