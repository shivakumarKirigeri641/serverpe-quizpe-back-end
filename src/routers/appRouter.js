/**
 * src/routers/appRouter.js — the parent's QuizPe on the web, quizpe.in/app
 * (user, 2026-10-08: WhatsApp is gone; "start QuizPe the same way" as GaadiPe).
 * ---------------------------------------------------------------------------
 *   POST /app/api/code          { mobile }                      SMS sign-in code
 *   POST /app/api/verify        { mobile, code, terms_accepted } -> { token }
 *   POST /app/api/signout
 *   GET  /app/api/me            the family: plan, children, today's quizzes
 *   POST /app/api/profile       { name?, email? }
 *   POST /app/api/quiz/start    { student_id, level? }  -> { url } | { ask_level } | { message }
 *   GET  /app/api/reports       quiz reports and invoices
 *   POST /app/api/trial         { parent_name }          -> { url }  (trial.html)
 *   POST /app/api/checkout      { plan_code }            -> { url }  (pay.html)
 *   GET  /app/api/push-key ·  POST /app/api/push  ·  POST /app/api/push/off
 *   GET  /app/api/info/:what (subscription | schedule) · POST /app/api/support
 *   POST /app/api/signout-all · POST /app/api/deactivate { reason } · POST /app/api/resume
 *   GET  /app/api/subscriptions · POST /app/api/child { student_id, name }
 *   GET  /app/api/activity      the dashboard's week and recent activity
 *
 * Nothing about the quiz itself is new. This page hands the parent the same
 * links the WhatsApp bot used to send — quiz.html, trial.html, pay.html and
 * the report PDFs — and follows the bot's rules for when a quiz may start
 * (src/whatsapp/flow.js beginQuizFor). The WhatsApp session row is still the
 * key those pages and jobs use, so a web parent gets one too (ensureSession);
 * nothing is sent through it, WhatsApp being retired in whatsapp/client.js.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const auth = require('../web/auth');
const notify = require('../web/notify');
const { getUserContext, getStudents } = require('../whatsapp/userContext');

const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status) console.error('[app]', req.method, req.path, e.message);
  res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Something went wrong. Please try again.' });
});
const ipOf = (req) => String(req.ip || '').replace(/^::ffff:/, '');
/** Whole days from a date to today in India (negative = in the future). */
const daysSince = (d) => {
  const ist = (x) => new Date(new Date(x).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).setHours(0, 0, 0, 0);
  return Math.round((ist(Date.now()) - ist(d)) / 864e5);
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The conversation row the quiz, trial and checkout pages are keyed on. */
async function ensureSession(mobile, parentId = null) {
  const found = (await db.query(
    `SELECT id, parent_id FROM whatsapp_sessions WHERE mobile_number = $1 AND is_active ORDER BY id DESC LIMIT 1`, [mobile])).rows[0];
  if (found) {
    if (parentId && !found.parent_id) await db.query(`UPDATE whatsapp_sessions SET parent_id = $2, modified_at = now() WHERE id = $1`, [found.id, parentId]);
    return found.id;
  }
  const { rows } = await db.query(
    `INSERT INTO whatsapp_sessions (mobile_number, parent_id, state, context)
     VALUES ($1, $2, 'main_menu', jsonb_build_object('channel', 'web')) RETURNING id`, [mobile, parentId]);
  return rows[0].id;
}

/* ------------------------------------------------------------ sign in/out */
router.post('/code', wrap(async (req, res) => {
  const r = await auth.requestCode(req.body?.mobile, ipOf(req));
  res.json({ success: true, ttl_min: r.ttl_min });
}));

router.post('/verify', wrap(async (req, res) => {
  const r = await auth.verifyCode(req.body?.mobile, req.body?.code, {
    termsAccepted: req.body?.terms_accepted, ip: ipOf(req), userAgent: req.headers['user-agent'],
  });
  res.json({ success: true, token: r.token, mobile: r.mobile, reactivated: Boolean(r.reactivated) });
}));

router.post('/signout', wrap(async (req, res) => {
  await auth.signOut(req);
  res.json({ success: true });
}));

router.use(auth.requireParent);

/* ------------------------------------------- the account (2026-10-10) */
router.post('/signout-all', wrap(async (req, res) => {
  const r = await auth.signOutAll(req.parentMobile);
  console.log(`[app] signed out of all devices: ${req.parentMobile.slice(0, 2)}xxxxxx${req.parentMobile.slice(-2)} (${r.ended})`);
  res.json({ success: true, ended: r.ended });
}));

/*
 * DEACTIVATE (user, 2026-10-10: "deactivate account (ask for reason)"). Everything
 * stops — quizzes, reminders, emails, phone notifications — and every device is
 * signed out. Nothing is deleted: the children, reports, invoices and the plan's
 * dates stay (invoices must be kept for GST), and signing in again brings it all
 * back (web/auth.js verifyCode). A paid plan is not refunded or paused — its days
 * keep running, which the confirmation says before the parent agrees.
 */
router.post('/deactivate', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (reason.length < 2) return res.status(400).json({ success: false, error: 'Please tell us why — it helps us improve.' });
  const { rowCount } = await db.query(
    `UPDATE parents SET is_active = false, service_paused = true, reminders_enabled = false, paused_at = now(),
            deactivated_at = now(), deactivated_reason = $2, modified_at = now()
      WHERE parent_mobile_number = $1`, [mobile, reason]);
  // A number with no family yet has nothing to switch off — its sign-ins still end.
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || jsonb_build_object('web_deactivated_at', now()::text, 'web_deactivated_reason', $2::text), modified_at = now()
      WHERE mobile_number = $1`, [mobile, reason]).catch(() => {});
  await auth.signOutAll(mobile);
  console.log(`[app] account deactivated by the parent: ${mobile.slice(0, 2)}xxxxxx${mobile.slice(-2)} (family: ${rowCount ? 'yes' : 'no'}) — ${reason}`);
  res.json({ success: true });
}));

/* RESUME — the web's START: a family that paused everything (STOP on WhatsApp) switches it back on. */
router.post('/resume', wrap(async (req, res) => {
  await db.query(
    `UPDATE parents SET service_paused = false, reminders_enabled = true, paused_at = NULL, modified_at = now()
      WHERE parent_mobile_number = $1`, [req.parentMobile]);
  await db.query(`UPDATE whatsapp_sessions SET opted_out = false, opted_out_at = NULL, modified_at = now() WHERE mobile_number = $1`, [req.parentMobile]).catch(() => {});
  res.json({ success: true });
}));

/* ------------------------------------------------------------------- me */
router.get('/me', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const ctx = await getUserContext(mobile);
  const W = require('../whatsapp/quizWindow');
  const DIFF = require('../whatsapp/difficulty');
  const Q = require('../whatsapp/quiz');

  const kids = ctx.exists ? await getStudents(ctx.parentId) : [];
  // The profile shows each child in full (2026-10-10): the board's and medium's names too.
  const more = kids.length ? Object.fromEntries((await db.query(
    `SELECT st.id, b.board_name, m.medium_name
       FROM students st JOIN boards b ON b.id = st.board_id LEFT JOIN mediums m ON m.id = st.medium_id
      WHERE st.id = ANY($1::int[])`, [kids.map((s) => s.id)])).rows.map((r) => [r.id, r])) : {};
  const children = [];
  for (const s of kids) {
    let today = null;
    try { today = await Q.dailyQuizProgress(s.id); } catch { today = null; }
    children.push({
      id: s.id, name: s.student_name, board: s.board_code, grade: s.grade_name, school: s.school_name,
      board_name: more[s.id]?.board_name || null, medium: more[s.id]?.medium_name || null,
      today: today ? { done: today.done, total: today.total, has_next: today.hasNext } : null,
      can_choose_level: DIFF.gradeAllows(s.grade_code), last_level: DIFF.label(s.difficulty_level),
    });
  }
  const parent = ctx.exists
    ? (await db.query(`SELECT parent_name, email, service_paused FROM parents WHERE id = $1`, [ctx.parentId])).rows[0]
    : (await db.query(`SELECT context->>'parent_name' AS parent_name, NULLIF(context->>'email', '') AS email FROM whatsapp_sessions WHERE mobile_number = $1 ORDER BY id DESC LIMIT 1`, [mobile])).rows[0];
  const plans = (await db.query(
    `SELECT plan_code, plan_name, price, comparable_price, student_count, duration
       FROM quizpe_plans WHERE is_active AND price > 0 AND duration > 0
        AND plan_code NOT IN ('INSTANT', 'QUICK_QUIZ')   -- single quizzes have no days; is_quick / is_instant are not on every database
      ORDER BY price`)).rows;
  const terms = (await db.query(`SELECT title, url FROM policies WHERE policy_code = 'terms' AND is_active ORDER BY id DESC LIMIT 1`)).rows[0];

  res.json({
    success: true,
    mobile,
    parent: { name: parent?.parent_name || null, email: parent?.email || null },
    // An enrolled family must give an email before anything else (2026-10-08).
    needs_email: Boolean(ctx.exists && !parent?.email),
    status: ctx.status,                       // NEW | INCOMPLETE | NO_SUBSCRIPTION | TRIAL_ACTIVE | ACTIVE | EXPIRED
    subscribed: Boolean(ctx.isSubscribed),
    plan: ctx.planName ? {
      name: ctx.planName, trial: Boolean(ctx.isTrial), starts: ctx.startDate, ends: ctx.endDate, days_left: ctx.daysLeft, seats: ctx.seatLimit,
      // The dashboard's status (2026-10-10): "expired x days ago", or "starts on …" for a plan not begun yet.
      ended_days_ago: ctx.status === 'EXPIRED' && ctx.endDate ? Math.max(0, daysSince(ctx.endDate)) : null,
      not_started: Boolean(ctx.startDate && daysSince(ctx.startDate) < 0),
    } : null,
    paused: Boolean(parent?.service_paused),
    free_access: Boolean(ctx.freeAccess),
    can_start_trial: Boolean(ctx.canStartTrial), trial_days: ctx.trialDays,
    children,
    window: { state: W.state(), opens: W.openHHMM(), closes: W.CLOSE_HHMM },
    plans: plans.map((p) => ({ code: p.plan_code, name: p.plan_name, price: Number(p.price), was: Number(p.comparable_price), children: p.student_count, days: p.duration })),
    terms_url: terms?.url || '/legal.html?doc=terms',
  });
}));

router.post('/profile', wrap(async (req, res) => {
  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 60) : null;
  const emailRaw = req.body?.email != null ? String(req.body.email).trim().toLowerCase().slice(0, 120) : null;
  // The email can be changed but not removed — it is required (2026-10-08).
  if (emailRaw != null && !EMAIL_RE.test(emailRaw)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid email address — it is needed for reminders and reports.' });
  }
  const mobile = req.parentMobile;
  if (name != null && name.length >= 2) {
    await db.query(`UPDATE parents SET parent_name = $2, modified_at = now() WHERE parent_mobile_number = $1`, [mobile, name]);
    const sid = await ensureSession(mobile);
    await db.query(`UPDATE whatsapp_sessions SET context = context || jsonb_build_object('parent_name', $2::text), modified_at = now() WHERE id = $1`, [sid, name]);
  }
  if (emailRaw != null) {
    await db.query(`UPDATE parents SET email = $2, modified_at = now() WHERE parent_mobile_number = $1`, [mobile, emailRaw]);
    const sid = await ensureSession(mobile);
    await db.query(`UPDATE whatsapp_sessions SET context = context || jsonb_build_object('email', $2::text), modified_at = now() WHERE id = $1`, [sid, emailRaw]);
  }
  res.json({ success: true });
}));

/* A child's name, from the profile (2026-10-10) — the name the quizzes, reports and the app's header use. */
router.post('/child', wrap(async (req, res) => {
  const ctx = await getUserContext(req.parentMobile);
  const st = ctx.exists ? (await getStudents(ctx.parentId)).find((s) => String(s.id) === String(req.body?.student_id)) : null;
  if (!st) return res.status(404).json({ success: false, error: 'We could not find that child.' });
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name.length < 2 || !/^[\p{L}][\p{L} .'-]*$/u.test(name)) return res.status(400).json({ success: false, error: "Please enter the child's name in letters." });
  await db.query(`UPDATE students SET student_name = $2, modified_at = now() WHERE id = $1`, [st.id, name]);
  res.json({ success: true });
}));

/*
 * MY SUBSCRIPTION (2026-10-10: "show current subscriptions"): every plan this family
 * has had, newest first — what it is, its dates, days left, the children it covers
 * and its invoice — so the current one and the history read at a glance.
 */
router.get('/subscriptions', wrap(async (req, res) => {
  const ctx = await getUserContext(req.parentMobile);
  if (!ctx.exists) return res.json({ success: true, subscriptions: [], children: [] });
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const { rows } = await db.query(
    `SELECT s.id, s.plan_start_date, s.plan_end_date, s.is_active, s.created_at,
            pl.plan_name, pl.is_trial, pl.student_count, pl.duration,
            (s.is_active AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS current,
            (s.is_active AND CURRENT_DATE < s.plan_start_date) AS upcoming,
            i.invoice_id, i.total, i.access_token
       FROM parents_quizpe_subscriptions s
       JOIN quizpe_plans pl ON pl.id = s.plan_id
       LEFT JOIN LATERAL (SELECT invoice_id, total, access_token FROM invoices
                           WHERE subscription_id = s.id AND is_active ORDER BY id DESC LIMIT 1) i ON true
      WHERE s.parent_id = $1
      ORDER BY s.plan_end_date DESC, s.id DESC LIMIT 20`, [ctx.parentId]);
  const kids = await getStudents(ctx.parentId);
  res.json({
    success: true,
    children: kids.map((k) => k.student_name),
    subscriptions: rows.map((r) => ({
      id: r.id, plan: r.plan_name, trial: r.is_trial, seats: r.student_count, days: r.duration,
      starts: r.plan_start_date, ends: r.plan_end_date,
      // A plan is switched off when it ends, so only one switched off before its end date was cancelled.
      state: r.current ? 'current' : r.upcoming ? 'upcoming' : !r.is_active && daysSince(r.plan_end_date) < 0 ? 'cancelled' : 'ended',
      days_left: r.current ? Math.max(0, -daysSince(r.plan_end_date)) + 1 : null,
      ended_days_ago: !r.current && !r.upcoming ? Math.max(0, daysSince(r.plan_end_date)) : null,
      invoice: r.access_token ? { number: r.invoice_id, total: r.total != null ? Number(r.total) : null, url: `${base}/reports/dl-invoice/${r.access_token}` } : null,
    })),
  });
}));

/* ------------------------------------------------------------ the quiz */
/**
 * The bot's beginQuizFor, answering with a link instead of a chat message:
 * the window, the plan, today's cap and (when switched on) the level are all
 * checked the same way, in the same order.
 */
router.post('/quiz/start', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const ctx = await getUserContext(mobile);
  if (!ctx.exists) return res.json({ success: true, message: 'Add your child first to get daily quizzes.' });
  if (!ctx.isSubscribed) {
    return res.json({ success: true, message: ctx.status === 'EXPIRED'
      ? 'Your plan has ended. Renew it to continue the daily quizzes.'
      : 'Start the free trial or choose a plan to begin the daily quizzes.' });
  }
  const hasEmail = (await db.query(`SELECT email IS NOT NULL AS ok FROM parents WHERE id = $1`, [ctx.parentId])).rows[0]?.ok;
  if (!hasEmail) return res.json({ success: true, needs_email: true, message: 'Please add your email first — reminders and reports are sent there.' });
  const st = (await getStudents(ctx.parentId)).find((s) => String(s.id) === String(req.body?.student_id));
  if (!st) return res.status(404).json({ success: false, error: 'We could not find that child.' });

  const W = require('../whatsapp/quizWindow');
  const DIFF = require('../whatsapp/difficulty');
  const Q = require('../whatsapp/quiz');
  const M = require('../whatsapp/messages');
  const where = W.state();
  if (where === 'before') return res.json({ success: true, message: `Today's quiz opens at ${M.fmtTime(W.openHHMM())}. ${st.student_name} can take it any time until ${M.fmtTime(W.CLOSE_HHMM)}.` });
  if (where === 'closed') return res.json({ success: true, message: `Today's quiz has closed (it stays open until ${M.fmtTime(W.CLOSE_HHMM)}). The next one opens tomorrow at ${M.fmtTime(W.OPEN_HHMM)}.` });

  await Q.scheduleDailyQuizzes(st.id);
  const target = await Q.ensureNextTracker(st.id, await Q.entitledSlots(st.id));
  if (!target) return res.json({ success: true, done: true, message: `${st.student_name} has finished all of today's quizzes. See you tomorrow!` });

  let level = req.body?.level != null ? DIFF.clamp(req.body.level) : null;
  if (level === null && DIFF.gradeAllows(st.grade_code) && !(await Q.trackerFilled(target.id))) {
    return res.json({ success: true, ask_level: [1, 2, 3].map((n) => ({ level: n, label: DIFF.LABELS[n] })), last_level: DIFF.label(st.difficulty_level) });
  }
  if (level !== null) {
    await db.query(`UPDATE students SET difficulty_level = $2, modified_at = now() WHERE id = $1`, [st.id, level]);
  }

  const r = await Q.startQuiz(target.id, level);
  if (r.error || !r.trackerId) {
    console.error(`[app] startQuiz failed: ${r.error} (tracker=${target.id}, student=${st.id})`);
    return res.json({ success: true, message: r.error === 'NO_QUESTIONS'
      ? `No new ${target.subject_name} questions are left for ${st.board_code} ${st.grade_name} this month. We are adding more soon.`
      : 'Sorry, we could not start the quiz. Please try again.' });
  }
  const sessionId = await ensureSession(mobile, ctx.parentId);
  const { createQuizLink } = require('./quizWebRouter');
  const { url } = await createQuizLink(sessionId, mobile, r.trackerId);
  res.json({ success: true, url, resumed: Boolean(r.resumed), test: target.quiz_type === 'test' });
}));

/* ---------------------------------------------------- reports, invoices */
router.get('/reports', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const [reports, invoices] = await Promise.all([
    db.query(
      `SELECT r.quiz_date, r.report_type, sub.subject_name, st.student_name,
              r.score_correct, r.score_total, r.score_pct, r.grade, r.access_token
         FROM quiz_reports r
         JOIN students st ON st.id = r.student_id
         JOIN parents  p  ON p.id = st.parent_id
         LEFT JOIN quizpe_tracker t ON t.id = r.tracker_id
         LEFT JOIN subjects sub     ON sub.id = t.subject_id
        WHERE p.parent_mobile_number = $1 AND r.is_active
        ORDER BY r.quiz_date DESC, r.id DESC LIMIT 200`, [mobile]),
    db.query(
      `SELECT i.invoice_id, i.created_at, i.total, i.access_token, pl.plan_name
         FROM invoices i
         JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id
         JOIN parents p ON p.id = s.parent_id
         LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
        WHERE p.parent_mobile_number = $1 AND i.is_active AND i.access_token IS NOT NULL
        ORDER BY i.created_at DESC LIMIT 50`, [mobile]),
  ]);
  res.json({
    success: true,
    reports: reports.rows.map((r) => ({
      date: r.quiz_date, type: r.report_type, child: r.student_name, subject: r.subject_name,
      score: `${r.score_correct}/${r.score_total}`, pct: r.score_pct, grade: r.grade,
      url: `${base}/reports/dl/${r.access_token}`,
    })),
    invoices: invoices.rows.map((i) => ({
      number: i.invoice_id, date: i.created_at, total: i.total != null ? Number(i.total) : null, plan: i.plan_name,
      url: `${base}/reports/dl-invoice/${i.access_token}`,
    })),
  });
}));

/*
 * THE DASHBOARD'S "THIS WEEK" AND "RECENT ACTIVITY" (user, 2026-10-10: the menu is in
 * the header, so the dashboard shows recent activity instead of the menu again).
 *   week      per child: quizzes in the last 7 days, the average score, the best, and
 *             the streak (days in a row with a finished quiz, up to today or yesterday)
 *   activity  newest first: quizzes finished (with the report), plans started, payments
 *             (with the invoice) and sign-ins (with the device)
 */
const deviceOf = (ua) => {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android phone' : /Windows/.test(s) ? 'Windows computer' : /Mac OS/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux computer' : 'a device';
  const br = /EdgA?\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  return br ? `${br} on ${os}` : os;
};
router.get('/activity', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const ctx = await getUserContext(mobile);
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const pid = ctx.exists ? ctx.parentId : null;
  const [week, days, quizzes, plans, pays, signins] = await Promise.all([
    pid ? db.query(
      `SELECT st.id, st.student_name, count(r.id)::int AS quizzes,
              round(avg(r.score_pct))::int AS avg_pct, max(r.score_pct)::int AS best_pct
         FROM students st
         LEFT JOIN quiz_reports r ON r.student_id = st.id AND r.is_active AND r.report_type IS DISTINCT FROM 'weekly'
                                 AND r.quiz_date > CURRENT_DATE - 7
        WHERE st.parent_id = $1 AND st.is_active
        GROUP BY st.id ORDER BY st.id`, [pid]) : { rows: [] },
    pid ? db.query(
      `SELECT DISTINCT r.student_id, r.quiz_date::text AS d
         FROM quiz_reports r JOIN students st ON st.id = r.student_id
        WHERE st.parent_id = $1 AND r.is_active AND r.quiz_date > CURRENT_DATE - 60`, [pid]) : { rows: [] },
    pid ? db.query(
      `SELECT r.created_at, r.quiz_date, r.report_type, st.student_name, sub.subject_name,
              r.score_correct, r.score_total, r.score_pct, r.grade, r.access_token
         FROM quiz_reports r JOIN students st ON st.id = r.student_id
         LEFT JOIN quizpe_tracker t ON t.id = r.tracker_id LEFT JOIN subjects sub ON sub.id = t.subject_id
        WHERE st.parent_id = $1 AND r.is_active
        ORDER BY r.created_at DESC LIMIT 12`, [pid]) : { rows: [] },
    pid ? db.query(
      `SELECT s.created_at, s.plan_start_date, s.plan_end_date, pl.plan_name, pl.is_trial
         FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
        WHERE s.parent_id = $1 ORDER BY s.created_at DESC LIMIT 5`, [pid]) : { rows: [] },
    pid ? db.query(
      `SELECT i.created_at, i.invoice_id, i.total, i.access_token, pl.plan_name
         FROM invoices i JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id
         LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
        WHERE s.parent_id = $1 AND i.is_active ORDER BY i.created_at DESC LIMIT 5`, [pid]) : { rows: [] },
    db.query(
      `SELECT created_at, user_agent, id = $2 AS this_one FROM parent_web_sessions
        WHERE mobile_number = $1 ORDER BY created_at DESC LIMIT 5`, [mobile, req.parentSessionId]),
  ]);

  // The streak: days in a row with a finished quiz, ending today (or yesterday, when today's is still to come).
  const todayIST = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const dayBefore = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  const streakOf = (sid) => {
    const set = new Set(days.rows.filter((r) => String(r.student_id) === String(sid)).map((r) => r.d));
    let d = set.has(todayIST) ? todayIST : dayBefore(todayIST);
    let n = 0;
    while (set.has(d)) { n += 1; d = dayBefore(d); }
    return n;
  };

  const items = [
    ...quizzes.rows.map((r) => ({
      kind: 'quiz', at: r.created_at, child: r.student_name, subject: r.subject_name, weekly: r.report_type === 'weekly',
      score: `${r.score_correct}/${r.score_total}`, pct: r.score_pct, grade: r.grade,
      url: r.access_token ? `${base}/reports/dl/${r.access_token}` : null,
    })),
    ...plans.rows.map((r) => ({ kind: 'plan', at: r.created_at, plan: r.plan_name, trial: r.is_trial, starts: r.plan_start_date, ends: r.plan_end_date })),
    ...pays.rows.map((r) => ({
      kind: 'payment', at: r.created_at, plan: r.plan_name, number: r.invoice_id, total: r.total != null ? Number(r.total) : null,
      url: r.access_token ? `${base}/reports/dl-invoice/${r.access_token}` : null,
    })),
    ...signins.rows.map((r) => ({ kind: 'signin', at: r.created_at, device: deviceOf(r.user_agent), this_device: r.this_one })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 15);

  res.json({
    success: true,
    week: week.rows.map((r) => ({ id: r.id, child: r.student_name, quizzes: r.quizzes, avg_pct: r.avg_pct, best_pct: r.best_pct, streak: streakOf(r.id) })),
    activity: items,
  });
}));

/* ------------------------------------------------------ trial, checkout */
router.post('/trial', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const ctx = await getUserContext(mobile);
  if (!ctx.canStartTrial) {
    return res.status(409).json({ success: false, error: ctx.trialUsed
      ? 'The free trial has already been used on this number. Please choose a plan.'
      : 'You already have an active plan.' });
  }
  const name = String(req.body?.parent_name || ctx.parentName || '').trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Please enter your name.' });
  // Required (user, 2026-10-08): reminders, reports and plan notices go there.
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, error: 'Please enter a valid email address — reminders and reports are sent there.' });
  const sessionId = await ensureSession(mobile, ctx.parentId || null);
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || jsonb_build_object('parent_name', $2::text, 'email', $3::text), modified_at = now() WHERE id = $1`,
    [sessionId, name, email]);
  if (ctx.parentId) await db.query(`UPDATE parents SET email = $2, modified_at = now() WHERE id = $1`, [ctx.parentId, email]);
  const { createSignupLink } = require('./trialRouter');
  const { url } = await createSignupLink(sessionId, mobile, name);
  res.json({ success: true, url });
}));

router.post('/checkout', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const code = String(req.body?.plan_code || '');
  const plan = (await db.query(
    `SELECT plan_code FROM quizpe_plans
      WHERE plan_code = $1 AND is_active AND price > 0
        AND duration > 0 AND plan_code NOT IN ('INSTANT', 'QUICK_QUIZ')`, [code])).rows[0];
  if (!plan) return res.status(400).json({ success: false, error: 'That plan is not available.' });
  const ctx = await getUserContext(mobile);
  const sessionId = await ensureSession(mobile, ctx.parentId || null);
  const { createCheckoutLink, checkoutTtlLabel } = require('./paymentRouter');
  const { url } = await createCheckoutLink(sessionId, mobile, plan.plan_code);
  // Two ways to pay (2026-10-02, kept on the web 2026-10-08): the parent pays
  // now and comes back here (&from=app), or sends the link to whoever pays —
  // it works on the token alone, for CHECKOUT_TTL_MIN, and switches the plan
  // on for THIS parent's number.
  const forSomeone = req.body?.someone_else === true;
  res.json({ success: true, url: forSomeone ? url : `${url}&from=app`, valid_for: checkoutTtlLabel(), someone_else: forSomeone });
}));

/* ------------------------------------------- the WhatsApp menu, on the web
 * (user, 2026-10-10: "the many tappable options WhatsApp gave — include them the
 * same way in the PWA"). "My subscription" and "Quiz schedule" answer with the bot's
 * own words (whatsapp/messages.js), minus its "type menu" lines; "Support" opens the
 * same request form the bot linked to (support.html), keyed to this family.
 */
const forWeb = (text) => String(text || '').split('\n').filter((l) => !/type \*?menu\*?/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
router.get('/info/:what', wrap(async (req, res) => {
  const M = require('../whatsapp/messages');
  const ctx = await getUserContext(req.parentMobile);
  const kids = ctx.exists ? await getStudents(ctx.parentId) : [];
  const what = req.params.what;
  if (what === 'subscription') return res.json({ success: true, text: forWeb(await M.subscriptionDetails(ctx, kids)) });
  if (what === 'schedule') return res.json({ success: true, text: forWeb(M.quizSchedule(ctx, kids)) });
  res.status(404).json({ success: false, error: 'Not found.' });
}));
router.post('/support', wrap(async (req, res) => {
  const ctx = await getUserContext(req.parentMobile);
  const sessionId = await ensureSession(req.parentMobile, ctx.parentId || null);
  const { createSupportLink } = require('./supportWebRouter');
  const { url } = await createSupportLink(sessionId, req.parentMobile, ctx.parentId || null);
  res.json({ success: true, url });
}));

/* ---------------------------------------------------------- phone push */
router.get('/push-key', wrap(async (req, res) => {
  res.json({ success: true, key: await require('../admin/hq/push').publicKey() });
}));
router.post('/push', wrap(async (req, res) => {
  await notify.subscribe(req.parentMobile, req.body?.subscription);
  res.json({ success: true });
}));
router.post('/push/off', wrap(async (req, res) => {
  if (req.body?.endpoint) await notify.unsubscribe(String(req.body.endpoint));
  res.json({ success: true });
}));

module.exports = router;
module.exports.ensureSession = ensureSession;
