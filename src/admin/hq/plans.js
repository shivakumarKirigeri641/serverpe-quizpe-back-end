/**
 * src/admin/hq/plans.js — BROADCAST IN BATCHES for QuizPe (user, 2026-10-05,
 * admin revamp phase 4). The same idea as GaadiPe's, in QuizPe's own way.
 *
 * Meta lets the business message only so many people first in any 24 hours
 * (250 today), and GaadiPe uses the same allowance. A plan holds the whole
 * list and sends it in parts:
 *   each batch  at most batch_size, and never more than the room left in the
 *               shared 24 hours (limit − QuizPe − GaadiPe − reserve, hq/shared)
 *   next batch  gap_hours later (24 by default)
 *   who         everyone in the plan not yet sent this template by the plan;
 *               someone who failed is tried once more in a later batch
 * Each batch goes through the broadcast page's own sender (sendOneByOne):
 * STOP and paused families are skipped, and a fatal Meta error stops the run.
 */

const db = require('../../database/connectDB');
const shared = require('./shared');

const clean = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const label = (id) => `plan:${id}`;

/** Who in the plan has been reached, failed (and how often), and who is left. */
async function progress(plan) {
  const all = (plan.mobiles || []).map(clean);
  const { rows } = await db.query(
    `SELECT mobile_number, bool_or(status = 'sent') AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM marketing_broadcasts WHERE segment = $1 GROUP BY mobile_number`, [label(plan.id)]);
  const by = new Map(rows.map((r) => [r.mobile_number, r]));
  const { rows: paused } = await db.query(
    `SELECT parent_mobile_number AS m FROM parents WHERE service_paused AND parent_mobile_number = ANY($1::text[])
     UNION SELECT mobile_number FROM whatsapp_sessions WHERE coalesce(opted_out, false) AND mobile_number = ANY($1::text[])`, [all]);
  const stopped = new Set(paused.map((r) => r.m));
  const sent = all.filter((m) => by.get(m)?.sent);
  const skipped = all.filter((m) => !by.get(m)?.sent && stopped.has(m));
  const gaveUp = all.filter((m) => !by.get(m)?.sent && !stopped.has(m) && (by.get(m)?.failed || 0) >= 2);
  const left = all.filter((m) => !by.get(m)?.sent && !stopped.has(m) && (by.get(m)?.failed || 0) < 2);
  return { total: all.length, sent: sent.length, skipped: skipped.length, gave_up: gaveUp.length, left };
}

async function templateNeeds(template) {
  const { rows: [t] } = await db.query(
    `SELECT variables FROM whatsapp_templates WHERE template_name = $1 AND is_active AND approval_status = 'APPROVED'`, [template]);
  if (!t) return null;
  const vars = Array.isArray(t.variables) ? t.variables : (() => { try { return JSON.parse(t.variables || '[]'); } catch { return []; } })();
  return Math.max(0, vars.length - 1);   // {{1}} is always the parent's first name
}

async function create({ template, params = [], mobiles = [], batch_size = 100, gap_hours = 24, reserve, start_at = null }, adminMobile) {
  const people = [...new Set((mobiles || []).map(clean).filter((m) => m.length === 10))];
  if (!people.length) return { ok: false, error: 'Choose at least one family.' };
  const need = await templateNeeds(template);
  if (need === null) return { ok: false, error: 'That template is not approved.' };
  const extra = (Array.isArray(params) ? params : []).map((x) => String(x ?? '').trim());
  if (extra.length !== need || extra.some((v) => !v)) return { ok: false, error: `This template needs ${need} text value(s) after the name.` };
  const size = Math.round(Number(batch_size));
  const gap = Number(gap_hours);
  const keep = reserve === undefined || reserve === null || reserve === '' ? await shared.num('hq_limit_reserve', 50) : Math.round(Number(reserve));
  if (!Number.isInteger(size) || size < 1 || size > 2000) return { ok: false, error: 'A batch is 1 to 2,000 families.' };
  if (!Number.isFinite(gap) || gap < 1 || gap > 168) return { ok: false, error: 'The gap is 1 to 168 hours.' };
  if (!Number.isInteger(keep) || keep < 0 || keep > 2000) return { ok: false, error: 'Keep free is 0 to 2,000.' };
  const at = start_at && !Number.isNaN(Date.parse(start_at)) ? new Date(start_at) : new Date();
  const { rows: [row] } = await db.query(
    `INSERT INTO hq_broadcast_plans (admin_mobile, template_name, params, mobiles, batch_size, gap_hours, reserve, next_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8) RETURNING id`,
    [adminMobile || null, template, JSON.stringify(extra), JSON.stringify(people), size, gap, keep, at.toISOString()]);
  if (at <= new Date()) setTimeout(() => tick().catch((e) => console.error('[hq-plans] first tick:', e.message)), 1000);
  return { ok: true, id: String(row.id), people: people.length, batches: Math.ceil(people.length / size) };
}

let running = false;
/** Send the next batch of each plan that is due. Every five minutes (app.js). */
async function tick() {
  if (running) return;                     // one batch at a time in this process
  running = true;
  try {
    const { rows } = await db.query(
      `SELECT * FROM hq_broadcast_plans WHERE status = 'running' AND next_at <= now() ORDER BY next_at LIMIT 3`);
    for (const plan of rows) {
      const { rows: mine } = await db.query(
        `UPDATE hq_broadcast_plans SET next_at = now() + interval '15 minutes', modified_at = now()
          WHERE id = $1 AND status = 'running' AND next_at <= now() RETURNING id`, [plan.id]);
      if (!mine.length) continue;
      await step(plan).catch(async (e) => {
        console.error('[hq-plans] plan %s: %s', plan.id, e.message);
        await note(plan.id, `Error: ${e.message}`.slice(0, 300), 60);
      });
    }
  } finally { running = false; }
}

async function step(plan) {
  const p = await progress(plan);
  if (!p.left.length) {
    await db.query(
      `UPDATE hq_broadcast_plans SET status = 'done', finished_at = now(), modified_at = now(), last_note = $2 WHERE id = $1`,
      [plan.id, `Done — ${p.sent} of ${p.total} reached${p.skipped ? `, ${p.skipped} skipped (STOP)` : ''}${p.gave_up ? `, ${p.gave_up} failed twice` : ''}.`]);
    return;
  }
  const lim = await shared.waLimit();
  const free = lim.limit - lim.used - Number(plan.reserve || 0);
  const size = Math.min(Number(plan.batch_size), free);
  if (size < 1) {
    await note(plan.id, `Waiting for room: ${lim.used} of ${lim.limit} people messaged first in 24 h (QuizPe ${lim.quizpe}${lim.linked ? ` + GaadiPe ${lim.gaadipe}` : ''}; ${plan.reserve} kept free).`, 60);
    return;
  }
  const batch = p.left.slice(0, size);
  // Names and sessions exactly as the broadcast page's direct send resolves them.
  const { rows: known } = await db.query(
    `SELECT p.parent_mobile_number AS mobile, COALESCE(NULLIF(split_part(p.parent_name, ' ', 1), ''), 'there') AS name, p.service_paused,
            (SELECT id FROM whatsapp_sessions w WHERE w.mobile_number = p.parent_mobile_number AND w.is_active ORDER BY id DESC LIMIT 1) AS session_id
       FROM parents p WHERE p.parent_mobile_number = ANY($1::text[])`, [batch]);
  const { rows: leads } = await db.query(
    `SELECT mobile_number AS mobile, COALESCE(NULLIF(split_part(context->>'parent_name', ' ', 1), ''), 'there') AS name, id AS session_id
       FROM whatsapp_sessions WHERE is_active AND mobile_number = ANY($1::text[]) ORDER BY id DESC`, [batch]);
  const by = Object.fromEntries(known.map((k) => [k.mobile, k]));
  for (const l of leads) if (!by[l.mobile]) by[l.mobile] = { ...l, service_paused: false };
  const recips = batch.map((m) => by[m] || { mobile: m, name: 'there', service_paused: false, session_id: null }).filter((r) => !r.service_paused);

  const bc = require('../broadcastRoutes');
  await bc.ensureSchema();
  const out = await bc.sendOneByOne(recips, {
    template: plan.template_name, extra: plan.params || [], label: label(plan.id), mobileOf: (r) => r.mobile,
  });
  const n = Number(plan.batches || 0) + 1;
  const after = await progress(plan);
  await db.query(
    `UPDATE hq_broadcast_plans SET batches = $2, modified_at = now(), next_at = now() + make_interval(mins => $3::int), last_note = $4,
            status = CASE WHEN $5 THEN 'paused' ELSE status END
      WHERE id = $1`,
    [plan.id, n, Math.round(Number(plan.gap_hours) * 60),
     out.stopped
       ? `Batch ${n} stopped by Meta: ${out.stopped}. Plan paused — fix it, then resume.`
       : `Batch ${n}: ${out.sent} sent, ${out.failed} failed. ${after.left.length ? `${after.left.length} left for the next batch.` : 'That was the last batch.'}`,
     Boolean(out.stopped)]);
  console.log('[hq-plans] plan %s batch %d: %d sent, %d failed', plan.id, n, out.sent, out.failed);
}

const note = (id, text, minutes) => db.query(
  `UPDATE hq_broadcast_plans SET last_note = $2, next_at = now() + make_interval(mins => $3::int), modified_at = now() WHERE id = $1`,
  [id, text, minutes]);

async function list() {
  const { rows } = await db.query(`SELECT * FROM hq_broadcast_plans ORDER BY id DESC LIMIT 50`);
  const out = [];
  for (const r of rows) {
    const p = await progress(r);
    out.push({
      id: String(r.id), template: r.template_name, status: r.status, batch_size: r.batch_size, gap_hours: Number(r.gap_hours),
      reserve: r.reserve, batches: r.batches, next_at: r.next_at, created_at: r.created_at, finished_at: r.finished_at, last_note: r.last_note,
      total: p.total, sent: p.sent, skipped: p.skipped, gave_up: p.gave_up, left: p.left.length,
    });
  }
  return { rows: out, limit: await shared.waLimit() };
}

async function act(id, action) {
  const to = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[action];
  if (!to) return { ok: false, error: 'Unknown action.' };
  const { rowCount } = await db.query(
    `UPDATE hq_broadcast_plans SET status = $2, modified_at = now(),
            next_at = CASE WHEN $2 = 'running' THEN greatest(next_at, now()) ELSE next_at END,
            finished_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE finished_at END
      WHERE id = $1 AND status IN ('running', 'paused')`, [id, to]);
  return rowCount ? { ok: true } : { ok: false, error: 'This plan has already finished.' };
}

module.exports = { create, tick, list, act, _test: { progress, step } };
