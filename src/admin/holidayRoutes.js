/**
 * src/admin/holidayRoutes.js
 * ---------------------------------------------------------------------------
 * Reserve HOLIDAYS from the admin panel. A reserved date behaves like a
 * weekend: the quiz window opens all day (6 AM–11:45 PM), and the scheduler's
 * morning "open all day" nudge fires that day greeting "holiday".
 *
 * The window/scheduler read these dates through quizWindow's cached set
 * (refreshed every few minutes), so a reservation takes effect without a
 * restart — and we also refresh the cache immediately on any change here.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const { requireAdmin } = require('./auth');
const qw = require('../whatsapp/quizWindow');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS quiz_holidays (
      id           bigserial PRIMARY KEY,
      holiday_date date        NOT NULL UNIQUE,
      label        text,
      is_active    boolean     NOT NULL DEFAULT true,
      created_at   timestamptz NOT NULL DEFAULT now()
    );`);
  schemaReady = true;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** List reserved holidays (today onward by default; ?all=1 for the full history). */
router.get('/holidays', requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    const all = req.query.all === '1';
    const { rows } = await db.query(
      `SELECT id, to_char(holiday_date,'YYYY-MM-DD') AS date, label, is_active,
              (holiday_date < CURRENT_DATE) AS past
         FROM quiz_holidays
        ${all ? '' : 'WHERE holiday_date >= CURRENT_DATE'}
        ORDER BY holiday_date`);
    ok(res, { holidays: rows });
  } catch (e) { console.error('[admin] holidays list:', e.message); fail(res, 500, 'Could not load holidays.'); }
});

/** Reserve a date (idempotent — reactivates a previously removed one). */
router.post('/holidays', requireAdmin, express.json(), async (req, res) => {
  const date = String(req.body?.date || '').trim();
  const label = String(req.body?.label || '').trim().slice(0, 80) || null;
  if (!ISO.test(date)) return fail(res, 400, 'Pick a valid date (YYYY-MM-DD).');
  try {
    await ensureSchema();
    const { rows } = await db.query(
      `INSERT INTO quiz_holidays (holiday_date, label)
       VALUES ($1::date, $2)
       ON CONFLICT (holiday_date) DO UPDATE SET label = EXCLUDED.label, is_active = true
       RETURNING id, to_char(holiday_date,'YYYY-MM-DD') AS date, label, is_active`, [date, label]);
    await qw.refreshHolidays();                    // reflect it in the window immediately
    ok(res, { holiday: rows[0] });
  } catch (e) { console.error('[admin] holiday add:', e.message); fail(res, 500, 'Could not reserve the date.'); }
});

/** Remove a reservation (soft: is_active=false, so history/audit survives). */
router.delete('/holidays/:date', requireAdmin, async (req, res) => {
  const date = String(req.params.date || '').trim();
  if (!ISO.test(date)) return fail(res, 400, 'Bad date.');
  try {
    await ensureSchema();
    await db.query(`UPDATE quiz_holidays SET is_active = false WHERE holiday_date = $1::date`, [date]);
    await qw.refreshHolidays();
    ok(res, { removed: date });
  } catch (e) { console.error('[admin] holiday remove:', e.message); fail(res, 500, 'Could not remove the date.'); }
});

module.exports = router;
