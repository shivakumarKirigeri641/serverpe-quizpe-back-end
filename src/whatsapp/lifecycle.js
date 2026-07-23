/**
 * src/whatsapp/lifecycle.js
 * ---------------------------------------------------------------------------
 * The three subscription-lifecycle templates:
 *
 *   qp_renewalorwelcome_v1   parent enrolled — trial or paid
 *   qp_enrollmentexpiring_v1 plan is about to run out
 *   qp_enrollmentexpired_v1  plan has run out
 *
 * Why templates rather than plain messages: WhatsApp only allows free-form
 * text within 24 hours of the parent's last message. An expiry reminder is by
 * definition sent to someone who has not been in touch, so it MUST be a
 * template or it will simply not arrive.
 *
 * Every send here goes through sendTemplateIfApproved, which refuses to send a
 * template Meta has not yet approved. All three are PENDING today, so nothing
 * goes out until they clear — and then they start working with no deploy.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const wa = require('./client');

const TEMPLATES = {
  enrolment: 'qp_renewalorwelcome_v1',
  expiring: 'qp_enrollmentexpiring_v1',
  expired: 'qp_enrollmentexpired_v1',
};

/** A template is only usable once Meta has approved it. */
async function approved(name) {
  const { rows } = await db.query(
    `SELECT template_name FROM whatsapp_templates
      WHERE template_name = $1 AND is_active AND approval_status = 'APPROVED'`, [name]);
  return rows.length > 0;
}

/**
 * Sends a template, or does nothing if it is not approved yet.
 * Never throws: a notification must not be able to fail an enrolment.
 */
async function sendTemplateIfApproved(sessionId, mobile, name, params) {
  try {
    if (!(await approved(name))) return { sent: false, reason: 'not_approved' };
    await wa.sendTemplate(sessionId, mobile, name, params);
    return { sent: true };
  } catch (e) {
    console.error(`[lifecycle] ${name} failed:`, e.message);
    return { sent: false, reason: e.message };
  }
}

/* ------------------------------------------------------------ date phrasing */
/** 1 -> 1st, 2 -> 2nd, 3 -> 3rd, 11..13 -> th, 21 -> 21st */
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Turns an expiry date into the phrase the template expects:
 * "today", "tomorrow", or "on 28th August".
 *
 * Compared as LOCAL calendar dates. Using timestamps would make a plan ending
 * at local midnight read as "today" for anyone west of IST, and a reminder
 * that says the wrong day is worse than no reminder.
 */
function expiryPhrase(endDate, today = new Date()) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = midnight(new Date(endDate));
  const now = midnight(today);
  const days = Math.round((end - now) / 86400000);

  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  const month = end.toLocaleString('en-IN', { month: 'long' });
  return `on ${ordinal(end.getDate())} ${month}`;
}

/** Whole days from today until the plan ends. Negative once it has passed. */
function daysUntil(endDate, today = new Date()) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((midnight(new Date(endDate)) - midnight(today)) / 86400000);
}

/* ------------------------------------------------------------- 1. enrolment */
/**
 * Welcome / renewal confirmation.
 *
 * @param students one or more child names. A three-child plan cannot put three
 *        names into a single-name parameter, so they are joined — the template
 *        says "your child's name", and "Aarav, Riya and Dev" reads correctly
 *        there where "Aarav" alone would look like the others were forgotten.
 */
async function sendEnrolment({ sessionId, mobile, parentName, students, planName }) {
  const names = (Array.isArray(students) ? students : [students]).filter(Boolean).map(String);
  const studentText = names.length <= 1
    ? (names[0] || 'your child')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  return sendTemplateIfApproved(sessionId, mobile, TEMPLATES.enrolment,
    [String(parentName || 'there'), studentText, String(planName || 'QuizPe')]);
}

/* -------------------------------------------------------------- 2. expiring */
async function sendExpiring({ sessionId, mobile, parentName, planName, endDate }) {
  return sendTemplateIfApproved(sessionId, mobile, TEMPLATES.expiring,
    [String(parentName || 'there'), String(planName || 'your plan'), expiryPhrase(endDate)]);
}

/* --------------------------------------------------------------- 3. expired */
async function sendExpired({ sessionId, mobile, parentName, planName }) {
  return sendTemplateIfApproved(sessionId, mobile, TEMPLATES.expired,
    [String(parentName || 'there'), String(planName || 'your plan')]);
}

module.exports = {
  TEMPLATES, approved, sendTemplateIfApproved,
  expiryPhrase, daysUntil, ordinal,
  sendEnrolment, sendExpiring, sendExpired,
};
