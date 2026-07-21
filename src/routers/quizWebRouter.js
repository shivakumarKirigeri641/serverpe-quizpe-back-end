/**
 * src/routers/quizWebRouter.js
 * ---------------------------------------------------------------------------
 * Backs public/quiz.html — the child answers the whole quiz on a web page
 * instead of in chat. This removes WhatsApp's 24-character option truncation
 * and the ten "answer saved" messages.
 *
 *   GET  /quiz/api/context?token=...  -> student, progress, current question
 *   POST /quiz/api/answer             -> save + return the NEXT question
 *   POST /quiz/api/finish             -> score card + PDF + feedback on WhatsApp
 *
 * Only the current question is ever sent to the browser, so the answer key
 * never leaves the server.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database/connectDB');
const Q = require('../whatsapp/quiz');
const { claimOrVerify } = require('./deviceLock');

const router = express.Router();
const TTL_HOURS = 14;                        // a day's quiz link
const LETTERS = ['A', 'B', 'C', 'D'];
const SPENT = 'This quiz has already been submitted. Your score and report are in WhatsApp.';
const EXPIRED = 'This quiz link is no longer valid.';
/** Every rejection carries a code so the page can show the right screen. */
const waUrlOrNull = () => {
  const n = String(process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}` : null;
};
const reject = (res, status, code, error) =>
  res.status(status).json({ success: false, code, error, whatsapp_url: waUrlOrNull() });

/** Mint (or reuse) the link for a tracker. */
async function createQuizLink(sessionId, mobile, trackerId) {
  const existing = (await db.query(
    `SELECT token FROM quiz_links WHERE tracker_id=$1 AND expires_at > now() AND finished_at IS NULL`,
    [trackerId])).rows[0];
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  if (existing) return { token: existing.token, url: `${base}/quiz.html?token=${existing.token}` };

  const token = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO quiz_links (token, tracker_id, whatsapp_session_id, mobile_number, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5||' hours')::interval)
     ON CONFLICT (tracker_id) DO UPDATE
       SET token=EXCLUDED.token, expires_at=EXCLUDED.expires_at, finished_at=NULL`,
    [token, trackerId, sessionId, mobile, String(TTL_HOURS)]);
  return { token, url: `${base}/quiz.html?token=${token}` };
}

async function load(token) {
  const { rows } = await db.query(
    `SELECT ql.*, t.student_id, t.subject_id, t.quiz_type, t.question_count,
            st.student_name, sub.subject_name
       FROM quiz_links ql
       JOIN quizpe_tracker t ON t.id = ql.tracker_id
       JOIN students st ON st.id = t.student_id
       JOIN subjects sub ON sub.id = t.subject_id
      WHERE ql.token=$1`, [token]);
  return rows[0] || null;
}

/**
 * Why a link can't be used — checked in the order that gives the parent the
 * most useful message. "Already submitted" is more helpful than "expired",
 * so a link that was finished AND has since expired says submitted.
 */
function linkProblem(l) {
  if (!l) return ['INVALID', 'We could not find this quiz link.'];
  if (l.finished_at) return ['SUBMITTED', SPENT];
  if (new Date(l.expires_at) <= new Date()) return ['EXPIRED', EXPIRED];
  return null;
}

/** Overall progress for the tracker. */
async function progressOf(trackerId) {
  return (await db.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE answered_option IS NOT NULL)::int done,
            MIN(serial_number) FILTER (WHERE answered_option IS NULL)::int first_unanswered
       FROM student_quizpe_histories WHERE tracker_id=$1`, [trackerId])).rows[0];
}

/**
 * One question by serial, with full option text (no truncation) and whatever
 * the child already chose — so "<< Previous" comes back pre-selected.
 */
async function questionAt(trackerId, serial) {
  const q = (await db.query(
    `SELECT h.serial_number, h.answered_option, qb.chapter, qb.question_whatsapp,
            qb.question_pdf, qb.option_a, qb.option_b, qb.option_c, qb.option_d
       FROM student_quizpe_histories h
       JOIN question_bank qb ON qb.id = h.question_id
      WHERE h.tracker_id=$1 AND h.serial_number=$2`, [trackerId, serial])).rows[0];
  const progress = await progressOf(trackerId);
  if (!q) return { question: null, progress };

  // stamp when the question reached the child, so response_seconds (and the
  // speed tiles in the report) work the same as the in-chat path
  await db.query(
    `UPDATE student_quizpe_histories SET sent_at = COALESCE(sent_at, now())
      WHERE tracker_id=$1 AND serial_number=$2`, [trackerId, serial]);

  const options = [q.option_a, q.option_b, q.option_c, q.option_d]
    .map((text, i) => ({ letter: LETTERS[i], text }))
    .filter(o => o.text != null && String(o.text).trim() !== '');
  return {
    progress,
    question: {
      serial: q.serial_number, chapter: q.chapter,
      text: q.question_pdf || q.question_whatsapp,
      options, selected: q.answered_option,
    },
  };
}

/* ------------------------------------------------------------------ context */
router.get('/api/context', async (req, res) => {
  try {
    const l = await load(req.query.token);
    const bad = linkProblem(l);
    if (bad) return reject(res, 410, bad[0], bad[1]);

    // a forwarded link must not let someone else answer this child's quiz
    const lock = await claimOrVerify('quiz_links', l, req, res);
    if (!lock.ok) return reject(res, 403, lock.code, lock.error);

    // resume where they stopped; if everything is answered, open the last one
    const p = await progressOf(l.tracker_id);
    const cur = await questionAt(l.tracker_id, p.first_unanswered || p.total);
    const answered = (await db.query(
      `SELECT serial_number FROM student_quizpe_histories
        WHERE tracker_id=$1 AND answered_option IS NOT NULL ORDER BY serial_number`,
      [l.tracker_id])).rows.map(r => r.serial_number);
    res.json({
      success: true,
      student: l.student_name, subject: l.subject_name,
      isTest: l.quiz_type === 'test',
      answered,
      ...cur,
    });
  } catch (e) {
    console.error('[quizweb] context failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
});

/* --------------------------------------------------------------- answer/nav */
/**
 * Saves the answer on the question being left (if any) and returns the question
 * at `goto`, so Next/Previous cost a single round trip. `answer` may be null —
 * that's "<< Previous" without having picked anything.
 */
router.post('/api/answer', async (req, res) => {
  try {
    const { token, serial, answer, goto: target } = req.body || {};
    const l = await load(token);
    const bad = linkProblem(l);
    if (bad) return reject(res, 410, bad[0], bad[1]);
    const lock = await claimOrVerify('quiz_links', l, req, res);
    if (!lock.ok) return reject(res, 403, lock.code, lock.error);
    if (answer != null && !LETTERS.includes(answer)) {
      return res.status(400).json({ success: false, error: 'Invalid answer.' });
    }

    if (answer != null) {
      // silent      -> no "answer saved" chat message; the page shows progress
      // allowChange -> they may come back via "<< Previous" and change their mind
      await Q.submitAnswer(l.whatsapp_session_id, l.mobile_number, l.tracker_id,
        Number(serial), answer, { silent: true, allowChange: true });
    }

    const p = await progressOf(l.tracker_id);
    const want = Math.min(Math.max(Number(target) || Number(serial), 1), p.total);
    res.json({ success: true, ...(await questionAt(l.tracker_id, want)) });
  } catch (e) {
    console.error('[quizweb] answer failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not save that answer.' });
  }
});

/* ------------------------------------------------------------------- finish */
router.post('/api/finish', async (req, res) => {
  try {
    const l = await load(req.body?.token);
    const bad = linkProblem(l);
    if (bad) return reject(res, 410, bad[0], bad[1]);
    const lock = await claimOrVerify('quiz_links', l, req, res);
    if (!lock.ok) return reject(res, 403, lock.code, lock.error);

    const p = await progressOf(l.tracker_id);
    if (p.done < p.total) {
      return res.status(400).json({
        success: false, unanswered: p.first_unanswered,
        error: `Question ${p.first_unanswered} is still unanswered.`,
      });
    }

    // Burn the link first, and only if this request is the one that burns it —
    // two taps on "Submit" must not send the report and feedback ask twice.
    const claimed = await db.query(
      `UPDATE quiz_links SET finished_at=now() WHERE id=$1 AND finished_at IS NULL`, [l.id]);
    if (!claimed.rowCount) return reject(res, 410, 'SUBMITTED', SPENT);

    // this sends the score card, the PDF report and the feedback ask on WhatsApp
    const score = await Q.finishQuiz(l.whatsapp_session_id, l.mobile_number, l.tracker_id);

    // the chat path leaves 'in_quiz' when the last answer lands; do the same
    // here, or typing "menu" afterwards would still be read as a quiz answer
    await db.query(
      `INSERT INTO whatsapp_session_events (session_id, from_state, to_state, event, payload)
       VALUES ($1,'in_quiz','main_menu','quiz_completed_web',$2)`,
      [l.whatsapp_session_id, score]);
    await db.query(
      `UPDATE whatsapp_sessions SET state='main_menu', modified_at=now() WHERE id=$1`,
      [l.whatsapp_session_id]);

    res.json({ success: true, score, whatsapp_url: waLink() });
  } catch (e) {
    console.error('[quizweb] finish failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not finish the quiz.' });
  }
});

function waLink() {
  const n = String(process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}` : null;
}

module.exports = router;
module.exports.createQuizLink = createQuizLink;
