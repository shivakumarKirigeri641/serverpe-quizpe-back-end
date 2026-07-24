/**
 * src/routers/adminRouter.js
 * ---------------------------------------------------------------------------
 * The admin panel API. Everything except /login sits behind requireAdmin.
 *
 * Conventions:
 *   • every response is { success, ... } so the client has one shape to handle
 *   • list endpoints take ?limit&offset and return { rows, total }
 *   • nothing here trusts a query param: ids are cast, limits are clamped,
 *     and anything interpolated into SQL comes from a fixed allow-list
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../database/connectDB');
const { login, requestCode, requireAdmin, requireSuperAdmin, adminMobiles, isSuperAdmin } = require('../admin/auth');
const otp = require('../admin/otp');
const metrics = require('../admin/metrics');

const router = express.Router();

// Customer CRUD + guarded deletion lives in its own module — see the delete
// policy documented there before changing anything.
router.use(require('../admin/customerRoutes'));
// question_bank grid, CRUD and the Excel import pipeline
router.use(require('../admin/questionRoutes'));
// read-only WhatsApp conversation history
router.use(require('../admin/whatsappRoutes'));
// website enquiries + testimonial moderation
router.use(require('../admin/inboxRoutes'));

const clamp = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

/* -------------------------------------------------------------------- auth */

/**
 * Step 1 — send a one-time code by SMS.
 *
 * Single-admin panel: a number that is not the administrator's is refused
 * outright (403), so it is obvious that only the authorised number works.
 */
router.post('/otp', express.json(), async (req, res) => {
  const { mobile } = req.body || {};
  const ip = req.ip || req.socket.remoteAddress || 'local';
  // Validate here, not only in the browser. Without this, a direct POST of any
  // junk reaches the SMS provider and writes a row — the client-side check is a
  // convenience for the admin, never a control.
  if (!/^[6-9]\d{9}$/.test(String(mobile || '').replace(/\D/g, '').slice(-10))) {
    return fail(res, 400, 'Enter a valid 10-digit mobile number.');
  }
  try {
    const r = await requestCode(mobile, ip);
    if (r.unauthorized) return fail(res, 403, r.error);        // not an admin
    if (r.error) return fail(res, 429, r.error);               // throttled etc.
    ok(res, { ttlMin: r.ttlMin, message: `A code is on its way. It is valid for ${r.ttlMin} minutes.` });
  } catch (e) {
    console.error('[admin] otp request failed:', e.message);
    fail(res, 500, e.message.startsWith('ADMIN AUTH') ? e.message : 'Could not send the code.');
  }
});

/** Step 2 — exchange the code for a session token. */
router.post('/login', express.json(), async (req, res) => {
  const { mobile } = req.body || {};
  // `code` is the OTP; `pin` is still accepted so the local dev shortcut works.
  const credential = req.body?.code ?? req.body?.pin;
  const ip = req.ip || req.socket.remoteAddress || 'local';
  try {
    const r = await login(mobile, credential, ip);
    if (r.error) return fail(res, 401, r.error);
    ok(res, r);
  } catch (e) {
    console.error('[admin] login failed:', e.message);
    fail(res, 500, e.message.startsWith('ADMIN AUTH') ? e.message : 'Could not sign in.');
  }
});

/**
 * Branding for the panel — company name, tagline, GSTIN, logo paths. Public on
 * purpose: the login screen needs it before a token exists. Contains only what
 * already appears on public invoices and the website, never customer data.
 */
router.get('/branding', async (req, res) => {
  try {
    const b = (await db.query(
      `SELECT company_name, company_tagline, product_name, product_tagline,
              proprietor_name, gstin, address, support_email, product_website
         FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};
    const fs2 = require('fs');
    const dir = path.join(__dirname, '..', '..', 'public', 'assets');
    const logos = fs2.existsSync(dir)
      ? fs2.readdirSync(dir).filter(f => /\.(png|svg|jpg)$/i.test(f))
          .reduce((a, f) => (a[f.replace(/\.\w+$/, '')] = `/assets/${f}`, a), {})
      : {};
    ok(res, { business: b, logos });
  } catch (e) {
    console.error('[admin] branding:', e.message);
    fail(res, 500, 'Could not load branding.');
  }
});

router.get('/me', requireAdmin, (req, res) => ok(res, { mobile: req.admin.sub, super: !!req.admin.super }));

/* --------------------------------------------------------------- dashboard */
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const [overview, comparisons, plans, feed] = await Promise.all([
      metrics.overview(), metrics.comparisons(), metrics.planSplit(), metrics.enrolmentFeed(10),
    ]);
    ok(res, { overview, comparisons, plans, feed });
  } catch (e) {
    console.error('[admin] dashboard:', e.message);
    fail(res, 500, 'Could not load the dashboard.');
  }
});

/** Cohort health as percentages — participation, scoring spread, movement. */
router.get('/analytics/cohort', requireAdmin, async (req, res) => {
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    ok(res, await metrics.cohort(day));
  } catch (e) { console.error('[admin] cohort:', e.message); fail(res, 500, 'Could not load cohort metrics.'); }
});

/** Enrolled vs attended, per day — the attendance bar chart. */
router.get('/analytics/participation', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await metrics.participationDaily(clamp(req.query.days, 30, 365)) }); }
  catch (e) { console.error('[admin] participation:', e.message); fail(res, 500, 'Could not load attendance.'); }
});

router.get('/analytics/daily', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await metrics.daily(clamp(req.query.days, 30, 365)) }); }
  catch (e) { console.error('[admin] daily:', e.message); fail(res, 500, 'Could not load trends.'); }
});

router.get('/analytics/plans', requireAdmin, async (req, res) => {
  try { ok(res, await metrics.planSplit()); }
  catch (e) { console.error('[admin] plans:', e.message); fail(res, 500, 'Could not load plan data.'); }
});

router.get('/analytics/engagement', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await metrics.engagement() }); }
  catch (e) { console.error('[admin] engagement:', e.message); fail(res, 500, 'Could not load engagement.'); }
});

/**
 * Enrolment, today's attendance and 28-day performance for every board and
 * grade we sell — including the empty ones, which are the interesting ones.
 */
router.get('/analytics/board-grade', requireAdmin, async (req, res) => {
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;
    const [rows, totals] = await Promise.all([
      metrics.boardGradeBreakdown(day), metrics.boardTotals(day),
    ]);
    ok(res, { rows, totals, date: day || new Date().toISOString().slice(0, 10) });
  } catch (e) {
    console.error('[admin] board-grade:', e.message);
    fail(res, 500, 'Could not load the board and grade breakdown.');
  }
});

/** Launch offer status, so the dashboard can show seats remaining. */
router.get('/analytics/launch-offer', requireAdmin, async (req, res) => {
  try { ok(res, await require('../utils/launchOffer').status()); }
  catch (e) { console.error('[admin] launch-offer:', e.message); fail(res, 500, 'Could not load offer status.'); }
});

/** Unified activity stream: quizzes, subscriptions, feedback, support. */
router.get('/activity', requireAdmin, async (req, res) => {
  try {
    const activity = require('../admin/activity');
    const kinds = req.query.kinds ? String(req.query.kinds).split(',').filter(Boolean) : null;
    const [rows, counts] = await Promise.all([
      activity.feed({ limit: clamp(req.query.limit, 60, 200), since: req.query.since || null, kinds }),
      activity.todayCounts(),
    ]);
    ok(res, { rows, counts });
  } catch (e) { console.error('[admin] activity:', e.message); fail(res, 500, 'Could not load activity.'); }
});

/** Tonight's per-student status board. */
router.get('/tonight', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await require('../admin/activity').tonight() }); }
  catch (e) { console.error('[admin] tonight:', e.message); fail(res, 500, 'Could not load tonight.'); }
});

/** The "watching view" — newest enrolments first. */
router.get('/feed', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await metrics.enrolmentFeed(clamp(req.query.limit, 50, 200)) }); }
  catch (e) { console.error('[admin] feed:', e.message); fail(res, 500, 'Could not load the feed.'); }
});

/* ----------------------------------------------------------------- parents */
router.get('/parents', requireAdmin, async (req, res) => {
  const limit = clamp(req.query.limit, 25, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = `%${String(req.query.q || '').trim()}%`;
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.parent_name, p.parent_mobile_number, p.state_code, p.reminders_enabled,
             p.is_active, p.created_at,
             (SELECT COUNT(*)::int FROM students st WHERE st.parent_id=p.id AND st.is_active) AS children,
             pl.plan_code, pl.plan_name, pl.is_trial,
             s.plan_start_date::text, s.plan_end_date::text,
             (s.id IS NOT NULL AND s.is_active AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS subscribed,
             COALESCE((SELECT SUM(i.total) FROM invoices i
                        JOIN parents_quizpe_subscriptions s2 ON s2.id=i.subscription_id
                       WHERE s2.parent_id=p.id AND i.is_active),0)::numeric AS lifetime_value,
             COUNT(*) OVER()::int AS total
        FROM parents p
        LEFT JOIN LATERAL (SELECT * FROM parents_quizpe_subscriptions x
                            WHERE x.parent_id=p.id ORDER BY x.plan_end_date DESC, x.id DESC LIMIT 1) s ON true
        LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
       WHERE ($1 = '%%' OR p.parent_name ILIKE $1 OR p.parent_mobile_number ILIKE $1)
       ORDER BY p.id DESC LIMIT $2 OFFSET $3`, [q, limit, offset]);
    ok(res, { rows, total: rows[0]?.total || 0 });
  } catch (e) { console.error('[admin] parents:', e.message); fail(res, 500, 'Could not load parents.'); }
});

/** One parent with children nested — the dependency view. */
router.get('/parents/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad parent id.');
  try {
    const parent = (await db.query(`SELECT * FROM parents WHERE id=$1`, [id])).rows[0];
    if (!parent) return fail(res, 404, 'Parent not found.');

    const [students, subs, invoices, tickets, feedback] = await Promise.all([
      db.query(`SELECT st.*, b.board_code, g.grade_name, m.medium_code
                  FROM students st
                  JOIN boards b ON b.id=st.board_id JOIN grades g ON g.id=st.grade_id
                  LEFT JOIN mediums m ON m.id=st.medium_id
                 WHERE st.parent_id=$1 ORDER BY st.id`, [id]),
      db.query(`SELECT s.*, pl.plan_code, pl.plan_name, pl.is_trial, pl.price::numeric
                  FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id=s.plan_id
                 WHERE s.parent_id=$1 ORDER BY s.id DESC`, [id]),
      db.query(`SELECT i.* FROM invoices i
                  JOIN parents_quizpe_subscriptions s ON s.id=i.subscription_id
                 WHERE s.parent_id=$1 ORDER BY i.id DESC`, [id]),
      db.query(`SELECT * FROM support_tickets WHERE parent_id=$1 ORDER BY id DESC`, [id]),
      db.query(`SELECT * FROM feedbacks WHERE parent_id=$1 ORDER BY id DESC LIMIT 20`, [id]),
    ]);
    ok(res, {
      parent, students: students.rows, subscriptions: subs.rows,
      invoices: invoices.rows, tickets: tickets.rows, feedback: feedback.rows,
    });
  } catch (e) { console.error('[admin] parent detail:', e.message); fail(res, 500, 'Could not load the parent.'); }
});

/* ---------------------------------------------------------------- students */

/** Board/grade/medium options the admin form can offer — content-driven. */
router.get('/lookups', requireAdmin, async (req, res) => {
  try {
    const { getAvailability } = require('../content/availability');
    const a = await getAvailability();
    ok(res, { availability: a.availability, boards: a.boards, grades: a.grades });
  } catch (e) { console.error('[admin] lookups:', e.message); fail(res, 500, 'Could not load options.'); }
});

/**
 * Add a child to an existing parent.
 *
 * Two guards that matter commercially:
 *   • the plan's student_count is a SEAT LIMIT — quietly exceeding it gives
 *     away subscriptions, so it is refused unless the admin passes override
 *   • the board/grade/medium must have questions, or the child would get a
 *     broken quiz on day one
 */
router.post('/parents/:id/students', requireAdmin, express.json(), async (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const { student_name, school_name, board, grade, medium, override } = req.body || {};
  if (!parentId) return fail(res, 400, 'Bad parent id.');
  if (!String(student_name || '').trim()) return fail(res, 400, "Please give the child's name.");
  if (!board || !grade || !medium) return fail(res, 400, 'Board, grade and medium are all required.');

  try {
    const { isDeliverable } = require('../content/availability');
    if (!await isDeliverable(board, grade, medium)) {
      return fail(res, 400, `No quiz content for ${board} · ${grade} · ${medium} yet.`);
    }

    // seat check against the parent's current plan
    const seat = (await db.query(
      `SELECT pl.student_count, pl.plan_name, pl.is_trial,
              (SELECT COUNT(*)::int FROM students st WHERE st.parent_id=$1 AND st.is_active) AS used
         FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id=s.plan_id
        WHERE s.parent_id=$1 AND s.is_active
        ORDER BY s.id DESC LIMIT 1`, [parentId])).rows[0];

    if (seat && seat.used >= seat.student_count && !override) {
      return res.status(409).json({
        success: false, seatLimit: true,
        error: `${seat.plan_name} covers ${seat.student_count} child${seat.student_count > 1 ? 'ren' : ''} `
             + `and ${seat.used} are already enrolled. Upgrade the plan, or resend with override to add anyway.`,
      });
    }

    const ids = (await db.query(
      `SELECT (SELECT id FROM boards WHERE board_code=$1) b,
              (SELECT id FROM grades WHERE grade_code=$2) g,
              (SELECT id FROM mediums WHERE medium_code=$3) m`, [board, grade, medium])).rows[0];
    if (!ids.b || !ids.g || !ids.m) return fail(res, 400, 'Unknown board, grade or medium.');

    const { rows } = await db.query(
      `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name, school_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (parent_id, student_name) DO UPDATE
         SET board_id=EXCLUDED.board_id, grade_id=EXCLUDED.grade_id,
             medium_id=EXCLUDED.medium_id,
             school_name=COALESCE(EXCLUDED.school_name, students.school_name),
             is_active=true, modified_at=now()
       RETURNING id`,
      [parentId, ids.b, ids.g, ids.m, String(student_name).trim().slice(0, 60),
       String(school_name || '').trim().slice(0, 120) || null]);
    ok(res, { id: rows[0].id, seat });
  } catch (e) {
    console.error('[admin] add student:', e.message);
    fail(res, 400, e.message);
  }
});

/** Edit or deactivate a child. */
router.patch('/students/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad student id.');
  const { student_name, school_name, board, grade, medium, is_active } = req.body || {};
  try {
    if (board && grade && medium) {
      const { isDeliverable } = require('../content/availability');
      if (!await isDeliverable(board, grade, medium)) {
        return fail(res, 400, `No quiz content for ${board} · ${grade} · ${medium} yet.`);
      }
    }
    const { rows } = await db.query(
      `UPDATE students SET
         student_name = COALESCE($2, student_name),
         school_name  = COALESCE($3, school_name),
         board_id     = COALESCE((SELECT id FROM boards  WHERE board_code=$4),  board_id),
         grade_id     = COALESCE((SELECT id FROM grades  WHERE grade_code=$5),  grade_id),
         medium_id    = COALESCE((SELECT id FROM mediums WHERE medium_code=$6), medium_id),
         is_active    = COALESCE($7, is_active),
         modified_at  = now()
       WHERE id = $1 RETURNING *`,
      [id, student_name || null, school_name || null, board || null, grade || null,
       medium || null, typeof is_active === 'boolean' ? is_active : null]);
    if (!rows.length) return fail(res, 404, 'Student not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] edit student:', e.message); fail(res, 400, e.message); }
});

router.get('/students/:id/quizzes', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad student id.');
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.quiz_date::text, t.quiz_type, t.question_count,
             qs.status_code, sub.subject_name,
             r.score_correct, r.score_total, r.score_pct, r.grade, r.id AS report_id
        FROM quizpe_tracker t
        JOIN quizpe_status qs ON qs.id=t.status_id
        JOIN subjects sub ON sub.id=t.subject_id
        LEFT JOIN quiz_reports r ON r.tracker_id=t.id
       WHERE t.student_id=$1 ORDER BY t.quiz_date DESC, t.id DESC`, [id]);
    ok(res, { rows });
  } catch (e) { console.error('[admin] student quizzes:', e.message); fail(res, 500, 'Could not load quizzes.'); }
});

/**
 * Every question in one quiz with the options, the correct answer and what
 * the child actually chose — the MCQ detail view.
 */
router.get('/quizzes/:trackerId', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.trackerId, 10);
  if (!id) return fail(res, 400, 'Bad quiz id.');
  try {
    const head = (await db.query(`
      SELECT t.id, t.quiz_date::text, t.quiz_type, qs.status_code,
             st.id AS student_id, st.student_name, st.school_name,
             b.board_code, g.grade_name, m.medium_code, sub.subject_name,
             p.parent_name, p.parent_mobile_number,
             r.score_correct, r.score_total, r.score_pct, r.grade
        FROM quizpe_tracker t
        JOIN students st ON st.id=t.student_id
        JOIN parents p ON p.id=st.parent_id
        JOIN boards b ON b.id=st.board_id JOIN grades g ON g.id=st.grade_id
        LEFT JOIN mediums m ON m.id=st.medium_id
        JOIN subjects sub ON sub.id=t.subject_id
        JOIN quizpe_status qs ON qs.id=t.status_id
        LEFT JOIN quiz_reports r ON r.tracker_id=t.id
       WHERE t.id=$1`, [id])).rows[0];
    if (!head) return fail(res, 404, 'Quiz not found.');

    const { rows: questions } = await db.query(`
      SELECT h.serial_number, h.answered_option, h.is_correct, h.response_seconds,
             h.answered_at, qb.chapter, qb.question_pdf, qb.question_whatsapp,
             qb.option_a, qb.option_b, qb.option_c, qb.option_d, qb.answer, qb.explanation
        FROM student_quizpe_histories h
        JOIN question_bank qb ON qb.id=h.question_id
       WHERE h.tracker_id=$1 ORDER BY h.serial_number`, [id]);
    ok(res, { head, questions });
  } catch (e) { console.error('[admin] quiz detail:', e.message); fail(res, 500, 'Could not load the quiz.'); }
});

/* ----------------------------------------------------------------- reports */
router.get('/reports', requireAdmin, async (req, res) => {
  const limit = clamp(req.query.limit, 50, 200);
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.report_type, r.quiz_date::text, r.file_name, r.score_correct,
             r.score_total, r.score_pct, r.grade, r.download_count,
             st.student_name, p.parent_name, p.parent_mobile_number
        FROM quiz_reports r
        JOIN students st ON st.id=r.student_id
        JOIN parents p ON p.id=st.parent_id
       WHERE r.is_active ORDER BY r.id DESC LIMIT $1`, [limit]);
    ok(res, { rows });
  } catch (e) { console.error('[admin] reports:', e.message); fail(res, 500, 'Could not load reports.'); }
});

/** Inline view for the preview pane — same file, shown rather than downloaded. */
router.get('/reports/:id/view', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = (await db.query('SELECT file_path, file_name FROM quiz_reports WHERE id=$1', [id])).rows[0];
    if (!r) return fail(res, 404, 'Report not found.');
    const { REPORTS_ROOT } = require('../pdf/dailyReport');
    const abs = path.join(REPORTS_ROOT, r.file_path);
    if (!fs.existsSync(abs)) return fail(res, 410, 'The PDF is no longer on disk.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.file_name}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) { console.error('[admin] report view:', e.message); fail(res, 500, 'Could not open the report.'); }
});

/** Stream a report PDF straight to the admin (no OTP — already authenticated). */
router.get('/reports/:id/download', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = (await db.query(`SELECT file_path, file_name FROM quiz_reports WHERE id=$1`, [id])).rows[0];
    if (!r) return fail(res, 404, 'Report not found.');
    const { REPORTS_ROOT } = require('../pdf/dailyReport');
    const abs = path.join(REPORTS_ROOT, r.file_path);
    if (!fs.existsSync(abs)) return fail(res, 410, 'The PDF is no longer on disk.');
    res.download(abs, r.file_name);
  } catch (e) { console.error('[admin] report download:', e.message); fail(res, 500, 'Could not send the report.'); }
});

/* --------------------------------------------------------------- financial */
/** The founder's money view: turnover, GST set-aside and withdrawable profit. */
router.get('/finance/summary', requireAdmin, async (req, res) => {
  try { ok(res, await require('../admin/finance').summary()); }
  catch (e) { console.error('[admin] finance summary:', e.message); fail(res, 500, 'Could not load the money view.'); }
});

router.get('/finance/monthly', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await require('../admin/finance').monthly(clamp(req.query.months, 12, 36)) }); }
  catch (e) { console.error('[admin] finance monthly:', e.message); fail(res, 500, 'Could not load monthly figures.'); }
});

/* ---- expenses: what the founder spent, so profit is real not just turnover */
router.get('/finance/expenses', requireAdmin, async (req, res) => {
  try { ok(res, { rows: await require('../admin/finance').listExpenses(clamp(req.query.limit, 100, 500)),
                  categories: require('../admin/finance').CATEGORIES }); }
  catch (e) { console.error('[admin] expenses:', e.message); fail(res, 500, 'Could not load expenses.'); }
});

router.post('/finance/expenses', requireAdmin, express.json(), async (req, res) => {
  try {
    const id = await require('../admin/finance').addExpense({ ...req.body, added_by: req.admin?.sub });
    ok(res, { id });
  } catch (e) {
    // Validation errors are the user's to fix, so surface the message.
    fail(res, 400, e.message || 'Could not save the expense.');
  }
});

router.delete('/finance/expenses/:id', requireAdmin, async (req, res) => {
  try {
    const done = await require('../admin/finance').removeExpense(Number(req.params.id));
    done ? ok(res, { removed: true }) : fail(res, 404, 'Expense not found.');
  } catch (e) { console.error('[admin] remove expense:', e.message); fail(res, 500, 'Could not remove the expense.'); }
});

router.get('/finance/invoices', requireAdmin, async (req, res) => {
  const limit = clamp(req.query.limit, 100, 500);
  try {
    const { rows } = await db.query(`
      SELECT i.id, i.invoice_id, i.amount_base::numeric, i.gst_pct, i.cgst::numeric,
             i.sgst::numeric, i.igst::numeric, i.total::numeric, i.created_at,
             p.parent_name, p.parent_mobile_number, p.state_code,
             pl.plan_name, pl.plan_code
        FROM invoices i
        JOIN parents_quizpe_subscriptions s ON s.id=i.subscription_id
        JOIN parents p ON p.id=s.parent_id
        JOIN quizpe_plans pl ON pl.id=s.plan_id
       WHERE i.is_active ORDER BY i.id DESC LIMIT $1`, [limit]);
    ok(res, { rows });
  } catch (e) { console.error('[admin] invoices:', e.message); fail(res, 500, 'Could not load invoices.'); }
});

/** GSTR-1 ready summary for a filing period (YYYY-MM). */
router.get('/finance/gstr1', requireAdmin, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period || '')
    ? req.query.period
    : new Date().toISOString().slice(0, 7);
  try {
    const { rows } = await db.query(
      `SELECT invoice_number, invoice_date::text, customer_name, customer_mobile,
              customer_state_code, place_of_supply, supply_type, gstr1_table, invoice_type,
              sac_code, description, taxable_value::numeric, gst_rate,
              cgst_amount::numeric, sgst_amount::numeric, igst_amount::numeric,
              invoice_value::numeric, filing_status
         FROM gstr1_filing WHERE filing_period=$1 AND is_active ORDER BY invoice_number`, [period]);
    const { rows: [totals] } = await db.query(`
      SELECT COUNT(*)::int invoices,
             COALESCE(SUM(taxable_value),0)::numeric taxable,
             COALESCE(SUM(cgst_amount),0)::numeric cgst,
             COALESCE(SUM(sgst_amount),0)::numeric sgst,
             COALESCE(SUM(igst_amount),0)::numeric igst,
             COALESCE(SUM(invoice_value),0)::numeric total
        FROM gstr1_filing WHERE filing_period=$1 AND is_active`, [period]);
    const { rows: periods } = await db.query(
      `SELECT DISTINCT filing_period FROM gstr1_filing WHERE is_active ORDER BY filing_period DESC`);
    ok(res, { period, rows, totals, periods: periods.map(p => p.filing_period) });
  } catch (e) { console.error('[admin] gstr1:', e.message); fail(res, 500, 'Could not load GST data.'); }
});

/* ---------------------------------------------------------------- lookups */
// CRUD is limited to the reference tables an admin genuinely edits. Parents,
// students and question_bank are deliberately read-only here: editing them by
// hand would desync live quizzes and the adaptive engine.
const EDITABLE = {
  quizpe_plans: ['plan_code', 'plan_name', 'plan_description', 'price', 'comparable_price',
    'student_count', 'duration', 'is_trial', 'is_active'],
  quizpe_addons: ['subject_id', 'price', 'comparable_price', 'is_active'],
  quizpe_offers: ['title', 'description', 'is_active'],
  quizpe_benefits: ['benefit_title', 'benefit_description', 'sort_order', 'is_active'],
  policies: ['policy_code', 'version', 'title', 'summary', 'url', 'is_active'],
  business_details: ['company_name', 'company_tagline', 'product_name', 'product_tagline',
    'proprietor_name', 'gstin', 'pan', 'address', 'support_email', 'product_website', 'is_active'],
};

router.get('/tables/:name', requireAdmin, async (req, res) => {
  const t = req.params.name;
  if (!EDITABLE[t]) return fail(res, 404, 'That table is not editable here.');
  try {
    const { rows } = await db.query(`SELECT * FROM ${t} ORDER BY id`);
    ok(res, { rows, columns: EDITABLE[t] });
  } catch (e) { console.error('[admin] table read:', e.message); fail(res, 500, 'Could not read the table.'); }
});

router.patch('/tables/:name/:id', requireAdmin, express.json(), async (req, res) => {
  const t = req.params.name;
  const cols = EDITABLE[t];
  if (!cols) return fail(res, 404, 'That table is not editable here.');
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad id.');

  // only allow-listed columns reach the SQL — never a key from the request
  const sets = [], vals = [];
  for (const c of cols) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, c)) {
      vals.push(req.body[c]); sets.push(`${c} = $${vals.length}`);
    }
  }
  if (!sets.length) return fail(res, 400, 'Nothing to update.');
  vals.push(id);
  try {
    const { rows } = await db.query(
      `UPDATE ${t} SET ${sets.join(', ')}, modified_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return fail(res, 404, 'Row not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] table update:', e.message); fail(res, 400, e.message); }
});

/* ------------------------------------------------------------------ legal */
router.get('/legal', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*, COUNT(s.id)::int sections
         FROM legal_documents d LEFT JOIN legal_sections s ON s.document_id = d.id
        GROUP BY d.id ORDER BY d.display_order, d.id`);
    ok(res, { rows });
  } catch (e) { console.error('[admin] legal list:', e.message); fail(res, 500, 'Could not load policies.'); }
});

router.get('/legal/:code', requireAdmin, async (req, res) => {
  try {
    const doc = (await db.query(
      'SELECT * FROM legal_documents WHERE doc_code = $1', [req.params.code])).rows[0];
    if (!doc) return fail(res, 404, 'No such policy.');
    const { rows: sections } = await db.query(
      `SELECT * FROM legal_sections WHERE document_id = $1 ORDER BY display_order, id`, [doc.id]);
    ok(res, { document: doc, sections });
  } catch (e) { console.error('[admin] legal read:', e.message); fail(res, 500, 'Could not load the policy.'); }
});

router.patch('/legal/document/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, summary, version, requires_consent, is_active, effective_from } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE legal_documents SET
         title=COALESCE($2,title), summary=COALESCE($3,summary), version=COALESCE($4,version),
         requires_consent=COALESCE($5,requires_consent), is_active=COALESCE($6,is_active),
         effective_from=COALESCE($7::date,effective_from), modified_at=now()
       WHERE id=$1 RETURNING *`,
      [id, title || null, summary || null, version || null,
       typeof requires_consent === 'boolean' ? requires_consent : null,
       typeof is_active === 'boolean' ? is_active : null, effective_from || null]);
    if (!rows.length) return fail(res, 404, 'Policy not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] legal doc update:', e.message); fail(res, 400, e.message); }
});

router.patch('/legal/section/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, description, section_no, display_order, is_active } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE legal_sections SET
         title=COALESCE($2,title), description=COALESCE($3,description),
         section_no=COALESCE($4,section_no), display_order=COALESCE($5,display_order),
         is_active=COALESCE($6,is_active), modified_at=now()
       WHERE id=$1 RETURNING *`,
      [id, title || null, description || null, section_no || null,
       display_order ?? null, typeof is_active === 'boolean' ? is_active : null]);
    if (!rows.length) return fail(res, 404, 'Section not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] legal section update:', e.message); fail(res, 400, e.message); }
});

router.post('/legal/:docId/section', requireAdmin, express.json(), async (req, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { section_no, title, description } = req.body || {};
  if (!title || !description) return fail(res, 400, 'A section needs a title and description.');
  try {
    const { rows } = await db.query(
      `INSERT INTO legal_sections (document_id, section_no, title, description, display_order)
       VALUES ($1,$2,$3,$4, COALESCE((SELECT MAX(display_order)+10 FROM legal_sections WHERE document_id=$1),10))
       RETURNING *`, [docId, section_no || null, title, description]);
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] legal section add:', e.message); fail(res, 400, e.message); }
});

/* ---------------------------------------------------------------- support */
router.get('/support', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM support_tickets ORDER BY (status='open') DESC, id DESC LIMIT 200`);
    ok(res, { rows });
  } catch (e) { console.error('[admin] support:', e.message); fail(res, 500, 'Could not load tickets.'); }
});

router.patch('/support/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.body?.status)
    ? req.body.status : null;
  if (!id || !status) return fail(res, 400, 'Bad ticket update.');
  try {
    const { rows } = await db.query(
      `UPDATE support_tickets
          SET status=$2, resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END,
              modified_at=now()
        WHERE id=$1 RETURNING *`, [id, status]);
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] ticket update:', e.message); fail(res, 500, 'Could not update the ticket.'); }
});

/* ------------------------------------------------------------------ system */
router.get('/system', requireAdmin, async (req, res) => {
  try {
    const jobs = await require('../jobs/jobQueue').stats();
    const { rows: [db1] } = await db.query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
    const { rows: templates } = await db.query(
      `SELECT template_name, approval_status, send_context FROM whatsapp_templates ORDER BY id`);
    const { rows: [notif] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='sent')::int sent,
              COUNT(*) FILTER (WHERE status='failed')::int failed
         FROM notification_log WHERE send_date = CURRENT_DATE`);
    ok(res, { jobs, database: db1.size, templates, today: notif });
  } catch (e) { console.error('[admin] system:', e.message); fail(res, 500, 'Could not load system status.'); }
});

/* ---------------------------------------------------------- payment mode */
/**
 * Razorpay test/live toggle. Returns the current mode plus whether each key
 * pair is actually configured in the environment, so the UI can stop the admin
 * flipping to a mode whose keys are missing.
 */
router.get('/payment-mode', requireAdmin, async (req, res) => {
  try {
    const { rows: [r] } = await db.query(`SELECT value, updated_at FROM app_settings WHERE key='razorpay_mode'`);
    ok(res, {
      mode: r?.value || process.env.RAZORPAY_MODE || 'test',
      updated_at: r?.updated_at || null,
      test_keys_present: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      live_keys_present: !!(process.env.RAZORPAY_KEY_LIVE_ID && process.env.RAZORPAY_KEY_LIVE_SECRET),
    });
  } catch (e) { console.error('[admin] payment-mode get:', e.message); fail(res, 500, 'Could not load payment mode.'); }
});

/** Step 1 of a mode switch — send an OTP to the acting super admin's number. */
router.post('/payment-mode/request-otp', requireSuperAdmin, async (req, res) => {
  try {
    const r = await otp.request(req.admin.sub, [...await adminMobiles()], req.ip);
    if (r.error) return fail(res, 429, r.error);
    ok(res, { ttlMin: r.ttlMin, message: `A code was sent to your number. It is valid for ${r.ttlMin} minutes.` });
  } catch (e) { console.error('[admin] mode otp:', e.message); fail(res, 500, 'Could not send the code.'); }
});

/**
 * Step 2 — switch the mode, but only with a valid OTP. Switching between real
 * and test money is exactly the kind of action that deserves a second factor,
 * so the code is required even though the admin is already signed in.
 */
router.put('/payment-mode', requireSuperAdmin, express.json(), async (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase();
  const code = String(req.body?.otp || '');
  if (!['test', 'live'].includes(mode)) return fail(res, 400, 'Mode must be "test" or "live".');
  const haveTest = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const haveLive = !!(process.env.RAZORPAY_KEY_LIVE_ID && process.env.RAZORPAY_KEY_LIVE_SECRET);
  if (mode === 'live' && !haveLive) return fail(res, 400, 'Live keys are not configured on the server.');
  if (mode === 'test' && !haveTest) return fail(res, 400, 'Test keys are not configured on the server.');

  if (!(await otp.verify(req.admin.sub, code))) {
    return fail(res, 401, 'That code is not valid or has expired. Please request a new one.');
  }
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('razorpay_mode', $1, now())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [mode]);
    console.warn(`[admin] razorpay mode -> ${mode.toUpperCase()} by ${req.admin.sub} (OTP verified)`);
    ok(res, { mode });
  } catch (e) { console.error('[admin] payment-mode set:', e.message); fail(res, 500, 'Could not update payment mode.'); }
});

/* ----------------------------------------------------------- admin users */
/** List admins (super admin only). */
router.get('/admins', requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT mobile_number, is_super, is_active, added_by, created_at FROM admins ORDER BY is_super DESC, id`);
    ok(res, { rows, me: req.admin.sub });
  } catch (e) { console.error('[admin] admins list:', e.message); fail(res, 500, 'Could not load admins.'); }
});

/** Step 1 of adding an admin — send an OTP to the NEW number to prove it is real. */
router.post('/admins/request-otp', requireSuperAdmin, express.json(), async (req, res) => {
  const mobile = String(req.body?.mobile || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(mobile)) return fail(res, 400, 'Enter a valid 10-digit mobile number.');
  if ((await adminMobiles()).has(mobile)) return fail(res, 400, 'That number is already an admin.');
  try {
    // allow just this one number, so the code truly goes to the prospective admin
    const r = await otp.request(mobile, [mobile], req.ip);
    if (r.error) return fail(res, 429, r.error);
    ok(res, { ttlMin: r.ttlMin, message: `A code was sent to ${mobile}. It is valid for ${r.ttlMin} minutes.` });
  } catch (e) { console.error('[admin] admin add otp:', e.message); fail(res, 500, 'Could not send the code.'); }
});

/** Step 2 — verify the new number's OTP and grant admin access. */
router.post('/admins', requireSuperAdmin, express.json(), async (req, res) => {
  const mobile = String(req.body?.mobile || '').replace(/\D/g, '').slice(-10);
  const code = String(req.body?.otp || '');
  if (!/^[6-9]\d{9}$/.test(mobile)) return fail(res, 400, 'Enter a valid 10-digit mobile number.');
  if (!(await otp.verify(mobile, code))) return fail(res, 401, 'That code is not valid or has expired.');
  try {
    await db.query(
      `INSERT INTO admins (mobile_number, is_super, added_by) VALUES ($1, false, $2)
       ON CONFLICT (mobile_number) DO UPDATE SET is_active=true`, [mobile, req.admin.sub]);
    console.warn(`[admin] new admin ${mobile} added by ${req.admin.sub}`);
    ok(res, { mobile });
  } catch (e) { console.error('[admin] admin add:', e.message); fail(res, 500, 'Could not add the admin.'); }
});

/** Remove an admin (super admin only; cannot remove a super admin or yourself). */
router.delete('/admins/:mobile', requireSuperAdmin, async (req, res) => {
  const mobile = String(req.params.mobile || '').replace(/\D/g, '').slice(-10);
  if (mobile === req.admin.sub) return fail(res, 400, 'You cannot remove yourself.');
  if (await isSuperAdmin(mobile)) return fail(res, 400, 'A super admin cannot be removed here.');
  try {
    const r = await db.query(`UPDATE admins SET is_active=false WHERE mobile_number LIKE '%'||$1 AND NOT is_super`, [mobile]);
    if (!r.rowCount) return fail(res, 404, 'No such admin.');
    console.warn(`[admin] admin ${mobile} removed by ${req.admin.sub}`);
    ok(res, { removed: mobile });
  } catch (e) { console.error('[admin] admin remove:', e.message); fail(res, 500, 'Could not remove the admin.'); }
});

module.exports = router;
