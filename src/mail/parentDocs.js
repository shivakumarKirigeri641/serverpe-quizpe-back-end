/**
 * src/mail/parentDocs.js — INVOICES AND REPORTS ALSO BY EMAIL (user, 2026-10-29: "if WhatsApp is disabled, invoice &
 * report will mail them"). Every PDF that goes to a parent on WhatsApp — a tax invoice, a quiz report, the weekly
 * report — is also emailed, as an attachment, to the parent's CONFIRMED address (parents.email_verified_at, set by
 * the code in web/email.js — on WhatsApp via menu → "📧 My email"). An address that was typed but never confirmed
 * gets nothing. These are the parent's own documents, not updates, so the broadcast "unsubscribe" does not stop them.
 *
 *   mailDoc(mobile, { subject, title, lines, filePath, filename })   never throws, never awaited by the caller's flow
 */

const fs = require('fs');
const db = require('../database/connectDB');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function mailDoc(mobile, { subject, title, lines = [], filePath, filename }) {
  try {
    const m10 = String(mobile || '').replace(/\D/g, '').slice(-10);
    if (m10.length !== 10 || !filePath || !fs.existsSync(filePath)) return false;
    const p = (await db.query(
      `SELECT parent_name, email FROM parents
        WHERE right(regexp_replace(parent_mobile_number, '\\D', '', 'g'), 10) = $1
          AND email IS NOT NULL AND email_verified_at IS NOT NULL LIMIT 1`, [m10])).rows[0];
    if (!p) return false;
    const first = String(p.parent_name || '').trim().split(/\s+/)[0];
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#10302b;font-size:15px;line-height:1.6">
      <div style="background:#075e54;color:#fff;padding:14px 20px;font-weight:800;font-size:18px;border-radius:12px 12px 0 0">QuizPe</div>
      <div style="border:1px solid #e3ecea;border-top:0;border-radius:0 0 12px 12px;padding:20px">
        <p>Hi ${esc(first && first !== 'Parent' ? first : 'there')},</p>
        <h2 style="font-size:18px;margin:6px 0 10px">${esc(title || subject)}</h2>
        ${lines.filter(Boolean).map((l) => `<p style="margin:4px 0">${esc(l)}</p>`).join('')}
        <p style="margin-top:14px">The PDF is attached. Everything else — quizzes, your MCQ balance and recharges — is on WhatsApp:
          <a href="https://wa.me/918317319463" style="color:#075e54;font-weight:700">+91 83173 19463</a>.</p>
        <p style="font-size:12px;color:#6b8380;margin-top:16px">You get this because you confirmed this email in QuizPe. QuizPe · ServerPe App Solutions</p>
      </div></div>`;
    const out = await require('./mailer').sendParentMail({
      to: p.email, subject, html, attachments: [{ filename: filename || 'QuizPe.pdf', path: filePath }],
    });
    if (!out.sent) console.error(`[parent-docs] ${subject} not mailed: ${out.reason}`);
    return out.sent;
  } catch (e) {
    console.error('[parent-docs] skipped:', e.message);
    return false;
  }
}

module.exports = { mailDoc };
