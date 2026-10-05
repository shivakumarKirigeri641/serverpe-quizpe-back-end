/**
 * src/admin/hq/alerts.js — the alerts centre (user, 2026-10-05, admin revamp
 * phase 5). Every five minutes the conditions below are checked; a problem
 * opens ONE alert (hq_alerts, one open row per key), tells the admin once —
 * phone push and email — and closes by itself when the condition clears.
 *
 * It only reads QuizPe's quiz, parent and message tables; it writes only to
 * hq_alerts. It never messages a parent.
 */

const db = require('../../database/connectDB');
const shared = require('./shared');

async function raise({ key, severity = 'warning', title, description }) {
  const { rows } = await db.query(
    `INSERT INTO hq_alerts (key, severity, title, description) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) WHERE status = 'open' DO UPDATE SET description = EXCLUDED.description, severity = EXCLUDED.severity
     RETURNING id, (xmax = 0) AS fresh`, [key, severity, title, description || null]);
  if (rows[0]?.fresh) {
    console.log('[hq-alerts] raised %s: %s', key, title);
    require('./push').send({ title: `QuizPe: ${title}`, body: description || '', url: '/alerts', tag: key }).catch(() => {});
    if (severity !== 'info') {
      try {
        const { sendAdminMail } = require('../../mail/mailer');
        await sendAdminMail({ subject: `QuizPe alert: ${title}`, text: `${title}\n\n${description || ''}\n\nOpen the admin panel → Alerts.` });
      } catch (e) { console.error('[hq-alerts] mail:', e.message); }
    }
  }
}

async function clear(key, resolution = 'Cleared by itself') {
  await db.query(`UPDATE hq_alerts SET status = 'resolved', resolved_at = now(), resolution = $2 WHERE key = $1 AND status = 'open'`, [key, resolution]);
}
const toggle = (on, alert) => (on ? raise(alert) : clear(alert.key));

/* The conditions. Each is cheap and read-only. */
async function check() {
  // 1. The quiz scheduler is alive (it writes a heartbeat every minute).
  const beat = await shared.setting('scheduler_heartbeat', null);
  const age = beat ? (Date.now() - new Date(beat).getTime()) / 60000 : Infinity;
  await toggle(age > 10, { key: 'scheduler_down', severity: 'critical', title: 'Quiz scheduler has stopped',
    description: beat ? `No heartbeat for ${Math.round(age)} minutes — quizzes and reminders are not going out.` : 'No heartbeat recorded.' });

  // 2. The shared WhatsApp limit is nearly used up.
  const lim = await shared.waLimit();
  await toggle(lim.used >= lim.limit * 0.9, { key: 'wa_limit', severity: lim.used >= lim.limit ? 'critical' : 'warning',
    title: 'WhatsApp daily limit nearly reached',
    description: `${lim.used} of ${lim.limit} people messaged first in 24 h (QuizPe ${lim.quizpe}${lim.linked ? ` + GaadiPe ${lim.gaadipe}` : ''}). New quiz messages may be refused.` });

  // 3. Meta's view of the number.
  const meta = await shared.metaStatus();
  if (meta.ok) {
    await toggle(meta.quality && meta.quality !== 'GREEN', { key: 'wa_quality', severity: meta.quality === 'RED' ? 'critical' : 'warning',
      title: `WhatsApp quality is ${meta.quality}`, description: 'Fewer marketing messages and more care with templates until it is green again.' });
  }

  // 4. A template that keeps failing (e.g. not approved in the language it is sent in).
  const { rows: bad } = await db.query(
    `SELECT coalesce(payload->'template'->>'name', '?') AS name, count(*)::int AS failed,
            max(error_message) AS error
       FROM whatsapp_messages
      WHERE direction = 'outbound' AND message_type = 'template' AND status = 'failed' AND created_at > now() - interval '24 hours'
      GROUP BY 1 HAVING count(*) >= 5`);
  const failing = new Set(bad.map((b) => `tpl_failing:${b.name}`));
  for (const b of bad) {
    await raise({ key: `tpl_failing:${b.name}`, severity: 'warning', title: `Template ${b.name} is failing`,
      description: `${b.failed} sends failed in 24 h. Meta says: ${b.error || 'unknown'}` });
  }
  const { rows: openTpl } = await db.query(`SELECT key FROM hq_alerts WHERE status = 'open' AND key LIKE 'tpl_failing:%'`);
  for (const o of openTpl) if (!failing.has(o.key)) await clear(o.key);

  // 5. Jobs failing.
  const { rows: [j] } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '6 hours')::int AS failed,
            count(*) FILTER (WHERE status = 'running' AND locked_at < now() - interval '30 minutes')::int AS stuck
       FROM job_queue`);
  await toggle(j.failed >= 5 || j.stuck > 0, { key: 'jobs', severity: 'warning', title: 'Background jobs are failing',
    description: `${j.failed} failed in 6 h${j.stuck ? `, ${j.stuck} stuck for over 30 minutes` : ''}. See System health.` });

  // 6. A support ticket waiting more than a day.
  const { rows: [t] } = await db.query(
    `SELECT count(*)::int AS n FROM support_tickets WHERE coalesce(status, 'open') = 'open' AND created_at < now() - interval '24 hours'`);
  await toggle(t.n > 0, { key: 'support_waiting', severity: 'warning', title: `${t.n} support ticket(s) waiting over a day`,
    description: 'A parent is waiting for an answer. See Support.' });

  // 7. Trials ending soon without payment — good news to act on, not a fault.
  const b = await shared.badges();
  await toggle(b.trials_ending > 0, { key: 'trials_ending', severity: 'info', title: `${b.trials_ending} free trial(s) end within 2 days`,
    description: 'See Hot leads → Trial ending.' });
}

async function list({ status = 'open', limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT id::text AS id, key, severity, title, description, status, created_at, resolved_at, resolution
       FROM hq_alerts WHERE ($1 = 'all' OR status = $1) ORDER BY (status = 'open') DESC, created_at DESC LIMIT $2`,
    [status, limit]);
  return rows;
}

async function resolve(id, note) {
  await db.query(`UPDATE hq_alerts SET status = 'resolved', resolved_at = now(), resolution = $2 WHERE id = $1 AND status = 'open'`,
    [id, String(note || 'Resolved by hand').slice(0, 300)]);
  return { ok: true };
}

module.exports = { check, list, resolve, raise, clear };
