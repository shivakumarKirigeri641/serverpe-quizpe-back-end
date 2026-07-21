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
const { login, requireAdmin } = require('../admin/auth');
const metrics = require('../admin/metrics');

const router = express.Router();

const clamp = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

/* -------------------------------------------------------------------- auth */
router.post('/login', express.json(), async (req, res) => {
  const { mobile, pin } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local';
  try {
    const r = await login(mobile, pin, ip);
    if (r.error) return fail(res, 401, r.error);
    ok(res, r);
  } catch (e) {
    console.error('[admin] login failed:', e.message);
    fail(res, 500, e.message.startsWith('ADMIN AUTH') ? e.message : 'Could not sign in.');
  }
});

router.get('/me', requireAdmin, (req, res) => ok(res, { mobile: req.admin.sub }));

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
      `SELECT * FROM gstr1_filing WHERE filing_period=$1 ORDER BY id`, [period]);
    const { rows: [totals] } = await db.query(`
      SELECT COUNT(*)::int invoices,
             COALESCE(SUM(taxable_value),0)::numeric taxable,
             COALESCE(SUM(cgst),0)::numeric cgst,
             COALESCE(SUM(sgst),0)::numeric sgst,
             COALESCE(SUM(igst),0)::numeric igst,
             COALESCE(SUM(invoice_total),0)::numeric total
        FROM gstr1_filing WHERE filing_period=$1`, [period]);
    const { rows: periods } = await db.query(
      `SELECT DISTINCT filing_period FROM gstr1_filing ORDER BY filing_period DESC`);
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

module.exports = router;
