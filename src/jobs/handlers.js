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
               `Score ${rep.score.correct}/${rep.score.total} (${rep.score.pct}%) · *${rep.score.grade}* — ${rep.score.label}\n` +
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
    `SELECT s.quiz_time, pl.is_trial
       FROM parents_quizpe_subscriptions s
       JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE s.parent_id=$1 AND s.is_active ORDER BY s.id DESC LIMIT 1`, [info.parent_id])).rows[0];
  const nextAt = t ? ` at *${M.fmtTime(t.quiz_time)}*` : '';

  // Social "follow us" invite — sent DAILY, but ONLY to trial families. The
  // trial is a 7-day window where we most want to build community, and it's too
  // short to ever trigger a weekly report (which carries the invite for PAID
  // families), so daily here is how a trial parent ever sees our channels. Paid
  // parents are deliberately NOT nagged daily — that's what protects our
  // WhatsApp quality rating. SOCIAL_INVITE=0 turns it off everywhere.
  const social = (process.env.SOCIAL_INVITE !== '0' && t?.is_trial) ? M.socialInvite() : '';

  if (!due.due) {
    await wa.sendText(sessionId, mobile,
      `🙏 *Thank you!*\n\nThat's today's quiz done. See you tomorrow${nextAt} for the next one! 🚀${social}`);
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
    body: `🙏 *Thank you!*\n\nThat's today's quiz done. ${fb.askText(due.type, info.student_name)}\n\n_Takes 10 seconds._${social}`,
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
 * A referred friend's FIRST quiz qualifies their referral and rewards the
 * REFERRER — immediately (their period's first) or banked for a renewal. The
 * friend gets nothing extra and no message; only the referrer is told.
 *
 * qualifyOnFirstQuiz is idempotent, so calling this after every quiz only ever
 * acts the first time. Best-effort — the caller wraps it in try/catch.
 */
async function creditReferralOnQuiz(studentId) {
  const referrals = require('../referrals/engine');
  const wa = require('../whatsapp/client');
  const lifecycle = require('../whatsapp/lifecycle');
  const { fmtDate } = require('../whatsapp/messages');

  const { rows: [s] } = await db.query(
    `SELECT parent_id FROM students WHERE id = $1`, [studentId]);
  if (!s?.parent_id) return;

  const reward = await referrals.qualifyOnFirstQuiz(s.parent_id);
  if (!reward) return;                       // no pending referral — the usual case

  const friendName = (await db.query(
    `SELECT parent_name FROM parents WHERE id = $1`, [s.parent_id])).rows[0]?.parent_name || 'A friend';
  const ref = (await db.query(
    `SELECT p.parent_name, p.parent_mobile_number AS mobile, ws.id AS session_id
       FROM parents p
       LEFT JOIN whatsapp_sessions ws ON ws.mobile_number = p.parent_mobile_number
      WHERE p.id = $1`, [reward.referrerId])).rows[0];
  if (!ref?.session_id) return;

  if (reward.kind === 'immediate') {
    // Referrer may be outside the 24h window, so try the template first.
    const params = [ref.parent_name || 'there', friendName, String(reward.days), fmtDate(reward.referrerNewEnd)];
    const t = await lifecycle.sendTemplateIfApproved(ref.session_id, ref.mobile, 'qp_referral_reward_v1', params);
    if (!t.sent) {
      await wa.sendText(ref.session_id, ref.mobile,
`🎉 *Your invite worked — +${reward.days} free days!*

${friendName} you invited just started their child on QuizPe.
📅 Your access now runs till *${fmtDate(reward.referrerNewEnd)}*.

Refer more — each further friend adds *${reward.days} days* at your next renewals! 💚`).catch(() => {});
    }
  } else if (reward.kind === 'banked') {
    // Best-effort: reaches them if they are in-window; a template can cover the
    // out-of-window case later.
    await wa.sendText(ref.session_id, ref.mobile,
`🎉 *${friendName} joined through your invite!*

You've already claimed this period's bonus, so this one is *banked* — *+${reward.days} days* will be added at your *next renewal*. Keep referring! 💚`).catch(() => {});
  }
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

  // Referral payout — fires once, on the referred parent's FIRST completed quiz
  // (during their free trial). Fully isolated: any failure is logged and never
  // touches the quiz, report or the badge/streak flow below.
  try {
    await creditReferralOnQuiz(studentId);
  } catch (e) {
    console.error('[jobs] referral credit skipped:', e.message);
  }

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
        if (link) invite = `\n\nInvite a friend and earn free days when they start: ${link}`;
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

/**
 * Weekly performance report (rolling 7-day cycle). Delivery is cost-smart:
 *   • inside the 24h window  -> free-form document (no template cost)
 *   • outside the window     -> approved DOCUMENT template (the only way to
 *                               attach a PDF beyond 24h)
 * If it's outside the window and the template isn't approved yet, we DEFER
 * (don't generate/record it), so the daily scan retries it once approved.
 */
async function weeklyReport({ studentId, weekStart, weekEnd, sessionId, mobile }) {
  const wa = require('../whatsapp/client');
  const { generateWeeklyReport } = require('../pdf/weeklyReport');
  const w = (await db.query(
    `SELECT (last_inbound_at > now() - interval '24 hours') AS in_window FROM whatsapp_sessions WHERE id=$1`,
    [sessionId])).rows[0];
  const inWindow = !!(w && w.in_window);
  const TPL = process.env.WEEKLY_REPORT_TEMPLATE || 'qp_weeklyreport_v1';

  if (!inWindow && !(await require('../whatsapp/lifecycle').approved(TPL))) {
    console.warn(`[jobs] weekly report ${mobile}: outside 24h window and ${TPL} not approved — deferring`);
    return;   // leave it "due"; the daily scan re-tries once the template is live
  }

  const rep = await generateWeeklyReport(studentId, { weekStart, weekEnd });   // records the report row
  const s = rep.summary;
  const trend = s.improvement > 0 ? ` · 📈 +${s.improvement}%` : s.improvement < 0 ? ` · 📉 ${s.improvement}%` : '';
  const filename = `${rep.head.student_name}-weekly-report.pdf`;
  const fmtD = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const range = `${fmtD(weekStart)} – ${fmtD(weekEnd)} ${new Date(`${weekEnd}T00:00:00`).getFullYear()}`;

  // The weekly report is the natural, ~once-a-week moment to ask for a follow —
  // a positive touchpoint (the child's progress), not the daily thank-you. Only
  // on the free-form (in-window) send: the document template's copy is fixed by
  // Meta, so the links can't ride along there. SOCIAL_INVITE=0 turns it off.
  const social = process.env.SOCIAL_INVITE === '0' ? '' : require('../whatsapp/messages').socialInvite();

  if (inWindow) {
    await wa.sendDocument(sessionId, mobile, {
      filePath: rep.filePath, filename,
      caption: `📊 *${rep.head.student_name}'s weekly report*\n`
        + `🗓️ ${range}\n`
        + `${s.days}/7 days active · Avg ${s.avgPct}% · *${s.grade}*${trend}\n`
        + `_Trends, chapter mastery, strengths and what to revise — all inside._${social}`,
    });
  } else {
    const parent = String(rep.head.parent_name || 'there').trim().split(/\s+/)[0] || 'there';
    await wa.sendDocumentTemplate(sessionId, mobile, TPL, {
      params: [parent, rep.head.student_name, range, String(s.days), String(s.avgPct)],   // {{1}}..{{5}}
      filePath: rep.filePath, filename,
    });
  }
}

/**
 * The founder's nightly analytics digest. Gathers every dashboard figure and
 * mails it to the operator inbox. Goes through the queue (like adminMail) so a
 * slow or down SMTP retries with backoff instead of being lost. A configuration
 * gap is not worth retrying; a transient SMTP error is.
 */
async function dailyDigest() {
  const { sendAdminMail } = require('../mail/mailer');
  const { buildDigest } = require('../mail/digest');
  const res = await sendAdminMail(await buildDigest());
  if (!res.sent && res.reason !== 'not_configured') throw new Error(res.reason || 'digest mail failed');
}

/**
 * TEMPORARY operator alert: a child just finished a quiz. Gathers the score,
 * chapter breakdown and streak for one tracker and mails it to the founder.
 * Enqueued from finishQuiz only while QUIZ_DONE_ALERT is on (see the flag
 * there). Best-effort: a config gap is dropped, a transient SMTP error retries.
 */
async function quizDoneAlert({ trackerId }) {
  const { sendAdminMail } = require('../mail/mailer');
  const templates = require('../mail/templates');
  const db = require('../database/connectDB');
  const { gradeFor } = require('../pdf/dailyReport');
  const mastery = require('../whatsapp/mastery');

  const head = (await db.query(
    `SELECT t.student_id, t.quiz_date::text AS quiz_date,
            st.student_name, b.board_code, g.grade_name,
            sub.subject_name, p.parent_name, p.parent_mobile_number,
            qs.status_code
       FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id
       JOIN parents  p  ON p.id  = st.parent_id
       JOIN boards   b  ON b.id  = st.board_id
       JOIN grades   g  ON g.id  = st.grade_id
       JOIN subjects sub ON sub.id = t.subject_id
       JOIN quizpe_status qs ON qs.id = t.status_id
      WHERE t.id = $1`, [trackerId])).rows[0];
  if (!head) return;                                    // tracker gone: nothing to alert

  const { rows: [sc] } = await db.query(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE is_correct)::int correct
       FROM student_quizpe_histories WHERE tracker_id=$1`, [trackerId]);
  if (!sc.total) return;                                // empty quiz: not a real completion
  const pct = Math.round((sc.correct * 100) / sc.total);

  const chapters = (await db.query(
    `SELECT qb.chapter, COUNT(*)::int asked, COUNT(*) FILTER (WHERE h.is_correct)::int correct
       FROM student_quizpe_histories h JOIN question_bank qb ON qb.id=h.question_id
      WHERE h.tracker_id=$1 GROUP BY qb.chapter ORDER BY 1`, [trackerId])).rows;

  let streak = 0;
  try { streak = await mastery.currentStreak(head.student_id); } catch { /* non-fatal */ }

  const g = gradeFor(pct);
  const res = await sendAdminMail(templates.quizCompleted({
    student: head.student_name, parent: head.parent_name, mobile: head.parent_mobile_number,
    board: head.board_code, grade: head.grade_name, subject: head.subject_name,
    correct: sc.correct, total: sc.total, pct,
    gradeWord: g.grade, gradeLabel: g.label, status: head.status_code,
    chapters, streak, quizDate: head.quiz_date,
  }));
  if (!res.sent && res.reason !== 'not_configured') throw new Error(res.reason || 'quiz alert mail failed');
}

/**
 * TEMPORARY operator alert: a child just STARTED a quiz. The real-time ping —
 * fires the moment the quiz opens, before any answers (so, unlike quizDoneAlert,
 * there is no score yet). Enqueued from startQuiz only on a fresh start and only
 * while QUIZ_START_ALERT is on. Best-effort, same retry rules as the others.
 */
async function quizStartAlert({ trackerId }) {
  const { sendAdminMail } = require('../mail/mailer');
  const templates = require('../mail/templates');
  const db = require('../database/connectDB');

  const head = (await db.query(
    `SELECT st.student_name, b.board_code, g.grade_name, sub.subject_name,
            p.parent_name, p.parent_mobile_number, t.question_count
       FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id
       JOIN parents  p  ON p.id  = st.parent_id
       JOIN boards   b  ON b.id  = st.board_id
       JOIN grades   g  ON g.id  = st.grade_id
       JOIN subjects sub ON sub.id = t.subject_id
      WHERE t.id = $1`, [trackerId])).rows[0];
  if (!head) return;

  const res = await sendAdminMail(templates.quizStarted({
    student: head.student_name, parent: head.parent_name, mobile: head.parent_mobile_number,
    board: head.board_code, grade: head.grade_name, subject: head.subject_name,
    questions: head.question_count,
  }));
  if (!res.sent && res.reason !== 'not_configured') throw new Error(res.reason || 'quiz start mail failed');
}

function registerAll() {
  jobs.register('daily_report', dailyReport);
  jobs.register('weekly_report', weeklyReport);
  jobs.register('feedback_ask', feedbackAsk);
  jobs.register('admin_mail', adminMail);
  jobs.register('award_badges', awardBadges);
  jobs.register('daily_digest', dailyDigest);
  jobs.register('quiz_done_alert', quizDoneAlert);
  jobs.register('quiz_start_alert', quizStartAlert);
}

module.exports = { registerAll, dailyReport, weeklyReport, feedbackAsk, adminMail, awardBadges, dailyDigest, quizDoneAlert, quizStartAlert };
