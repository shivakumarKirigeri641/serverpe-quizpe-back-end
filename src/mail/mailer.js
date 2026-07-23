/**
 * src/mail/mailer.js
 * ---------------------------------------------------------------------------
 * Outbound email over the business SMTP (Hostinger), used for operator alerts:
 * a parent enrols, pays, leaves feedback, or raises a support request.
 *
 * Sent FROM noreply@ and TO admin@ — the founder's inbox. These are internal
 * notifications, never marketing, and they carry customer data, so they go to
 * exactly one recipient and nowhere else.
 *
 * Nothing here may ever break the flow that triggered it. A parent who has
 * paid must get their subscription whether or not the alert email leaves the
 * building, so every send is fire-and-forget through the job queue, and a
 * failure is logged and retried rather than thrown at the caller.
 * ---------------------------------------------------------------------------
 */

const nodemailer = require('nodemailer');

const HOST = process.env.MAIL_HOST;
const PORT = Number(process.env.MAIL_PORT) || 465;
const SECURE = String(process.env.MAIL_SECURE || 'true') === 'true';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'QuizPe';

// noreply sends; admin receives. Falling back to admin as sender keeps alerts
// working if only the one mailbox is configured.
const SEND_USER = process.env.NOREPLYMAIL || process.env.ADMINMAIL;
const SEND_PASS = process.env.NOREPLYMAIL_PASSWORD || process.env.ADMINMAIL_PASSWORD;
const ADMIN_TO = process.env.ADMINMAIL;

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  if (!HOST || !SEND_USER || !SEND_PASS) return null;
  transporter = nodemailer.createTransport({
    host: HOST, port: PORT, secure: SECURE,
    auth: { user: SEND_USER, pass: SEND_PASS },
    // a hung SMTP connection must not hold a request open
    connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
  });
  return transporter;
}

/** True when SMTP is configured well enough to send. */
const isConfigured = () => Boolean(HOST && SEND_USER && SEND_PASS && ADMIN_TO);

/**
 * Send an operator alert to the admin mailbox.
 * Resolves with {sent:false, reason} rather than throwing — callers are in the
 * middle of enrolment or payment and must not fail because email did.
 */
async function sendAdminMail({ subject, html, text }) {
  if (!isConfigured()) {
    console.warn('[mail] SMTP not configured — alert skipped:', subject);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const info = await getTransport().sendMail({
      from: `"${FROM_NAME}" <${SEND_USER}>`,
      to: ADMIN_TO,
      subject,
      text: text || String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      html,
    });
    console.log(`[mail] sent "${subject}" -> ${ADMIN_TO} (${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

/** Verify SMTP credentials without sending anything. */
async function verify() {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  try { await getTransport().verify(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { sendAdminMail, verify, isConfigured, ADMIN_TO, SEND_USER };
