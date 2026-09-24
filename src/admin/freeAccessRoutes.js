/**
 * src/admin/freeAccessRoutes.js
 * ---------------------------------------------------------------------------
 * "Free access" — give a family quizzes at no charge between two dates, with
 * their own number of quizzes per day.
 *
 * SEPARATE FROM "Free quiz slot" ON PURPOSE. That page hands out ONE quiz as a
 * make-good when a quiz failed to reach someone. This one opens a WINDOW: a
 * school demo for a fortnight, an apology week, a festival offer. They are
 * different tools with different lifetimes, and merging them would produce a
 * page where half the fields are always irrelevant.
 *
 * No plan row is written, no invoice, no GST record. See whatsapp/freeAccess.js
 * for why that matters.
 *
 *   GET  /admin/api/free-access/search?q=...   families to grant to
 *   GET  /admin/api/free-access/campaigns      every window, live ones first
 *   POST /admin/api/free-access/grant          open a window
 *   POST /admin/api/free-access/cancel         close one early
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const { requireAdmin } = require('./auth');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = Number(process.env.FREE_ACCESS_MAX_DAYS || 90);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * Families this can be granted to — ones with a parent row and at least one
 * child.
 *
 * A number that only ever said "hi" is deliberately NOT offered: free access
 * grants quizzes to a CHILD, and there is no child on file to give them to.
 * Those numbers belong on the Free quiz slot page, whose grant hangs on the
 * number itself and survives until they enrol.
 */
router.get('/free-access/search', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const digits = q.replace(/\D/g, '');
    const { rows } = await db.query(
      `SELECT p.id AS parent_id, p.parent_name, p.parent_mobile_number AS mobile,
              p.service_paused,
              COALESCE(json_agg(json_build_object('id', st.id, 'name', st.student_name,
                                                  'grade', g.grade_name)
                       ORDER BY st.id) FILTER (WHERE st.id IS NOT NULL), '[]') AS children,
              (SELECT pl.plan_name FROM parents_quizpe_subscriptions s
                 JOIN quizpe_plans pl ON pl.id = s.plan_id
                WHERE s.parent_id = p.id ORDER BY s.plan_end_date DESC LIMIT 1) AS last_plan,
              (SELECT s.plan_end_date FROM parents_quizpe_subscriptions s
                WHERE s.parent_id = p.id ORDER BY s.plan_end_date DESC LIMIT 1) AS plan_ends,
              EXISTS (SELECT 1 FROM free_quiz_campaigns c
                       WHERE c.parent_id = p.id AND c.is_active
                         AND CURRENT_DATE BETWEEN c.start_date AND c.end_date) AS has_live_window
         FROM parents p
         JOIN students st ON st.parent_id = p.id AND st.is_active
         JOIN grades g ON g.id = st.grade_id
        WHERE ($1 = '' AND $2 = '')
           OR ($1 <> '' AND p.parent_mobile_number LIKE '%' || $1 || '%')
           OR ($2 <> '' AND (p.parent_name ILIKE '%' || $2 || '%'
                          OR st.student_name ILIKE '%' || $2 || '%'))
        GROUP BY p.id
        ORDER BY p.parent_name
        LIMIT 40`, [digits, q]);
    ok(res, { rows });
  } catch (e) {
    console.error('[admin] free-access search:', e.message);
    fail(res, 500, 'Could not search.');
  }
});

/** Every window, live ones first, then upcoming, then finished. */
router.get('/free-access/campaigns', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.parent_id, c.student_id, c.start_date, c.end_date,
              c.slots_per_day, c.reason, c.granted_by, c.is_active, c.created_at,
              p.parent_name, p.parent_mobile_number AS mobile,
              st.student_name,
              CASE WHEN NOT c.is_active             THEN 'cancelled'
                   WHEN CURRENT_DATE < c.start_date THEN 'upcoming'
                   WHEN CURRENT_DATE > c.end_date   THEN 'finished'
                   ELSE 'live' END AS state,
              -- What the window has actually been used for, so a finished one
              -- can be judged rather than merely listed.
              (SELECT COUNT(*)::int FROM quizpe_tracker t
                 JOIN students s2 ON s2.id = t.student_id
                 JOIN quizpe_status qs ON qs.id = t.status_id
                WHERE s2.parent_id = c.parent_id
                  AND (c.student_id IS NULL OR t.student_id = c.student_id)
                  AND t.quiz_date BETWEEN c.start_date AND LEAST(c.end_date, CURRENT_DATE)
                  AND qs.status_code IN ('completed', 'closed')) AS quizzes_taken
         FROM free_quiz_campaigns c
         JOIN parents p ON p.id = c.parent_id
         LEFT JOIN students st ON st.id = c.student_id
        ORDER BY (CASE WHEN c.is_active AND CURRENT_DATE BETWEEN c.start_date AND c.end_date THEN 0
                       WHEN c.is_active AND CURRENT_DATE < c.start_date THEN 1
                       ELSE 2 END), c.start_date DESC, c.id DESC
        LIMIT 200`);
    ok(res, { rows });
  } catch (e) {
    console.error('[admin] free-access list:', e.message);
    fail(res, 500, 'Could not load.');
  }
});

router.post('/free-access/grant', requireAdmin, express.json(), async (req, res) => {
  const { parent_id, student_id, start_date, end_date, reason } = req.body || {};
  const slots = Number(req.body?.slots_per_day);
  try {
    if (!parent_id) return fail(res, 400, 'Choose a family first.');
    if (!ISO.test(String(start_date)) || !ISO.test(String(end_date))) {
      return fail(res, 400, 'Pick a start and an end date.');
    }
    if (end_date < start_date) return fail(res, 400, 'The end date cannot be before the start date.');
    if (!(slots >= 1 && slots <= 5)) return fail(res, 400, 'Quizzes per day must be between 1 and 5.');

    /* An upper bound on generosity. Free access costs nothing to send, but it
       does cost QUESTIONS — the bank never repeats one for a child — so an
       unbounded window opened by a slip of the keyboard would quietly burn
       through a grade's content. Raise FREE_ACCESS_MAX_DAYS if a longer
       programme is ever genuinely wanted. */
    const days = Math.round((new Date(end_date) - new Date(start_date)) / 864e5) + 1;
    if (days > MAX_DAYS) return fail(res, 400, `That window is ${days} days. The limit is ${MAX_DAYS}.`);

    const { rows: [parent] } = await db.query(
      `SELECT p.id, p.parent_name,
              (SELECT COUNT(*)::int FROM students st
                WHERE st.parent_id = p.id AND st.is_active) AS kids
         FROM parents p WHERE p.id = $1`, [parent_id]);
    if (!parent) return fail(res, 404, 'That family no longer exists.');
    if (!parent.kids) return fail(res, 409, 'That family has no active child to give quizzes to.');

    if (student_id) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM students WHERE id = $1 AND parent_id = $2 AND is_active`,
        [student_id, parent_id]);
      if (!rowCount) return fail(res, 400, 'That child does not belong to this family.');
    }

    /* Overlapping windows are refused rather than merged. Two live windows for
       one family would mean two different answers to "how many quizzes today?",
       and which one won would depend on row order. Cancel and re-grant is the
       honest way to change a window. */
    const { rows: clash } = await db.query(
      `SELECT id, start_date, end_date FROM free_quiz_campaigns
        WHERE is_active AND parent_id = $1
          AND (student_id IS NULL OR $2::bigint IS NULL OR student_id = $2)
          AND daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
        LIMIT 1`, [parent_id, student_id || null, start_date, end_date]);
    if (clash.length) {
      return fail(res, 409, `This family already has a window from ${iso(clash[0].start_date)} `
        + `to ${iso(clash[0].end_date)}. Cancel that one first.`);
    }

    const { rows: [row] } = await db.query(
      `INSERT INTO free_quiz_campaigns
         (parent_id, student_id, start_date, end_date, slots_per_day, reason, granted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [parent_id, student_id || null, start_date, end_date, slots,
       String(reason || '').trim() || null, req.admin.sub]);

    console.warn(`[admin] free access granted: parent ${parent_id} `
      + `${start_date}..${end_date} ${slots}/day by ${req.admin.sub}`);
    ok(res, { id: row.id, days });
  } catch (e) {
    console.error('[admin] free-access grant:', e.message);
    fail(res, 400, e.message);
  }
});

/** Close a window early. The row stays, so the record of what was given stays. */
router.post('/free-access/cancel', requireAdmin, express.json(), async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE free_quiz_campaigns SET is_active = false, modified_at = now()
        WHERE id = $1 AND is_active`, [req.body?.id]);
    if (!rowCount) return fail(res, 404, 'That window is already closed.');
    console.warn(`[admin] free access window ${req.body.id} cancelled by ${req.admin.sub}`);
    ok(res, { cancelled: true });
  } catch (e) {
    console.error('[admin] free-access cancel:', e.message);
    fail(res, 500, 'Could not cancel.');
  }
});

module.exports = router;
