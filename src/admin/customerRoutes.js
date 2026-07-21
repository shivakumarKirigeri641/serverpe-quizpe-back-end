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
const { requireAdmin } = require('./auth');

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

module.exports = router;
