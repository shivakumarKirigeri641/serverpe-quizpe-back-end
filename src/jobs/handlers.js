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

  // Try the report, but hold any failure rather than throwing straight away —
  // the feedback ask below is INDEPENDENT of the report and must still go out.
  // The previous version threw here, which skipped the feedback enqueue, so a
  // single PDF failure silently cost the parent BOTH the report and the
  // feedback prompt. (A common cause on a fresh server: the gitignored
  // src/uploads/ directory is not writable by the node user — EACCES.)
  let reportError = null;
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
    console.error(`[jobs] report for tracker ${trackerId} failed:`, e.message);
    reportError = e;
  }

  // Always queue the feedback ask, whether or not the report went out.
  await jobs.push('feedback_ask', { trackerId, sessionId, mobile },
    { dedupeKey: `feedback:${trackerId}` });

  // Now surface the report failure so the job retries the PDF — the feedback
  // is safely queued above, so a retry cannot double-send it (deduped).
  if (reportError) throw reportError;
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

/**
 * Operator alert email. Goes through the queue so the thing that triggered it —
 * an enrolment, a payment — is never held up or rolled back by SMTP being slow
 * or down. A failure here retries with backoff and is logged; it never reaches
 * the parent.
 */
async function adminMail({ template, data }) {
  const { sendAdminMail } = require('../mail/mailer');
  const templates = require('../mail/templates');
  const build = templates[template];
  if (typeof build !== 'function') {
    console.error(`[jobs] unknown mail template: ${template}`);
    return;                                   // unknown template: drop, don't retry forever
  }
  const res = await sendAdminMail(build(data));
  // A configuration gap is not worth retrying five times; a transient SMTP
  // error is, so only the latter throws.
  if (!res.sent && res.reason !== 'not_configured') throw new Error(res.reason || 'mail failed');
}

/**
 * Works out which badges a child has just earned and tells them.
 *
 * Runs after the quiz result is committed, so nothing here can affect a score.
 * Only NEWLY earned badges are announced — re-announcing one a child already
 * holds would turn a reward into noise.
 */
async function awardBadges({ trackerId, sessionId, mobile }) {
  const rewards = require('../rewards/engine');
  const { rows } = await db.query(
    `SELECT t.student_id, st.student_name, b.board_code, g.grade_name,
            (SELECT r.score_correct = r.score_total FROM quiz_reports r
              WHERE r.tracker_id = t.id AND r.is_active LIMIT 1) AS was_perfect
       FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id
       LEFT JOIN boards b ON b.id = st.board_id
       LEFT JOIN grades g ON g.id = st.grade_id
      WHERE t.id = $1`, [trackerId]);
  if (!rows.length) return;
  const { student_id: studentId, student_name: name } = rows[0];

  const earned = await rewards.awardBadges(studentId);
  const streak = await rewards.streak(studentId);

  // A milestone worth forwarding gets a square image the parent can drop
  // straight into a family or school group. Sent before the text so the
  // picture is what catches the eye in the chat list.
  try {
    const share = require('../share/card');
    const stats = await rewards.stats(studentId);
    const spec = share.cardFor({
      streak, newBadges: earned,
      stats: { ...stats, lastWasPerfect: rows[0].was_perfect === true },
      student: { id: studentId, name, board: rows[0].board_code, grade: rows[0].grade_name },
    });
    if (spec) {
      const filePath = await share.renderCard(spec);
      const wa = require('../whatsapp/client');
      const referrals = require('../referrals/engine');
      const { rows: [p] } = await db.query(
        `SELECT pa.id FROM students st JOIN parents pa ON pa.id = st.parent_id WHERE st.id = $1`,
        [studentId]);
      let invite = '';
      try {
        const link = referrals.shareLink(await referrals.codeFor(p.id));
        if (link) invite = `\n\nInvite a friend and you both get free days: ${link}`;
      } catch { /* a missing code must not stop the card going out */ }
      await wa.sendImage(sessionId, mobile, {
        filePath,
        caption: `🎉 Share ${share.shortName(name)}'s achievement!${invite}`,
      });
    }
  } catch (e) {
    // The badge and streak are already recorded; a card is a bonus, not a
    // result, so a rendering or send failure must not fail the job.
    console.error('[jobs] share card skipped:', e.message);
  }

  if (!earned.length && streak.current < 3) return;      // nothing worth saying

  const wa = require('../whatsapp/client');
  const lines = [];
  if (earned.length) {
    lines.push(`🏅 *${name} earned ${earned.length === 1 ? 'a new badge' : `${earned.length} new badges`}!*`, '');
    for (const b of earned) lines.push(`${b.icon} *${b.badge_name}* — ${b.description}`);
  }
  // A streak is only worth mentioning once it is a run worth protecting.
  if (streak.current >= 3) {
    if (lines.length) lines.push('');
    lines.push(`🔥 *${streak.current}-day streak!*` +
      (streak.current === streak.longest ? ' That is your best yet.' : ` Your best is ${streak.longest}.`));
    lines.push('_Come back tomorrow to keep it going._');
  }

  try {
    await wa.sendText(sessionId, mobile, lines.join('\n'));
    if (earned.length) {
      await db.query(
        `UPDATE student_badges SET notified_at = now()
          WHERE student_id = $1 AND badge_id = ANY($2) AND notified_at IS NULL`,
        [studentId, earned.map((b) => b.id)]);
    }
  } catch (e) {
    // The badge is already recorded, so a failed message is a lost
    // announcement, not a lost reward. Not worth retrying the whole job.
    console.error('[jobs] badge announcement failed:', e.message);
  }
}

function registerAll() {
  jobs.register('daily_report', dailyReport);
  jobs.register('feedback_ask', feedbackAsk);
  jobs.register('admin_mail', adminMail);
  jobs.register('award_badges', awardBadges);
}

module.exports = { registerAll, dailyReport, feedbackAsk, adminMail, awardBadges };
