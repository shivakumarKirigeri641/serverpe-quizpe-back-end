/**
 * src/web/notify.js — reaching a parent now that WhatsApp is gone
 * (user, 2026-10-08): phone push to every device they allowed on
 * quizpe.in/app, and an email when they gave one.
 * ---------------------------------------------------------------------------
 *   subscribe(mobile, sub) / unsubscribe(endpoint)
 *   toMobile(mobile, { title, body, url, tag, email })
 *       -> { push: n, email: bool, reached: bool }   never throws
 *
 * The VAPID keys are the admin panel's (src/admin/hq/push.js) — one key pair
 * per server is all web push needs. A subscription the browser has dropped
 * (404/410) is removed.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const hqPush = require('../admin/hq/push');

let webpush = null;
try { webpush = require('web-push'); } catch { webpush = null; }

const APP_URL = () => (process.env.PARENT_APP_URL || 'https://quizpe.in/app').replace(/\/$/, '');

async function subscribe(mobile, sub) {
  if (!sub?.endpoint || !sub?.keys) throw Object.assign(new Error('Not a push subscription.'), { status: 400 });
  await db.query(
    `INSERT INTO parent_push (endpoint, keys, mobile_number) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, mobile_number = EXCLUDED.mobile_number`,
    [sub.endpoint, JSON.stringify(sub.keys), mobile]);
  return { ok: true };
}

async function unsubscribe(endpoint) {
  await db.query(`DELETE FROM parent_push WHERE endpoint = $1`, [endpoint]);
  return { ok: true };
}

async function pushTo(mobile, payload) {
  if (!webpush) return 0;
  const k = await hqPush.keys();
  if (!k) return 0;
  webpush.setVapidDetails('mailto:support@quizpe.in', k.publicKey, k.privateKey);
  const { rows } = await db.query(`SELECT endpoint, keys FROM parent_push WHERE mobile_number = $1`, [mobile]);
  let sent = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: r.keys }, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await db.query(`DELETE FROM parent_push WHERE endpoint = $1`, [r.endpoint]);
      else console.error('[parent-push]', e.statusCode || '', e.message);
    }
  }
  return sent;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

async function emailTo(mobile, { title, body, url }) {
  const { rows } = await db.query(`SELECT parent_name, email FROM parents WHERE parent_mobile_number = $1 AND email IS NOT NULL`, [mobile]);
  const p = rows[0];
  if (!p?.email) return false;
  const link = url || APP_URL();
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1f2937">
    <h2 style="color:#4f46e5;margin:0 0 12px">${esc(title)}</h2>
    <p style="font-size:15px;line-height:1.5">Hi ${esc(String(p.parent_name || '').split(' ')[0] || 'there')},</p>
    <p style="font-size:15px;line-height:1.5">${esc(body)}</p>
    <p><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open QuizPe</a></p>
    <p style="font-size:12px;color:#6b7280">You get this because you use QuizPe with this email. Change it any time in your QuizPe account.</p></div>`;
  const r = await require('../mail/mailer').sendParentMail({ to: p.email, subject: title, html });
  return Boolean(r.sent);
}

async function toMobile(mobile, { title, body, url, tag, email = true }) {
  const out = { push: 0, email: false, reached: false };
  try { out.push = await pushTo(mobile, { title, body, url: url || APP_URL(), tag }); } catch (e) { console.error('[parent-notify] push:', e.message); }
  if (email) {
    try { out.email = await emailTo(mobile, { title, body, url }); } catch (e) { console.error('[parent-notify] email:', e.message); }
  }
  out.reached = out.push > 0 || out.email;
  return out;
}

module.exports = { subscribe, unsubscribe, toMobile, APP_URL };
