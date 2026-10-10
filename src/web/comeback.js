/**
 * src/web/comeback.js — THE COMEBACK OFFER (user, 2026-10-10: "give an offer to all lapsed
 * families to take 7 days free trial — but keep it until SMS gets approved").
 * ---------------------------------------------------------------------------
 *   config()            { on, days }  — app_settings comeback_trial_on / _days
 *   eligibleSql         the families it is for, as SQL (alias p = parents)
 *   offerFor(ctx)       { days } when this family may take it now, else null
 *   start(mobile)       switches it on: a free plan for N days, for the children
 *                       already registered — once per family (parents.comeback_trial_at)
 *   stats()             how many families it is for, and how many took it
 *
 * Who it is for: a family whose last plan (free trial or paid) has ENDED, with
 * nothing running or booked after it, at least one child registered, not
 * deactivated — and who has not had this offer before. It is the same free trial
 * plan (quizpe_plans is_trial), so the quizzes, reminders and reports work exactly
 * as in any trial; only its length comes from comeback_trial_days.
 *
 * OFF until switched on in the admin (hq Website page), so it opens together with
 * the SMS that tells the families about it.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

async function config() {
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('comeback_trial_on', 'comeback_trial_days')`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const days = Math.min(30, Math.max(1, Number(m.comeback_trial_days) || 7));
  return { on: String(m.comeback_trial_on) === 'true', days };
}

/* A lapsed family that has not had the offer (p = parents). */
const eligibleSql = `
  p.is_active AND p.deactivated_at IS NULL AND p.comeback_trial_at IS NULL
  AND EXISTS (SELECT 1 FROM students st WHERE st.parent_id = p.id AND st.is_active)
  AND EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s WHERE s.parent_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s
                   WHERE s.parent_id = p.id AND s.plan_end_date >= CURRENT_DATE AND s.is_active)`;

async function offerFor(ctx) {
  if (!ctx?.exists || ctx.isSubscribed) return null;
  const c = await config();
  if (!c.on) return null;
  const { rows } = await db.query(`SELECT 1 FROM parents p WHERE p.id = $1 AND ${eligibleSql}`, [ctx.parentId]);
  return rows.length ? { days: c.days } : null;
}

async function start(mobile) {
  const c = await config();
  if (!c.on) throw Object.assign(new Error('This offer is not available right now.'), { status: 409 });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Locked, so two taps cannot both start it.
    const p = (await client.query(
      `SELECT p.id FROM parents p WHERE p.parent_mobile_number = $1 AND ${eligibleSql} FOR UPDATE`, [mobile])).rows[0];
    if (!p) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('This offer is for families whose plan has ended, once. Please choose a plan to continue.'), { status: 409 });
    }
    const trial = (await client.query(
      `SELECT id FROM quizpe_plans WHERE is_trial AND is_active ORDER BY id LIMIT 1`)).rows[0];
    if (!trial) throw new Error('NO_ACTIVE_TRIAL_PLAN');
    // Only one subscription may be active (uq_active_sub_per_parent) — the ended ones step aside.
    await client.query(`UPDATE parents_quizpe_subscriptions SET is_active = false, modified_at = now() WHERE parent_id = $1 AND is_active`, [p.id]);
    const { slotFor } = require('../whatsapp/quizSlot');
    const slot = slotFor(p.id);
    // N days including today, as the trial counts them (trialRouter: CURRENT_DATE + duration).
    const sub = (await client.query(
      `INSERT INTO parents_quizpe_subscriptions (parent_id, plan_id, plan_end_date, quiz_time, reminder_time)
       VALUES ($1, $2, CURRENT_DATE + $3::int, $4::time, $5::time)
       RETURNING id, plan_start_date, plan_end_date`,
      [p.id, trial.id, c.days, slot.quiz_time, slot.reminder_time])).rows[0];
    // Back on: quizzes and reminders reach them again (a STOP is their own choice, kept).
    await client.query(
      `UPDATE parents SET comeback_trial_at = now(), reminders_enabled = true, modified_at = now() WHERE id = $1`, [p.id]);
    await client.query('COMMIT');
    console.log(`[comeback] ${String(mobile).slice(0, 2)}xxxxxx${String(mobile).slice(-2)} took the ${c.days}-day comeback trial (sub ${sub.id})`);
    return { days: c.days, ends: sub.plan_end_date };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function stats() {
  const c = await config();
  const { rows: [r] } = await db.query(
    `SELECT (SELECT count(*) FROM parents p WHERE ${eligibleSql})::int AS eligible,
            (SELECT count(*) FROM parents WHERE comeback_trial_at IS NOT NULL)::int AS taken,
            (SELECT count(*) FROM parents WHERE comeback_trial_at > now() - interval '7 days')::int AS taken_7d`);
  return { ...c, ...r };
}

async function set({ on, days }) {
  if (on != null) {
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('comeback_trial_on', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [on ? 'true' : 'false']);
  }
  if (days != null) {
    const d = Math.min(30, Math.max(1, Number(days) || 7));
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('comeback_trial_days', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(d)]);
  }
  return stats();
}

module.exports = { config, offerFor, start, stats, set, eligibleSql };
