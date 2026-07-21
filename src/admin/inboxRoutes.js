/**
 * src/admin/inboxRoutes.js
 * ---------------------------------------------------------------------------
 * The two things the public website collects: enquiries and testimonial
 * submissions. Without these endpoints both tables fill up and nobody ever
 * sees them — an enquiry with no inbox is worse than no contact form, because
 * the parent believes they have been heard.
 *
 * Testimonials are approved here and nowhere else. Nothing a stranger types on
 * the internet appears on the marketing site until a human has read it.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const { requireAdmin } = require('./auth');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

const TZ = 'Asia/Kolkata';
const IST = (c) => `to_char(${c} AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}', 'DD Mon, HH24:MI')`;

/* --------------------------------------------------------------- enquiries */
router.get('/enquiries', requireAdmin, async (req, res) => {
  const status = ['open', 'handled', 'closed'].includes(req.query.status) ? req.query.status : null;
  try {
    const { rows } = await db.query(
      `SELECT e.*, ${IST('e.created_at')} AS at_ist,
              p.id AS parent_id, p.parent_name AS existing_parent
         FROM website_enquiries e
         LEFT JOIN parents p ON p.parent_mobile_number = e.mobile_number
        WHERE e.is_active AND ($1::text IS NULL OR e.status = $1)
        ORDER BY (e.status = 'open') DESC, e.id DESC
        LIMIT 200`, [status]);
    const { rows: [c] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='open')::int open,
              COUNT(*)::int total FROM website_enquiries WHERE is_active`);
    ok(res, { rows, counts: c });
  } catch (e) { console.error('[admin] enquiries:', e.message); fail(res, 500, 'Could not load enquiries.'); }
});

router.patch('/enquiries/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['open', 'handled', 'closed'].includes(req.body?.status) ? req.body.status : null;
  if (!id || !status) return fail(res, 400, 'Bad enquiry update.');
  try {
    const { rows } = await db.query(
      `UPDATE website_enquiries
          SET status = $2,
              handled_at = CASE WHEN $2 <> 'open' THEN now() ELSE NULL END,
              modified_at = now()
        WHERE id = $1 RETURNING *`, [id, status]);
    if (!rows.length) return fail(res, 404, 'Enquiry not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] enquiry update:', e.message); fail(res, 500, 'Could not update.'); }
});

/* ------------------------------------------------------------ testimonials */
router.get('/testimonials', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT *, ${IST('created_at')} AS at_ist FROM testimonials
        WHERE is_active ORDER BY is_approved, id DESC LIMIT 200`);
    const { rows: [c] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE NOT is_approved)::int pending,
              COUNT(*) FILTER (WHERE is_approved)::int published,
              COUNT(*)::int total FROM testimonials WHERE is_active`);
    ok(res, { rows, counts: c });
  } catch (e) { console.error('[admin] testimonials:', e.message); fail(res, 500, 'Could not load testimonials.'); }
});

router.patch('/testimonials/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad testimonial id.');
  const { is_approved, is_active, display_order, message, author_name, author_role, location } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE testimonials SET
         is_approved   = COALESCE($2, is_approved),
         is_active     = COALESCE($3, is_active),
         display_order = COALESCE($4, display_order),
         message       = COALESCE($5, message),
         author_name   = COALESCE($6, author_name),
         author_role   = COALESCE($7, author_role),
         location      = COALESCE($8, location),
         modified_at   = now()
       WHERE id = $1 RETURNING *`,
      [id, typeof is_approved === 'boolean' ? is_approved : null,
       typeof is_active === 'boolean' ? is_active : null,
       display_order ?? null, message || null, author_name || null,
       author_role || null, location || null]);
    if (!rows.length) return fail(res, 404, 'Testimonial not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] testimonial update:', e.message); fail(res, 400, e.message); }
});

/**
 * Promote a real in-app rating into a website testimonial. The best reviews
 * come from parents who already left one after a quiz — this saves asking
 * them twice, and the text is genuine rather than solicited.
 */
router.get('/feedback/promotable', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT f.id, f.rating, f.message, f.tags, ${IST('f.created_at')} AS at_ist,
              p.parent_name, p.state_code, st.student_name
         FROM feedbacks f
         JOIN parents p ON p.id = f.parent_id
         LEFT JOIN students st ON st.id = f.student_id
        WHERE f.rating >= 4 AND f.message IS NOT NULL AND btrim(f.message) <> ''
          AND NOT EXISTS (SELECT 1 FROM testimonials t WHERE t.feedback_id = f.id)
        ORDER BY f.rating DESC, f.id DESC LIMIT 50`);
    ok(res, { rows });
  } catch (e) { console.error('[admin] promotable:', e.message); fail(res, 500, 'Could not load ratings.'); }
});

router.post('/feedback/:id/promote', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad feedback id.');
  try {
    const f = (await db.query(
      `SELECT f.*, p.parent_name, p.state_code FROM feedbacks f
         JOIN parents p ON p.id = f.parent_id WHERE f.id = $1`, [id])).rows[0];
    if (!f) return fail(res, 404, 'Rating not found.');
    if (!f.message) return fail(res, 400, 'That rating has no written comment to publish.');

    const { rows } = await db.query(
      `INSERT INTO testimonials (author_name, author_role, location, rating, message,
                                 source, feedback_id, is_approved)
       VALUES ($1,'Parent',$2,$3,$4,'app',$5,false) RETURNING *`,
      [req.body?.author_name || f.parent_name || 'A parent', f.state_code || null,
       f.rating, f.message, f.id]);
    ok(res, { row: rows[0], note: 'Added as a draft — approve it to publish.' });
  } catch (e) { console.error('[admin] promote:', e.message); fail(res, 400, e.message); }
});

module.exports = router;
