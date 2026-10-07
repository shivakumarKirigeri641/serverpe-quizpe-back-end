#!/usr/bin/env node
/**
 * scripts/service-pause.js — HOLD PAYING FAMILIES' DAYS WHILE QUIZZES CANNOT
 * BE SENT (user, 2026-10-07: the WhatsApp account was disabled, every send is
 * blocked, and no parent should lose the days they paid for).
 *
 *   node scripts/service-pause.js start ["reason"]   note the pause and which plans were running
 *   node scripts/service-pause.js status             what "end" would do — changes nothing
 *   node scripts/service-pause.js end --yes          add the lost days to those plans
 *
 * "start" remembers every subscription active at that moment (is_active and
 * plan_end_date today or later — trials included). "end" adds the whole days
 * the pause lasted (rounded up, at least 1) to each of them that is still
 * active, so a plan that ran out during the pause comes back with its days.
 * One open pause at a time; "end" runs once per pause. QuizPe's own database
 * only.
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

async function schema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS quizpe_service_pauses (
      id               bigserial PRIMARY KEY,
      reason           text,
      started_at       timestamptz NOT NULL DEFAULT now(),
      ended_at         timestamptz,
      days_added       integer,
      subscription_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,
      extended         integer
    )`);
}

const open = () => db.query(`SELECT * FROM quizpe_service_pauses WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`).then((r) => r.rows[0]);
const daysSince = (at) => Math.max(1, Math.ceil((Date.now() - new Date(at).getTime()) / 864e5));

async function start(reason) {
  if (await open()) { console.log('A pause is already running — see: node scripts/service-pause.js status'); return; }
  const { rows } = await db.query(
    `SELECT s.id FROM parents_quizpe_subscriptions s WHERE s.is_active AND s.plan_end_date >= CURRENT_DATE`);
  const ids = rows.map((r) => Number(r.id));
  const { rows: [p] } = await db.query(
    `INSERT INTO quizpe_service_pauses (reason, subscription_ids) VALUES ($1, $2::jsonb) RETURNING id, started_at`,
    [reason || 'WhatsApp unavailable', JSON.stringify(ids)]);
  console.log(`Pause #${p.id} started ${new Date(p.started_at).toLocaleString('en-IN')} — ${ids.length} running plan(s) will get the lost days back at "end".`);
}

async function preview(p) {
  const days = daysSince(p.started_at);
  const { rows } = await db.query(
    `SELECT s.id, s.plan_end_date::text AS ends, (s.plan_end_date + $2::int)::text AS new_end, pl.is_trial,
            p.parent_name, right(p.parent_mobile_number, 4) AS last4
       FROM parents_quizpe_subscriptions s
       JOIN parents p ON p.id = s.parent_id
       LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE s.id = ANY($1::bigint[]) AND s.is_active
      ORDER BY s.plan_end_date`, [p.subscription_ids || [], days]);
  return { days, rows };
}

async function status() {
  const p = await open();
  if (!p) {
    const last = (await db.query(`SELECT * FROM quizpe_service_pauses ORDER BY id DESC LIMIT 1`)).rows[0];
    console.log(last ? `No pause running. Last: #${last.id}, ${last.days_added} day(s) added to ${last.extended} plan(s) on ${new Date(last.ended_at).toLocaleString('en-IN')}.`
      : 'No pause has been started.');
    return;
  }
  const { days, rows } = await preview(p);
  console.log(`Pause #${p.id} since ${new Date(p.started_at).toLocaleString('en-IN')} (${p.reason}).`);
  console.log(`"end" now would add ${days} day(s) to ${rows.length} plan(s):`);
  for (const r of rows.slice(0, 40)) console.log(`  ${r.parent_name || '—'} ••${r.last4}${r.is_trial ? ' (trial)' : ''}: ${r.ends} -> ${r.new_end}`);
  if (rows.length > 40) console.log(`  … and ${rows.length - 40} more`);
}

async function end(confirmed) {
  const p = await open();
  if (!p) { console.log('No pause is running.'); return; }
  const { days, rows } = await preview(p);
  if (!confirmed) {
    console.log(`Would add ${days} day(s) to ${rows.length} plan(s). Run again with --yes to do it.`);
    return;
  }
  const client = await db.getClient();
  const q = client.query.bind(client);
  try {
    await q('BEGIN');
    // Claim the pause first, so a second "end" cannot add the days twice.
    const claimed = await q(`UPDATE quizpe_service_pauses SET ended_at = now(), days_added = $2 WHERE id = $1 AND ended_at IS NULL RETURNING id`, [p.id, days]);
    if (!claimed.rowCount) { await q('ROLLBACK'); console.log('This pause was already ended.'); return; }
    const out = await q(
      `UPDATE parents_quizpe_subscriptions SET plan_end_date = plan_end_date + $2::int, modified_at = now()
        WHERE id = ANY($1::bigint[]) AND is_active`, [p.subscription_ids || [], days]);
    await q(`UPDATE quizpe_service_pauses SET extended = $2 WHERE id = $1`, [p.id, out.rowCount]);
    await q('COMMIT');
    console.log(`Pause #${p.id} ended: ${days} day(s) added to ${out.rowCount} plan(s).`);
  } catch (e) {
    await q('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

(async () => {
  await schema();
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'start') await start(arg);
  else if (cmd === 'status') await status();
  else if (cmd === 'end') await end(process.argv.includes('--yes'));
  else console.log('Use: start ["reason"] | status | end --yes');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
