/**
 * src/jobs/handlers.js
 * ---------------------------------------------------------------------------
 * What each queued job actually does.
 *
 * Handlers take ONLY ids in their payload and re-read everything else from the
 * database. A job may run minutes after it was queued, in a different process,
 * after a restart — so anything captured in a closure would be stale or gone.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const jobs = require('./jobQueue');

/** Render the daily report and send it, then ask for feedback. */
async function dailyReport({ trackerId, sessionId, mobile }) {
  const wa = require('../whatsapp/client');

  try {
    const { generateDailyReport } = require('../pdf/dailyReport');
    const rep = await generateDailyReport(trackerId);
    await wa.sendDocument(sessionId, mobile, {
      filePath: rep.filePath,
      filename: `${rep.head.student_name}-${rep.head.subject_name}-report.pdf`,
      caption: `📄 *${rep.head.student_name}'s report* — ${rep.head.subject_name}\n` +
               `Score ${rep.score.correct}/${rep.score.total} (${rep.score.pct}%) · Grade *${rep.score.grade}* — ${rep.score.label}\n` +
               `_Includes every question, the correct answer and why._`,
    });
  } catch (e) {
    // The score is already saved, so a report failure must not block the
    // feedback ask — but it IS worth retrying, so rethrow after asking.
    console.error(`[jobs] report for tracker ${trackerId} failed:`, e.message);
    throw e;
  }

  await jobs.push('feedback_ask', { trackerId, sessionId, mobile },
    { dedupeKey: `feedback:${trackerId}` });
}

/** Thank the parent and — when it is actually due — ask for a rating. */
async function feedbackAsk({ trackerId, sessionId, mobile }) {
  const wa = require('../whatsapp/client');
  const M = require('../whatsapp/messages');
  const fb = require('../whatsapp/feedback');

  const info = (await db.query(
    `SELECT t.student_id, st.student_name, st.parent_id
       FROM quizpe_tracker t JOIN students st ON st.id = t.student_id
      WHERE t.id = $1`, [trackerId])).rows[0];
  if (!info) return;

  const due = await fb.feedbackDue(info.parent_id);
  const t = (await db.query(
    `SELECT quiz_time FROM parents_quizpe_subscriptions
      WHERE parent_id=$1 AND is_active ORDER BY id DESC LIMIT 1`, [info.parent_id])).rows[0];
  const nextAt = t ? ` at *${M.fmtTime(t.quiz_time)}*` : '';

  if (!due.due) {
    await wa.sendText(sessionId, mobile,
      `🙏 *Thank you!*\n\nThat's today's quiz done. See you tomorrow${nextAt} for the next one! 🚀`);
    return;
  }

  // mark the period BEFORE sending, so ignoring it doesn't re-ask tomorrow
  await fb.markAsked({
    parentId: info.parent_id, studentId: info.student_id, trackerId,
    mobile, userName: null, type: due.type, planType: due.planType, periodKey: due.periodKey,
  });

  const { createFeedbackLink } = require('../routers/feedbackWebRouter');
  const { url } = await createFeedbackLink({
    sessionId, mobile, trackerId,
    parentId: info.parent_id, studentId: info.student_id,
    type: due.type, planType: due.planType, periodKey: due.periodKey,
  });
  await wa.sendCtaUrl(sessionId, mobile, {
    header: 'How was the quiz?',
    body: `🙏 *Thank you!*\n\nThat's today's quiz done. ${fb.askText(due.type, info.student_name)}\n\n_Takes 10 seconds._`,
    displayText: '⭐ Rate the quiz',
    url,
    footer: 'QuizPe by ServerPe App Solutions',
  });
}

function registerAll() {
  jobs.register('daily_report', dailyReport);
  jobs.register('feedback_ask', feedbackAsk);
}

module.exports = { registerAll, dailyReport, feedbackAsk };
