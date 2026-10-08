/**
 * src/admin/hq/push.js — phone push notifications for the QuizPe admin
 * (user, 2026-10-05, admin revamp phase 5), as GaadiPe has them: the panel
 * asks the browser once, the subscription is kept in hq_push, and alerts
 * arrive on the phone even with the panel closed.
 *
 * The VAPID keys are made on first use and kept in app_settings
 * (hq_vapid_public / hq_vapid_private) — nothing to add to .env.
 */

const db = require('../../database/connectDB');

let webpush = null;
try { webpush = require('web-push'); } catch { webpush = null; }   // not installed yet: push is simply off

async function keys() {
  if (!webpush) return null;
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('hq_vapid_public', 'hq_vapid_private')`);
  const k = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (k.hq_vapid_public && k.hq_vapid_private) return { publicKey: k.hq_vapid_public, privateKey: k.hq_vapid_private };
  const made = webpush.generateVAPIDKeys();
  await db.query(
    `INSERT INTO app_settings (key, value) SELECT * FROM (VALUES ('hq_vapid_public', $1), ('hq_vapid_private', $2)) v(k, val)
      WHERE NOT EXISTS (SELECT 1 FROM app_settings a WHERE a.key = v.k)`, [made.publicKey, made.privateKey]);
  return keys();
}

async function publicKey() {
  const k = await keys();
  return k ? k.publicKey : null;
}

async function subscribe(sub, adminMobile) {
  if (!sub?.endpoint || !sub?.keys) throw Object.assign(new Error('Not a push subscription.'), { status: 400 });
  await db.query(
    `INSERT INTO hq_push (endpoint, keys, admin_mobile) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, admin_mobile = EXCLUDED.admin_mobile`,
    [sub.endpoint, JSON.stringify(sub.keys), adminMobile || null]);
  return { ok: true };
}

async function unsubscribe(endpoint) {
  await db.query(`DELETE FROM hq_push WHERE endpoint = $1`, [endpoint]);
  return { ok: true };
}

/** To every subscribed phone. Gone subscriptions are removed. Never throws. */
async function send({ title, body, url = '/', tag }) {
  try {
    const k = await keys();
    if (!k) return { sent: 0, off: true };
    webpush.setVapidDetails('mailto:support@quizpe.in', k.publicKey, k.privateKey);
    const { rows } = await db.query(`SELECT endpoint, keys FROM hq_push`);
    let sent = 0;
    for (const r of rows) {
      try {
        await webpush.sendNotification({ endpoint: r.endpoint, keys: r.keys }, JSON.stringify({ title, body, url, tag }), { TTL: 3600 });
        sent += 1;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await db.query(`DELETE FROM hq_push WHERE endpoint = $1`, [r.endpoint]);
        else console.error('[hq-push]', e.statusCode || '', e.message);
      }
    }
    return { sent };
  } catch (e) {
    console.error('[hq-push] send:', e.message);
    return { sent: 0 };
  }
}

async function count() {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM hq_push`);
  return rows[0].n;
}

module.exports = { publicKey, subscribe, unsubscribe, send, count, keys, available: () => Boolean(webpush) };
