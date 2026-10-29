/**
 * src/prepaid/wallet.js — PAY AS YOU ANSWER (user, 2026-10-28).
 * ---------------------------------------------------------------------------
 * A family's MCQ balance, counted in MCQs (never "credits"). One MCQ is used per
 * answered question; recharges (+ GST) ₹50 → 250, ₹100 → 500, ₹200 → 1000 (Jan–Mar only ₹50
 * and ₹100). Everything ends on 31 March — no carry-over, no refund.
 *
 *   free   50 MCQs, once per family ever, for new and lapsed families (not for a
 *          family on a live ₹99/169/249 plan); valid 7 days, at most 20 a day
 *   lots   each top-up is a lot (mcq_lots); an answered MCQ is taken from the lot
 *          that expires soonest and written once into mcq_usage (history_id is
 *          UNIQUE, so a replayed answer never charges twice)
 *   limit  per student per day (students.daily_mcq_limit, default 20)
 *
 * The plans are used FIRST (quiz.js slots); the balance only pays for a quiz the
 * plan does not cover (quizpe_tracker.paid_by = 'wallet').
 * Settings: app_settings 'prepaid_mcq' (JSON) — see DEFAULTS.
 * ---------------------------------------------------------------------------
 */
const db = require('../database/connectDB');

const DEFAULTS = {
  paise_per_mcq: 20,
  packs: [{ rupees: 50, mcqs: 250 }, { rupees: 100, mcqs: 500 }, { rupees: 200, mcqs: 1000 }],
  jan_mar_rupees: [50, 100],
  free_mcqs: 50, free_days: 7, free_per_day: 20,
  daily_limit: 20, round: 10, low_left: 20,
  // A quiz in the chat with no answer: a reminder after 10 minutes, ended (with the report) after 30.
  idle_remind_min: 10, idle_end_min: 30,
};

let cache = { at: 0, cfg: null };
async function config(exec = db) {
  if (cache.cfg && Date.now() - cache.at < 60000) return cache.cfg;
  let cfg = { ...DEFAULTS };
  try {
    const r = (await exec.query(`SELECT value FROM app_settings WHERE key = 'prepaid_mcq'`)).rows[0];
    if (r?.value) cfg = { ...DEFAULTS, ...JSON.parse(r.value) };
  } catch { /* defaults */ }
  cache = { at: Date.now(), cfg };
  return cfg;
}

/** IST calendar month (1-12) right now. */
const istMonth = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(d));
const istYear = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(d));

/** The end of the academic balance year: the coming 31 March, 23:59:59 IST. */
function yearEnd(d = new Date()) {
  const y = istMonth(d) <= 3 ? istYear(d) : istYear(d) + 1;
  return new Date(`${y}-03-31T23:59:59+05:30`);
}

/** The recharges on offer today: all three, or only ₹50 and ₹100 from January to March. */
async function packs(d = new Date()) {
  const cfg = await config();
  const all = cfg.packs.map((p) => ({ rupees: Number(p.rupees), mcqs: Number(p.mcqs) }));
  return istMonth(d) <= 3 ? all.filter((p) => cfg.jan_mar_rupees.includes(p.rupees)) : all;
}
/** Reply buttons for the recharges: "₹50 · 250 MCQs" (20 characters at most). */
async function packButtons() {
  return (await packs()).slice(0, 3).map((p) => ({ id: `mcq_${p.rupees}`, title: `₹${p.rupees} · ${p.mcqs} MCQs`.slice(0, 20) }));
}

/** MCQs left, split by pocket, and the soonest / latest expiry. */
async function balance(parentId, exec = db) {
  if (!parentId) return { left: 0, free: 0, paid: 0, nextExpiry: null, lastExpiry: null };
  const r = (await exec.query(
    `SELECT coalesce(sum(mcqs - used), 0)::int AS left,
            coalesce(sum(mcqs - used) FILTER (WHERE source = 'free'), 0)::int AS free,
            coalesce(sum(mcqs - used) FILTER (WHERE source <> 'free'), 0)::int AS paid,
            min(expires_at) AS next_expiry, max(expires_at) AS last_expiry
       FROM mcq_lots WHERE parent_id = $1 AND expires_at > now() AND used < mcqs`, [parentId])).rows[0];
  return { left: r.left, free: r.free, paid: r.paid, nextExpiry: r.next_expiry, lastExpiry: r.last_expiry };
}

/** Has this family ever had the free 50? */
async function hadFree(parentId, exec = db) {
  if (!parentId) return false;
  return (await exec.query(`SELECT 1 FROM mcq_lots WHERE parent_id = $1 AND source = 'free'`, [parentId])).rowCount > 0;
}

/** Is a ₹99/169/249 plan (not the old trial) live today? */
async function onPlan(parentId, exec = db) {
  if (!parentId) return false;
  return (await exec.query(
    `SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE s.parent_id = $1 AND s.is_active AND NOT coalesce(pl.is_trial, false)
        AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date LIMIT 1`, [parentId])).rowCount > 0;
}

/** New and lapsed families get the free 50 once; a family on a live plan does not (option b). */
async function freeEligible(parentId, exec = db) {
  if (!parentId) return false;
  return !(await hadFree(parentId, exec)) && !(await onPlan(parentId, exec));
}

/** Give the free 50 (7 days). Returns the lot, or null when already given / not eligible. */
async function grantFree(parentId, exec = db) {
  if (!(await freeEligible(parentId, exec))) return null;
  const cfg = await config(exec);
  const r = (await exec.query(
    `INSERT INTO mcq_lots (parent_id, source, mcqs, expires_at, note)
     VALUES ($1, 'free', $2, least(now() + make_interval(days => $3), $4::timestamptz), 'free start')
     ON CONFLICT DO NOTHING RETURNING *`,
    [parentId, cfg.free_mcqs, cfg.free_days, yearEnd().toISOString()])).rows[0];
  return r || null;
}

/** Add a recharge (or an admin top-up). Idempotent per checkout. */
async function addLot(exec, { parentId, source = 'recharge', mcqs, rupees = null, paymentId = null, checkoutId = null, note = null }) {
  const r = (await exec.query(
    `INSERT INTO mcq_lots (parent_id, source, mcqs, expires_at, rupees, payment_id, checkout_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (checkout_id) DO NOTHING RETURNING *`,
    [parentId, source, mcqs, yearEnd().toISOString(), rupees, paymentId, checkoutId, note])).rows[0];
  return r || null;
}

/** MCQs a student has answered from the balance today, and the family's free MCQs used today. */
async function usedToday(parentId, studentId, exec = db) {
  const r = (await exec.query(
    `SELECT count(*) FILTER (WHERE student_id = $2)::int AS student,
            count(*) FILTER (WHERE source = 'free')::int AS free
       FROM mcq_usage WHERE parent_id = $1 AND used_on = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [parentId, studentId])).rows[0];
  return { student: r.student, free: r.free };
}

/**
 * How many more MCQs this student may answer from the balance right now:
 * min(balance, the student's daily limit left, and — while only free MCQs are
 * left — the free 20-a-day). Returns { allowed, reason } with reason
 * 'no_balance' | 'daily_limit' | 'free_daily' when allowed is 0.
 */
async function allowance(parentId, studentId, exec = db) {
  const cfg = await config(exec);
  const bal = await balance(parentId, exec);
  if (bal.left <= 0) return { allowed: 0, reason: 'no_balance', balance: bal };
  const st = (await exec.query(`SELECT daily_mcq_limit FROM students WHERE id = $1`, [studentId])).rows[0];
  const limit = Number(st?.daily_mcq_limit) || cfg.daily_limit;
  const used = await usedToday(parentId, studentId, exec);
  const studentLeft = Math.max(0, limit - used.student);
  if (studentLeft <= 0) return { allowed: 0, reason: 'daily_limit', balance: bal, limit };
  // Free MCQs carry their own 20-a-day; paid MCQs are not held back by it.
  const freeLeftToday = Math.max(0, cfg.free_per_day - used.free);
  const usable = bal.paid + Math.min(bal.free, freeLeftToday);
  if (usable <= 0) return { allowed: 0, reason: 'free_daily', balance: bal, limit };
  return { allowed: Math.min(usable, studentLeft), reason: null, balance: bal, limit };
}

/**
 * Take ONE MCQ for an answered question. Soonest-expiring lot first; free MCQs
 * past their 20 for today are skipped. Returns the lot used, or null when nothing
 * could pay (the caller stops the quiz and offers a recharge). Idempotent per history row.
 */
async function debit({ parentId, studentId, trackerId, historyId }) {
  const cfg = await config();
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const seen = (await c.query(`SELECT lot_id FROM mcq_usage WHERE history_id = $1`, [historyId])).rows[0];
    if (seen) { await c.query('ROLLBACK'); return { lotId: seen.lot_id, again: true }; }
    const used = await usedToday(parentId, studentId, c);
    const freeOk = used.free < cfg.free_per_day;
    const lot = (await c.query(
      `SELECT id, source FROM mcq_lots
        WHERE parent_id = $1 AND expires_at > now() AND used < mcqs AND ($2 OR source <> 'free')
        ORDER BY expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [parentId, freeOk])).rows[0];
    if (!lot) { await c.query('ROLLBACK'); return null; }
    await c.query(`UPDATE mcq_lots SET used = used + 1 WHERE id = $1`, [lot.id]);
    await c.query(
      `INSERT INTO mcq_usage (parent_id, student_id, tracker_id, history_id, lot_id, source)
       VALUES ($1, $2, $3, $4, $5, $6)`, [parentId, studentId, trackerId, historyId, lot.id, lot.source]);
    await c.query('COMMIT');
    return { lotId: lot.id, source: lot.source };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

module.exports = {
  config, packs, packButtons, balance, hadFree, onPlan, freeEligible, grantFree, addLot,
  usedToday, allowance, debit, yearEnd, fmtDay,
};
