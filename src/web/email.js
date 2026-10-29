/**
 * src/web/email.js — A PARENT'S EMAIL, CONFIRMED, AND THE BROADCAST TO IT (user, 2026-10-21: "all do it"
 * — QuizPe like GaadiPe: confirm the email with a code, an unsubscribe link in every email, then a
 * broadcast from the admin).
 *
 *   sendCode(mobile, email)       a 4-digit code to that address (10 minutes, 5 tries, at most 5 an hour)
 *   verifyCode(mobile, email, c)  right code: the address is the parent's, confirmed (and subscribed again)
 *   unsubscribeRouter             GET/POST /email/unsubscribe/:token — the link in every broadcast email
 *   queueCampaign(...)            the admin's broadcast: one row per confirmed, subscribed family who agreed
 *   runSends()                    a few emails a minute from the queue (started by app.js)
 *
 * Mail never throws (mail/mailer.js). The code is kept only as a hash.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../database/connectDB');
const { sendParentMail } = require('../mail/mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BASE = () => (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
const M10 = (col) => `right(regexp_replace(${col}, '\\D', '', 'g'), 10)`;

/* One look for every QuizPe email: the brand bar, the words, a quiet footer. */
function layout({ title, body, footer }) {
  const html = `<div style="background:#f3f7f6;padding:24px 12px;font-family:Segoe UI,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3ecea;">
      <div style="background:#075e54;color:#fff;padding:16px 22px;font-weight:800;font-size:18px;">QuizPe</div>
      <div style="padding:22px;color:#10302b;font-size:15px;line-height:1.6;">
        <h1 style="font-size:20px;margin:0 0 12px;">${esc(title)}</h1>${body}
      </div>
      <div style="padding:14px 22px;border-top:1px solid #eef3f2;color:#6b8380;font-size:12px;line-height:1.5;">${footer}</div>
    </div></div>`;
  return html;
}

async function sendCode(mobile, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase().slice(0, 120);
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'Please enter a valid email address.' };
  const recent = (await db.query(
    `SELECT count(*)::int AS n FROM parent_email_codes WHERE ${M10('mobile_number')} = ${M10('$1')} AND created_at > now() - interval '1 hour'`,
    [mobile])).rows[0].n;
  if (recent >= 5) return { ok: false, status: 429, error: 'Too many codes in the last hour. Please try again a little later.' };
  const code = String(crypto.randomInt(1000, 10000));
  await db.query(
    `INSERT INTO parent_email_codes (mobile_number, email, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [mobile, email, hash(code)]);
  const html = layout({
    title: `${code} is your QuizPe email code`,
    body: `<p>Type this code in your QuizPe WhatsApp chat to confirm your email address. It works for 10 minutes.</p>
           <div style="font-size:32px;font-weight:900;letter-spacing:8px;color:#075e54;margin:14px 0;">${code}</div>
           <p style="color:#4d6a65;">Your child's reports and your invoices will also come to this address as PDFs.</p>`,
    footer: 'You are receiving this because this address was entered in QuizPe on WhatsApp. If it was not you, ignore this email.',
  });
  const out = await sendParentMail({ to: email, subject: `${code} is your QuizPe email code`, html });
  if (!out.sent) return { ok: false, status: 502, error: 'We could not send the code just now. Please try again in a minute.' };
  return { ok: true, sent_to: email };
}

async function verifyCode(mobile, rawEmail, rawCode) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const row = (await db.query(
    `SELECT * FROM parent_email_codes
      WHERE ${M10('mobile_number')} = ${M10('$1')} AND email = $2 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY id DESC LIMIT 1`, [mobile, email])).rows[0];
  if (!row) return { ok: false, error: 'code_expired', message: 'That code has expired. Please ask for a new one.' };
  if (row.attempts >= 5) return { ok: false, error: 'too_many', message: 'Too many wrong codes. Please ask for a new one.' };
  if (hash(String(rawCode || '').replace(/\D/g, '')) !== row.code_hash) {
    await db.query(`UPDATE parent_email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, error: 'wrong_code', message: `That code is not right. ${Math.max(0, 4 - row.attempts)} tries left.` };
  }
  await db.query(`UPDATE parent_email_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
  await db.query(
    `UPDATE parents SET email = $2, email_verified_at = now(), email_unsubscribed_at = NULL,
            email_token = coalesce(email_token, $3), modified_at = now()
      WHERE ${M10('parent_mobile_number')} = ${M10('$1')}`, [mobile, email, crypto.randomBytes(24).toString('hex')]);
  return { ok: true, email };
}

/* ─────────────────────────────── unsubscribe ─────────────────────────────── */

const unsubscribeRouter = express.Router();
const page = (res, title, body, status = 200) => res.status(status).send(`<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · QuizPe</title></head>
  <body style="margin:0;background:#f3f7f6;font-family:Segoe UI,Arial,sans-serif;">${layout({ title, body, footer: 'QuizPe · ServerPe App Solutions · support@quizpe.in' })}</body></html>`);
const who = async (token) => (/^[a-f0-9]{48}$/.test(String(token || ''))
  ? (await db.query(`SELECT id, email, email_unsubscribed_at FROM parents WHERE email_token = $1`, [token])).rows[0] : null);

unsubscribeRouter.get('/unsubscribe/:token', async (req, res) => {
  const p = await who(req.params.token).catch(() => null);
  if (!p) return page(res, 'This link is no longer valid', '<p>It may be from an older email.</p>', 404);
  if (p.email_unsubscribed_at) return page(res, 'You are unsubscribed', `<p>QuizPe sends no more updates or offers to <b>${esc(p.email)}</b>. Your child's reports and quiz reminders are not affected.</p>`);
  return page(res, 'Stop QuizPe update emails?', `<p>QuizPe will stop sending updates and offers to <b>${esc(p.email)}</b>. Your child's reports and quiz reminders are not affected.</p>
    <form method="post"><button style="background:#075e54;color:#fff;border:0;border-radius:10px;padding:11px 20px;font-weight:700;font-size:14px;cursor:pointer;">Unsubscribe</button></form>`);
});
unsubscribeRouter.post('/unsubscribe/:token', async (req, res) => {
  const p = await who(req.params.token).catch(() => null);
  if (!p) return page(res, 'This link is no longer valid', '<p>It may be from an older email.</p>', 404);
  await db.query(`UPDATE parents SET email_unsubscribed_at = coalesce(email_unsubscribed_at, now()), modified_at = now() WHERE id = $1`, [p.id]);
  return page(res, 'You are unsubscribed', `<p>Done — no more update emails to <b>${esc(p.email)}</b>.</p>`);
});

/* ─────────────────────────────── the broadcast ─────────────────────────────── */

/*
 * WHO A BROADCAST GOES TO: families who agreed (admin/hq/agreed.js), active, not paused, with a CONFIRMED
 * email they have not unsubscribed. audience: all | paying | trial | lapsed. A promotion (category
 * 'promotion') goes the same way — every email carries the unsubscribe link.
 */
function audienceSql(audience) {
  const agreed = require('../admin/hq/agreed').sql('p.parent_mobile_number');
  const plan = {
    paying: `EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
                      WHERE s.parent_id = p.id AND s.is_active AND NOT pl.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)`,
    trial: `EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
                     WHERE s.parent_id = p.id AND s.is_active AND pl.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)`,
    lapsed: `NOT EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s WHERE s.parent_id = p.id AND s.is_active
                          AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)`,
  }[audience] || 'true';
  return `p.is_active AND NOT coalesce(p.service_paused, false) AND p.deactivated_at IS NULL
          AND p.email IS NOT NULL AND p.email_verified_at IS NOT NULL AND p.email_unsubscribed_at IS NULL
          AND ${agreed} AND ${plan}`;
}

const AUDIENCES = { all: 'Every family with a confirmed email', paying: 'On a paid plan now', trial: 'On a free trial now', lapsed: 'Plan or trial ended' };

async function audienceCounts() {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE ${audienceSql('all')})::int AS all,
            count(*) FILTER (WHERE ${audienceSql('paying')})::int AS paying,
            count(*) FILTER (WHERE ${audienceSql('trial')})::int AS trial,
            count(*) FILTER (WHERE ${audienceSql('lapsed')})::int AS lapsed,
            count(*) FILTER (WHERE p.email IS NOT NULL AND p.email_verified_at IS NULL)::int AS not_confirmed,
            count(*) FILTER (WHERE p.email_unsubscribed_at IS NOT NULL)::int AS unsubscribed
       FROM parents p`);
  return { counts: r, audiences: AUDIENCES };
}

/** Plain text in, a safe email out: blank lines make paragraphs, web addresses become links, {name} the first name. */
function render({ subject, body }, parent) {
  const first = String(parent.parent_name || '').trim().split(/\s+/)[0] || 'there';
  const paras = String(body).replace(/\{name\}/g, first).split(/\n\s*\n/).map((p) =>
    `<p>${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#075e54;font-weight:700;">$1</a>')}</p>`).join('');
  const unsub = parent.email_token ? `${BASE()}/email/unsubscribe/${parent.email_token}` : null;
  const html = layout({
    title: subject.replace(/\{name\}/g, first), body: paras,
    footer: `You are receiving this because you use QuizPe (quizpe.in/app) and confirmed this email.${unsub ? ` <a href="${esc(unsub)}" style="color:#6b8380;">Unsubscribe</a>` : ''}`,
  });
  return { subject: subject.replace(/\{name\}/g, first), html, unsub };
}

/** Queue a broadcast: one pending row per family in the audience. test=true sends only to the admin mailbox. */
async function queueCampaign({ adminMobile, category = 'service', audience = 'all', subject, body, test = false }) {
  subject = String(subject || '').trim().slice(0, 150);
  body = String(body || '').trim().slice(0, 8000);
  if (subject.length < 3 || body.length < 10) return { ok: false, error: 'Write a subject and a message first.' };
  if (test) {
    const { ADMIN_TO } = require('../mail/mailer');
    const sample = render({ subject: `[TEST] ${subject}`, body }, { parent_name: 'Parent', email_token: null });
    const out = await sendParentMail({ to: ADMIN_TO, subject: sample.subject, html: sample.html });
    return out.sent ? { ok: true, test: true, sent_to: ADMIN_TO } : { ok: false, error: `Test not sent: ${out.reason}` };
  }
  const { rows: [c] } = await db.query(
    `INSERT INTO hq_email_campaigns (admin_mobile, category, audience, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [adminMobile || null, category === 'promotion' ? 'promotion' : 'service', AUDIENCES[audience] ? audience : 'all', subject, body]);
  const q = await db.query(
    `INSERT INTO hq_email_sends (campaign_id, parent_id, email)
     SELECT $1, p.id, p.email FROM parents p WHERE ${audienceSql(audience)}
     ON CONFLICT (campaign_id, parent_id) DO NOTHING`, [c.id]);
  return { ok: true, campaign_id: String(c.id), queued: q.rowCount };
}

let sending = false;
/** A few emails each pass; a failed one is tried again later, up to 3 times. */
async function runSends(perPass = 8) {
  if (sending) return 0;
  sending = true;
  let sent = 0;
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.email AS to_email, c.subject, c.body, p.parent_name, p.email, p.email_token, p.email_unsubscribed_at, p.email_verified_at
         FROM hq_email_sends s JOIN hq_email_campaigns c ON c.id = s.campaign_id JOIN parents p ON p.id = s.parent_id
        WHERE s.status IN ('pending', 'failed') AND s.attempts < 3 AND c.status = 'queued'
        ORDER BY s.id LIMIT $1`, [perPass]);
    for (const r of rows) {
      await db.query(`UPDATE hq_email_sends SET attempts = attempts + 1 WHERE id = $1`, [r.id]);
      // Unsubscribed or changed since it was queued: not sent.
      if (r.email_unsubscribed_at || !r.email_verified_at || String(r.email).toLowerCase() !== String(r.to_email).toLowerCase()) {
        await db.query(`UPDATE hq_email_sends SET status = 'skipped', error = 'no longer subscribed' WHERE id = $1`, [r.id]);
        continue;
      }
      const m = render({ subject: r.subject, body: r.body }, r);
      const out = await sendParentMail({ to: r.to_email, subject: m.subject, html: m.html });
      await db.query(`UPDATE hq_email_sends SET status = $2::varchar, error = $3, sent_at = CASE WHEN $2::varchar = 'sent' THEN now() END WHERE id = $1`,
        [r.id, out.sent ? 'sent' : 'failed', out.sent ? null : String(out.reason || '').slice(0, 300)]);
      if (out.sent) sent += 1;
    }
    // A campaign with nothing left to send is finished.
    await db.query(
      `UPDATE hq_email_campaigns c SET status = 'sent', finished_at = now()
        WHERE c.status = 'queued' AND NOT EXISTS (SELECT 1 FROM hq_email_sends s WHERE s.campaign_id = c.id AND s.status IN ('pending', 'failed') AND s.attempts < 3)`);
  } catch (e) {
    console.error('[email-broadcast]', e.message);
  } finally {
    sending = false;
  }
  if (sent) console.log(`[email-broadcast] sent ${sent}`);
  return sent;
}

async function campaigns() {
  const { rows } = await db.query(
    `SELECT c.id::text, c.category, c.audience, c.subject, c.status, c.created_at, c.finished_at,
            count(s.id)::int AS total, count(s.id) FILTER (WHERE s.status = 'sent')::int AS sent,
            count(s.id) FILTER (WHERE s.status = 'failed')::int AS failed, count(s.id) FILTER (WHERE s.status = 'skipped')::int AS skipped
       FROM hq_email_campaigns c LEFT JOIN hq_email_sends s ON s.campaign_id = c.id
      GROUP BY c.id ORDER BY c.id DESC LIMIT 50`);
  return rows;
}

function start(everySeconds = 60) {
  setInterval(() => runSends().catch(() => {}), everySeconds * 1000);
  console.log(`  email broadcast: every ${everySeconds}s`);
}

module.exports = { sendCode, verifyCode, unsubscribeRouter, queueCampaign, runSends, campaigns, audienceCounts, start, AUDIENCES, EMAIL_RE };
