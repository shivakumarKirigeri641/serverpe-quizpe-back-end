/**
 * src/admin/hq/shared.js — the panel's frame (user, 2026-10-05, admin revamp
 * phase 1): the WhatsApp limit shared with GaadiPe, Meta's view of the QuizPe
 * number, Meta's account news, the status strip and the menu's counts.
 *
 * Everything here READS. The only writes are to QuizPe's own hq_* tables
 * (hq_meta_seen, hq_alerts) and app_settings — never to a quiz, parent or
 * message table, and never to GaadiPe's database (hq/peer.js is read-only).
 */

const db = require('../../database/connectDB');
const peer = require('./peer');

/* ───────────────────────────── settings ───────────────────────────── */

let cache = { at: 0, map: {} };
async function setting(key, fallback) {
  if (Date.now() - cache.at > 15000) {
    const { rows } = await db.query(`SELECT key, value FROM app_settings`);
    cache = { at: Date.now(), map: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }
  return key in cache.map ? cache.map[key] : fallback;
}
const num = async (key, fallback) => {
  const v = Number(await setting(key, fallback));
  return Number.isFinite(v) ? v : fallback;
};
const forget = () => { cache.at = 0; };

/* ───────────────────────── the shared WhatsApp limit ───────────────────────── */

/**
 * People messaged FIRST in the last 24 hours (templates, not failed), by QuizPe
 * and — when linked — by GaadiPe. Meta's limit counts the portfolio, so the
 * two together are what matters. A reply inside a customer's window is not a
 * template and does not count.
 */
async function waLimit() {
  const limit = await num('hq_messaging_limit', 250);
  const reserve = await num('hq_limit_reserve', 50);
  const q = await db.query(
    `SELECT count(DISTINCT mobile_number)::int AS n FROM whatsapp_messages
      WHERE direction = 'outbound' AND message_type = 'template'
        AND created_at > now() - interval '24 hours'
        AND coalesce(status, '') <> 'failed' AND coalesce(error_message, '') = ''`);
  const g = await peer.read(
    `SELECT count(DISTINCT mobile)::int AS n FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template'
        AND created_at > now() - interval '24 hours' AND coalesce(error_message, '') = ''`);
  const quizpe = q.rows[0].n;
  const gaadipe = g ? g[0].n : null;
  const used = quizpe + (gaadipe || 0);
  return {
    limit, reserve, used, quizpe, gaadipe, linked: g !== null,
    remaining: Math.max(0, limit - used),
    free_for_broadcast: Math.max(0, limit - used - reserve),
    note: g === null
      ? (peer.configured() ? 'GaadiPe could not be read just now — only QuizPe is counted.' : 'GaadiPe is not linked (PEER_PGDATABASE), so only QuizPe is counted. Both share the same Meta limit.')
      : 'QuizPe + GaadiPe together — they share one Meta limit.',
  };
}

/* ─────────────────────────── Meta's view of the number ─────────────────────────── */

let metaCache = { at: 0, data: null };
// WhatsApp is retired (2026-10-07): Meta is no longer asked about the number.
const WHATSAPP_RETIRED = true;
/** Tier, quality, name status and health of the QuizPe number, from Meta (cached 10 min). */
async function metaStatus({ fresh = false } = {}) {
  if (WHATSAPP_RETIRED) return { ok: false, retired: true, error: 'WhatsApp has been disabled for QuizPe. Nothing is sent to WhatsApp.' };
  if (!fresh && metaCache.data && Date.now() - metaCache.at < 600000) return metaCache.data;
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!id || !token) return { ok: false, error: 'WhatsApp is not configured.' };
  try {
    const v = process.env.WHATSAPP_API_VERSION || 'v21.0';
    const r = await fetch(`https://graph.facebook.com/${v}/${id}?fields=display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,whatsapp_business_manager_messaging_limit,health_status,status`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const phone = (j.health_status?.entities || []).find((e) => e.entity_type === 'PHONE_NUMBER') || {};
    const data = {
      ok: true, at: new Date().toISOString(),
      number: j.display_phone_number, name: j.verified_name, name_status: j.name_status,
      quality: j.quality_rating, tier: j.whatsapp_business_manager_messaging_limit || j.messaging_limit_tier,
      status: j.status, can_send: phone.can_send_message || j.health_status?.can_send_message || null,
      notes: [...(phone.additional_info || []), ...(phone.errors || []).filter((x) => !/SIP/i.test(x.error_description || '')).map((x) => x.error_description)],
    };
    metaCache = { at: Date.now(), data };
    // The limit Meta gives is the limit we plan with.
    const tierN = { TIER_250: 250, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: 1000000 }[data.tier];
    if (tierN && tierN !== await num('hq_messaging_limit', 250)) {
      await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'hq_messaging_limit'`, [String(tierN)]);
      forget();
    }
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ───────────────────────────── Meta's account news ───────────────────────────── */

/**
 * Meta's account webhooks (limit decisions, number cap, display name, quality)
 * reach GaadiPe's server, which keeps them as admin alerts with source 'meta'.
 * Shown here too — read-only from GaadiPe — and "Got it" is remembered in
 * QuizPe's own hq_meta_seen, never written back to GaadiPe.
 */
async function metaNews() {
  const rows = await peer.read(
    `SELECT id::text AS id, created_at, severity, title, description FROM admin_alerts
      WHERE source = 'meta' AND created_at > now() - interval '30 days' ORDER BY created_at LIMIT 20`);
  if (!rows || !rows.length) return [];
  const { rows: seen } = await db.query(`SELECT alert_id FROM hq_meta_seen WHERE alert_id = ANY($1::text[])`, [rows.map((r) => r.id)]);
  const done = new Set(seen.map((s) => s.alert_id));
  return rows.filter((r) => !done.has(r.id)).slice(0, 10);
}
async function metaSeen(id, who) {
  await db.query(`INSERT INTO hq_meta_seen (alert_id, seen_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [String(id), who || null]);
  return { ok: true };
}

/* ───────────────────────────── the status strip ───────────────────────────── */

/** One light per thing the business depends on: green, amber or red, with why. */
async function status() {
  const out = [];
  const meta = await metaStatus();
  out.push(meta.ok
    ? {
      key: 'whatsapp', label: 'WhatsApp',
      state: meta.quality === 'RED' || meta.can_send === 'BLOCKED' ? 'down' : meta.quality === 'YELLOW' || meta.can_send === 'LIMITED' ? 'warn' : 'ok',
      detail: `Quality ${meta.quality || '?'} · limit ${meta.tier || '?'} · ${meta.can_send === 'BLOCKED' ? 'blocked from starting chats (limit reached)' : meta.can_send === 'LIMITED' ? 'limited' : 'can send'}`,
      notes: meta.notes,
    }
    : { key: 'whatsapp', label: 'WhatsApp', state: 'down', detail: `Meta could not be read: ${meta.error}` });

  const lim = await waLimit();
  out.push({
    key: 'limit', label: 'Daily limit',
    state: lim.used >= lim.limit ? 'down' : lim.used >= lim.limit - lim.reserve ? 'warn' : 'ok',
    detail: `${lim.used} of ${lim.limit} people messaged first in 24 h (QuizPe ${lim.quizpe}${lim.linked ? ` + GaadiPe ${lim.gaadipe}` : ', GaadiPe not linked'})`,
  });

  try {
    await db.query('SELECT 1');
    out.push({ key: 'db', label: 'Database', state: 'ok', detail: 'Answering' });
  } catch (e) { out.push({ key: 'db', label: 'Database', state: 'down', detail: e.message }); }

  const beat = await setting('scheduler_heartbeat', null);
  const beatAge = beat ? (Date.now() - new Date(beat).getTime()) / 60000 : null;
  const jobs = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
            count(*) FILTER (WHERE status = 'running' AND locked_at < now() - interval '15 minutes')::int AS stuck
       FROM job_queue`).catch(() => ({ rows: [{ failed: 0, stuck: 0 }] }));
  const j = jobs.rows[0];
  out.push({
    key: 'jobs', label: 'Quiz scheduler',
    state: beatAge === null || beatAge > 10 || j.stuck ? 'down' : j.failed ? 'warn' : 'ok',
    detail: `${beatAge === null ? 'No heartbeat recorded' : `Last heartbeat ${Math.round(beatAge)} min ago`} · ${j.failed} failed job(s) in 24 h${j.stuck ? ` · ${j.stuck} stuck` : ''}`,
  });

  const rz = Boolean(process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_LIVE_KEY_ID || process.env.RAZORPAY_TEST_KEY_ID);
  out.push({ key: 'payments', label: 'Razorpay', state: rz ? 'ok' : 'warn', detail: rz ? `Configured (${await setting('razorpay_mode', 'live')} mode)` : 'No Razorpay key in .env' });

  out.push({
    key: 'peer', label: 'GaadiPe link',
    state: lim.linked ? 'ok' : peer.configured() ? 'down' : 'off',
    detail: lim.linked ? 'Reading the shared limit and Meta news (read-only)' : peer.configured() ? 'Configured but not reachable' : 'Not linked — set PEER_PGDATABASE to count GaadiPe in the shared limit',
  });
  return out;
}

/* ───────────────────────────── the menu's counts ───────────────────────────── */

async function badges() {
  const r = await db.query(`
    SELECT
      (SELECT count(DISTINCT mobile_number)::int FROM whatsapp_messages
        WHERE direction = 'inbound' AND created_at > now() - interval '15 minutes') AS whatsapp_live,
      (SELECT count(*)::int FROM parents p
        WHERE p.is_active AND NOT p.service_paused
          AND EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
                       WHERE s.parent_id = p.id AND s.is_active AND pl.is_trial
                         AND s.plan_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 2)
          AND NOT EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s2 JOIN quizpe_plans pl2 ON pl2.id = s2.plan_id
                           WHERE s2.parent_id = p.id AND s2.is_active AND NOT pl2.is_trial AND s2.plan_end_date >= CURRENT_DATE)) AS trials_ending,
      (SELECT count(*)::int FROM hq_alerts WHERE status = 'open') AS alerts_open,
      (SELECT count(*)::int FROM hq_alerts WHERE status = 'open' AND severity = 'critical') AS alerts_critical,
      (SELECT count(*)::int FROM support_tickets WHERE coalesce(status, 'open') NOT IN ('closed', 'resolved')) AS support_open,
      (SELECT count(*)::int FROM hq_broadcast_plans WHERE status = 'running') AS plans_running`)
    .catch(async () => db.query(`SELECT 0 AS whatsapp_live, 0 AS trials_ending, 0 AS alerts_open, 0 AS alerts_critical, 0 AS support_open, 0 AS plans_running`));
  return { ...r.rows[0], limit: await waLimit() };
}

module.exports = { setting, num, forget, waLimit, metaStatus, metaNews, metaSeen, status, badges };
