/**
 * src/admin/customerRoutes.js
 * ---------------------------------------------------------------------------
 * Full CRUD for existing customers — parents and their children — plus the
 * safety rails around deletion.
 *
 * DELETE POLICY, deliberately conservative:
 *
 *   • DELETE without ?hard=1 DEACTIVATES (is_active = false). Nothing is lost,
 *     the parent stops receiving quizzes, and it is reversible.
 *
 *   • DELETE with ?hard=1 permanently removes rows, and requires the admin to
 *     echo back the parent's mobile (or the child's name) exactly. A stray
 *     click cannot destroy a customer.
 *
 *   • A hard delete is REFUSED outright when invoices or payments exist. GST
 *     records carry a statutory retention period, so a paying customer's data
 *     cannot be erased on a whim — deactivation is the answer there.
 *
 * The impact endpoints let the UI show exactly what would be destroyed before
 * the button is even offered.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const { requireAdmin, adminMobiles } = require('./auth');
const otp = require('./otp');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

/* ------------------------------------------------------------ edit parent */
router.patch('/parents/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad parent id.');
  const { parent_name, state_code, reminders_enabled, is_active } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE parents SET
         parent_name       = COALESCE($2, parent_name),
         state_code        = COALESCE($3, state_code),
         reminders_enabled = COALESCE($4, reminders_enabled),
         is_active         = COALESCE($5, is_active),
         modified_at       = now()
       WHERE id = $1 RETURNING *`,
      [id, parent_name || null, state_code || null,
        typeof reminders_enabled === 'boolean' ? reminders_enabled : null,
        typeof is_active === 'boolean' ? is_active : null]);
    if (!rows.length) return fail(res, 404, 'Parent not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] edit parent:', e.message); fail(res, 400, e.message); }
});

/* ---------------------------------------------------- change mobile number */
router.get('/parents/:id/mobile-preview', requireAdmin, async (req, res) => {
  try {
    const p = await require('./mobileChange').previewMobileChange(parseInt(req.params.id, 10));
    if (!p) return fail(res, 404, 'Parent not found.');
    ok(res, p);
  } catch (e) { console.error('[admin] mobile preview:', e.message); fail(res, 500, 'Could not check.'); }
});

router.post('/parents/:id/mobile', requireAdmin, express.json(), async (req, res) => {
  try {
    const r = await require('./mobileChange')
      .changeMobile(parseInt(req.params.id, 10), req.body?.mobile, req.body?.confirm);
    if (r.error) return fail(res, 400, r.error);
    ok(res, r);
  } catch (e) { console.error('[admin] mobile change:', e.message); fail(res, 500, e.message); }
});

/* --------------------------------------------------- change plan expiry -- */
/**
 * Postpone or prepone the CURRENT plan's expiry on request. Adjusts the active
 * subscription's plan_end_date directly — used for goodwill extensions, a paused
 * family, or correcting a wrong date. Cannot move expiry before the start date.
 */
router.patch('/parents/:id/expiry', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const date = String(req.body?.date || '');
  if (!id) return fail(res, 400, 'Bad parent id.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Enter a valid date (YYYY-MM-DD).');
  try {
    const { rows: [s] } = await db.query(
      `SELECT id, plan_start_date::text AS plan_start_date FROM parents_quizpe_subscriptions
        WHERE parent_id=$1 AND is_active ORDER BY plan_end_date DESC, id DESC LIMIT 1`, [id]);
    if (!s) return fail(res, 404, 'No active subscription to change.');
    if (new Date(date) < new Date(s.plan_start_date)) {
      return fail(res, 400, `Expiry cannot be before the plan start date (${s.plan_start_date}).`);
    }
    await db.query(
      `UPDATE parents_quizpe_subscriptions SET plan_end_date=$2::date, modified_at=now() WHERE id=$1`, [s.id, date]);
    ok(res, { plan_end_date: date });
  } catch (e) { console.error('[admin] change expiry:', e.message); fail(res, 400, e.message); }
});

/* --------------------------------- recover a paid-but-unactivated payment -- */
/**
 * When a real payment didn't activate (webhook rejected / not subscribed), paste
 * the Razorpay payment id (pay_…) here to finalize it manually. Idempotent — the
 * same finalize() the webhook uses, so it activates the plan, issues the invoice
 * and sends the confirmation, or just returns the existing invoice if already done.
 */
router.post('/pay/reconcile', requireAdmin, express.json(), async (req, res) => {
  const { payment_id, token } = req.body || {};
  if (!payment_id) return fail(res, 400, 'Enter the Razorpay payment id (pay_…).');
  try {
    const r = await require('../routers/paymentRouter')
      .reconcileByPaymentId(String(payment_id).trim(), token ? String(token).trim() : null);
    if (r.error) return fail(res, 400, r.error);
    ok(res, r);
  } catch (e) { console.error('[admin] reconcile:', e.message); fail(res, 500, e.message); }
});

/* ----------------------------------------- add a child mid-plan (pro-rated) */
/**
 * Enrol one more child on a family's existing PAID plan for the days that
 * remain, priced pro-rata and aligned to the current expiry. Two-step:
 *   • { dryRun:true }  -> returns the price breakdown to preview
 *   • { }              -> creates the Razorpay link + pushes it to WhatsApp
 * Refused when 7 days or fewer are left (renew instead). All validation and
 * pricing live in paymentRouter.createAddChildLink — the money path is one.
 */
router.post('/parents/:id/add-child-link', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad parent id.');
  const { student_name, school_name, board, grade, medium, addons, dryRun } = req.body || {};
  try {
    const r = await require('../routers/paymentRouter').createAddChildLink({
      parentId: id, dryRun: !!dryRun,
      child: { name: student_name, school_name, board, grade, medium, addons },
    });
    if (r.error) return fail(res, 400, r.error);
    ok(res, r);
  } catch (e) { console.error('[admin] add-child link:', e.message); fail(res, 400, e.message); }
});

/* ----------------------------------------------------------------- impact */
async function parentImpact(id) {
  const { rows: [r] } = await db.query(
    `SELECT p.parent_name, p.parent_mobile_number,
       (SELECT COUNT(*)::int FROM students WHERE parent_id = p.id) AS students,
       (SELECT COUNT(*)::int FROM quizpe_tracker t
          JOIN students st ON st.id = t.student_id WHERE st.parent_id = p.id) AS quizzes,
       (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions WHERE parent_id = p.id) AS subscriptions,
       (SELECT COUNT(*)::int FROM invoices i
          JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id
         WHERE s.parent_id = p.id) AS invoices,
       -- payments carry no subscription link; Razorpay records the payer's
       -- number in the contact column, sometimes with a country code prefix,
       -- so match on the tail rather than equality
       (SELECT COUNT(*)::int FROM payments pay
         WHERE pay.contact LIKE '%' || p.parent_mobile_number) AS payments
     FROM parents p WHERE p.id = $1`, [id]);
  return r;
}

async function studentImpact(id) {
  const { rows: [r] } = await db.query(
    `SELECT st.student_name,
       (SELECT COUNT(*)::int FROM quizpe_tracker WHERE student_id = st.id) AS quizzes,
       (SELECT COUNT(*)::int FROM quiz_reports  WHERE student_id = st.id) AS reports
     FROM students st WHERE st.id = $1`, [id]);
  return r;
}

router.get('/parents/:id/impact', requireAdmin, async (req, res) => {
  try {
    const r = await parentImpact(parseInt(req.params.id, 10));
    if (!r) return fail(res, 404, 'Parent not found.');
    const blocked = r.invoices > 0 || r.payments > 0;
    ok(res, {
      impact: r,
      canHardDelete: !blocked,
      blockedReason: blocked
        ? `This parent has ${r.invoices} invoice(s) and ${r.payments} payment(s). `
          + 'GST records must be retained, so permanent deletion is refused — deactivate instead.'
        : null,
      confirmWith: r.parent_mobile_number,
    });
  } catch (e) { console.error('[admin] parent impact:', e.message); fail(res, 500, 'Could not check.'); }
});

router.get('/students/:id/impact', requireAdmin, async (req, res) => {
  try {
    const r = await studentImpact(parseInt(req.params.id, 10));
    if (!r) return fail(res, 404, 'Student not found.');
    ok(res, { impact: r, canHardDelete: true, confirmWith: r.student_name });
  } catch (e) { console.error('[admin] student impact:', e.message); fail(res, 500, 'Could not check.'); }
});

/* ----------------------------------------------------------------- delete */
router.delete('/parents/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const hard = req.query.hard === '1';
  if (!id) return fail(res, 400, 'Bad parent id.');
  try {
    const r = await parentImpact(id);
    if (!r) return fail(res, 404, 'Parent not found.');

    if (!hard) {
      await db.query('UPDATE parents SET is_active=false, modified_at=now() WHERE id=$1', [id]);
      await db.query('UPDATE students SET is_active=false, modified_at=now() WHERE parent_id=$1', [id]);
      await db.query(
        'UPDATE parents_quizpe_subscriptions SET is_active=false, modified_at=now() WHERE parent_id=$1', [id]);
      return ok(res, { deactivated: true });
    }

    if (r.invoices > 0 || r.payments > 0) {
      return fail(res, 409,
        'Refused: this parent has invoices or payments. GST records must be retained — deactivate instead.');
    }
    if (String(req.body?.confirm || '').trim() !== String(r.parent_mobile_number)) {
      return fail(res, 400, 'Type the mobile number exactly to confirm permanent deletion.');
    }

    const c = await db.getClient();
    try {
      await c.query('BEGIN');
      const kids = (await c.query('SELECT id FROM students WHERE parent_id=$1', [id])).rows.map(x => x.id);
      if (kids.length) await purgeStudents(c, kids);
      await c.query('DELETE FROM feedbacks WHERE parent_id=$1', [id]);
      await c.query('DELETE FROM support_tickets WHERE parent_id=$1', [id]);
      await c.query('DELETE FROM support_links WHERE parent_id=$1', [id]);
      await c.query('DELETE FROM policy_consents WHERE parent_id=$1', [id]);
      await c.query('DELETE FROM parents_quizpe_subscriptions WHERE parent_id=$1', [id]);
      await c.query('DELETE FROM parents WHERE id=$1', [id]);
      await c.query('COMMIT');
      ok(res, { deleted: true });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } catch (e) { console.error('[admin] delete parent:', e.message); fail(res, 400, e.message); }
});

router.delete('/students/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const hard = req.query.hard === '1';
  if (!id) return fail(res, 400, 'Bad student id.');
  try {
    const r = await studentImpact(id);
    if (!r) return fail(res, 404, 'Student not found.');

    if (!hard) {
      await db.query('UPDATE students SET is_active=false, modified_at=now() WHERE id=$1', [id]);
      return ok(res, { deactivated: true });
    }
    if (String(req.body?.confirm || '').trim() !== String(r.student_name)) {
      return fail(res, 400, 'Type the name exactly to confirm permanent deletion.');
    }

    const c = await db.getClient();
    try {
      await c.query('BEGIN');
      await purgeStudents(c, [id]);
      await c.query('COMMIT');
      ok(res, { deleted: true });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } catch (e) { console.error('[admin] delete student:', e.message); fail(res, 400, e.message); }
});

/** Children first, then their quizzes — order matters for foreign keys. */
async function purgeStudents(c, ids) {
  const trackers = (await c.query(
    'SELECT id FROM quizpe_tracker WHERE student_id = ANY($1::bigint[])', [ids])).rows.map(x => x.id);
  if (trackers.length) {
    await c.query('DELETE FROM quiz_links WHERE tracker_id = ANY($1::bigint[])', [trackers]);
    await c.query('DELETE FROM feedback_links WHERE tracker_id = ANY($1::bigint[])', [trackers]);
    await c.query('DELETE FROM feedbacks WHERE tracker_id = ANY($1::bigint[])', [trackers]);
    await c.query('DELETE FROM quiz_reports WHERE tracker_id = ANY($1::bigint[])', [trackers]);
    await c.query('DELETE FROM student_quizpe_histories WHERE tracker_id = ANY($1::bigint[])', [trackers]);
    await c.query('DELETE FROM quizpe_tracker WHERE id = ANY($1::bigint[])', [trackers]);
  }
  await c.query('DELETE FROM student_subject_progress WHERE student_id = ANY($1::bigint[])', [ids]);
  await c.query('DELETE FROM student_addons_subscriptions WHERE student_id = ANY($1::bigint[])', [ids]);
  await c.query('DELETE FROM notification_log WHERE student_id = ANY($1::bigint[])', [ids]);
  await c.query('DELETE FROM quiz_reports WHERE student_id = ANY($1::bigint[])', [ids]);
  await c.query('DELETE FROM students WHERE id = ANY($1::bigint[])', [ids]);
}

/* ------------------------------------------ delete a mobile (OTP-gated) -- */
/**
 * Remove a mobile number and everything hanging off it — but ONLY when it has
 * never transacted. Any invoice or payment protects the number outright (GST
 * records must be retained), matching the parent hard-delete policy above.
 * Because this is irreversible, it is gated behind a fresh OTP sent to the
 * acting admin's OWN phone (same mechanism as the payment-mode switch).
 *
 * Status shown per number (drives the colour in Settings):
 *   transacted → has invoices/payments — protected, cannot delete
 *   trial      → a family on record but no money ever taken
 *   lead       → only a WhatsApp chat, never enrolled
 *   none       → nothing on file
 */
async function mobileStatus(raw) {
  const m = String(raw || '').replace(/\D/g, '').slice(-10);
  if (m.length !== 10) return null;
  const { rows: [r] } = await db.query(
    `SELECT
       (SELECT id          FROM parents WHERE parent_mobile_number=$1) AS parent_id,
       (SELECT parent_name FROM parents WHERE parent_mobile_number=$1) AS parent_name,
       (SELECT COUNT(*)::int FROM students st JOIN parents p ON p.id=st.parent_id
         WHERE p.parent_mobile_number=$1) AS students,
       (SELECT COUNT(*)::int FROM parents_quizpe_subscriptions s JOIN parents p ON p.id=s.parent_id
         WHERE p.parent_mobile_number=$1) AS subscriptions,
       (SELECT COUNT(*)::int FROM invoices i
          JOIN parents_quizpe_subscriptions s ON s.id=i.subscription_id
          JOIN parents p ON p.id=s.parent_id WHERE p.parent_mobile_number=$1) AS invoices,
       (SELECT COUNT(*)::int FROM payments WHERE contact LIKE '%'||$1) AS payments,
       (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN students st ON st.id=t.student_id
          JOIN parents p ON p.id=st.parent_id WHERE p.parent_mobile_number=$1) AS quizzes,
       (SELECT COUNT(*)::int FROM whatsapp_sessions  WHERE mobile_number=$1) AS sessions,
       (SELECT COUNT(*)::int FROM whatsapp_messages  WHERE mobile_number=$1) AS messages`,
    [m]);
  const transacted = r.invoices > 0 || r.payments > 0;
  const status = transacted ? 'transacted'
    : r.parent_id ? 'trial'
    : (r.sessions > 0 || r.messages > 0) ? 'lead' : 'none';
  return {
    mobile: m, parent_id: r.parent_id, parent_name: r.parent_name,
    students: r.students, subscriptions: r.subscriptions, invoices: r.invoices,
    payments: r.payments, quizzes: r.quizzes, sessions: r.sessions, messages: r.messages,
    transacted, status,
    canDelete: !transacted && (!!r.parent_id || r.sessions > 0 || r.messages > 0),
  };
}

/** Wipe a non-transacted number in one transaction. Leaves (children of a row)
 *  are deleted before the row they reference, so foreign keys never trip. */
async function purgeMobile(st) {
  const m = st.mobile;
  const c = await db.getClient();
  const removed = {};
  const del = async (label, sql, params) => {
    const r = await c.query(sql, params);
    if (r.rowCount) removed[label] = (removed[label] || 0) + r.rowCount;
  };
  try {
    await c.query('BEGIN');

    if (st.parent_id) {
      const kids = (await c.query('SELECT id FROM students WHERE parent_id=$1', [st.parent_id])).rows.map(x => x.id);
      if (kids.length) { await purgeStudents(c, kids); removed.students = kids.length; }
      await del('feedbacks', 'DELETE FROM feedbacks WHERE parent_id=$1', [st.parent_id]);
      await del('support_tickets', 'DELETE FROM support_tickets WHERE parent_id=$1', [st.parent_id]);
      await del('support_links', 'DELETE FROM support_links WHERE parent_id=$1', [st.parent_id]);
      await del('policy_consents', 'DELETE FROM policy_consents WHERE parent_id=$1', [st.parent_id]);
      await del('subscriptions', 'DELETE FROM parents_quizpe_subscriptions WHERE parent_id=$1', [st.parent_id]);
      await del('parents', 'DELETE FROM parents WHERE id=$1', [st.parent_id]);
    }

    // WhatsApp children (events, messages) before the sessions they belong to
    const sess = (await c.query('SELECT id FROM whatsapp_sessions WHERE mobile_number=$1', [m])).rows.map(x => x.id);
    if (sess.length) {
      await del('whatsapp_session_events', 'DELETE FROM whatsapp_session_events WHERE session_id = ANY($1::bigint[])', [sess]);
      await del('whatsapp_messages', 'DELETE FROM whatsapp_messages WHERE session_id = ANY($1::bigint[])', [sess]);
    }

    // every operational table keyed by the number itself (leaves first, sessions last)
    for (const t of ['whatsapp_messages', 'notification_log', 'policy_consents', 'otps',
                     'report_sessions', 'signup_links', 'checkout_sessions', 'quiz_links',
                     'feedback_links', 'feedbacks', 'support_links', 'support_tickets']) {
      await del(t, `DELETE FROM ${t} WHERE mobile_number=$1`, [m]);
    }
    await del('whatsapp_sessions', 'DELETE FROM whatsapp_sessions WHERE mobile_number=$1', [m]);

    await c.query('COMMIT');
    return removed;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

router.get('/mobiles/lookup', requireAdmin, async (req, res) => {
  try {
    const st = await mobileStatus(req.query.mobile);
    if (!st) return fail(res, 400, 'Enter a valid 10-digit mobile number.');
    ok(res, { status: st });
  } catch (e) { console.error('[admin] mobile lookup:', e.message); fail(res, 500, 'Could not check.'); }
});

router.post('/mobiles/purge/request-otp', requireAdmin, express.json(), async (req, res) => {
  try {
    const st = await mobileStatus(req.body?.mobile);
    if (!st) return fail(res, 400, 'Enter a valid 10-digit mobile number.');
    if (st.transacted) return fail(res, 409, 'This number has invoices or payments. GST records must be retained — deletion is refused.');
    if (!st.canDelete) return fail(res, 404, 'Nothing found for this number to delete.');
    const r = await otp.request(req.admin.sub, [...await adminMobiles()], req.ip);
    if (r.error) return fail(res, 429, r.error);
    ok(res, { sent: true, ttlMin: r.ttlMin, to: req.admin.sub });
  } catch (e) { console.error('[admin] purge otp:', e.message); fail(res, 500, 'Could not send code.'); }
});

router.post('/mobiles/purge', requireAdmin, express.json(), async (req, res) => {
  const code = String(req.body?.otp || '');
  try {
    const st = await mobileStatus(req.body?.mobile);
    if (!st) return fail(res, 400, 'Enter a valid 10-digit mobile number.');
    if (st.transacted) return fail(res, 409, 'This number has invoices or payments. GST records must be retained — deletion is refused.');
    if (!st.canDelete) return fail(res, 404, 'Nothing found for this number to delete.');
    if (!/^\d{4}$/.test(code)) return fail(res, 400, 'Enter the 4-digit code sent to your phone.');
    if (!(await otp.verify(req.admin.sub, code))) return fail(res, 401, 'That code is not valid or has expired.');

    const removed = await purgeMobile(st);
    console.warn(`[admin] mobile ${st.mobile} PURGED by ${req.admin.sub} (OTP verified):`, removed);
    ok(res, { deleted: true, mobile: st.mobile, removed });
  } catch (e) { console.error('[admin] purge mobile:', e.message); fail(res, 400, e.message); }
});

module.exports = router;
