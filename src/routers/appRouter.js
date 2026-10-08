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
  res.json({ success: true, token: r.token, mobile: r.mobile });
}));

router.post('/signout', wrap(async (req, res) => {
  await auth.signOut(req);
  res.json({ success: true });
}));

router.use(auth.requireParent);

/* ------------------------------------------------------------------- me */
router.get('/me', wrap(async (req, res) => {
  const mobile = req.parentMobile;
  const ctx = await getUserContext(mobile);
  const W = require('../whatsapp/quizWindow');
  const DIFF = require('../whatsapp/difficulty');
  const Q = require('../whatsapp/quiz');

  const kids = ctx.exists ? await getStudents(ctx.parentId) : [];
  const children = [];
  for (const s of kids) {
    let today = null;
    try { today = await Q.dailyQuizProgress(s.id); } catch { today = null; }
    children.push({
      id: s.id, name: s.student_name, board: s.board_code, grade: s.grade_name, school: s.school_name,
      today: today ? { done: today.done, total: today.total, has_next: today.hasNext } : null,
      can_choose_level: DIFF.gradeAllows(s.grade_code), last_level: DIFF.label(s.difficulty_level),
    });
  }
  const parent = ctx.exists
    ? (await db.query(`SELECT parent_name, email FROM parents WHERE id = $1`, [ctx.parentId])).rows[0]
    : (await db.query(`SELECT context->>'parent_name' AS parent_name, NULLIF(context->>'email', '') AS email FROM whatsapp_sessions WHERE mobile_number = $1 ORDER BY id DESC LIMIT 1`, [mobile])).rows[0];
  const plans = (await db.query(
    `SELECT plan_code, plan_name, price, comparable_price, student_count, duration
       FROM quizpe_plans WHERE is_active AND price > 0 AND NOT coalesce(is_instant, false) AND NOT coalesce(is_quick, false)
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
    plan: ctx.planName ? { name: ctx.planName, trial: Boolean(ctx.isTrial), ends: ctx.endDate, days_left: ctx.daysLeft, seats: ctx.seatLimit } : null,
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
        AND NOT coalesce(is_instant, false) AND NOT coalesce(is_quick, false)`, [code])).rows[0];
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
