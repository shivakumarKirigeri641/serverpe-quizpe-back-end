/**
 * src/admin/hq/agreed.js — THE ADMIN SHOWS ONLY FAMILIES WHO AGREED (user, 2026-10-21: "change the QuizPe
 * admin like GaadiPe's web admin, taking count of earlier customers who all agreed only — we are no more
 * with WhatsApp"), as GaadiPe's admin/consented.js does.
 *
 * A family counts once they agreed to QuizPe's terms:
 *   on WhatsApp, before it closed   a row in policy_consents (the "Agree" step of the WhatsApp sign-up)
 *   on the website                  a sign-in on quizpe.in/app (parent_web_sessions; each records the terms)
 * and never someone who replied STOP on WhatsApp (whatsapp_sessions.opted_out) — unless they signed in on
 * the website afterwards: they chose QuizPe again there. Someone who only said Hi is never shown.
 *
 *   sql(col)      an SQL condition: the mobile in `col` (any format) belongs to a family who agreed
 *   filter(body)  an admin API answer with everyone else taken out: a list row whose own mobile is not
 *                 allowed is removed; that number anywhere else is blanked (null) and marked hidden
 *   channelSql(col) 'web' | 'whatsapp' | 'both' — where the family agreed
 * The admin's own numbers (ADMIN_MOBILES) always show. Nothing is deleted — payments and invoices stay
 * in the database as legal records; they are only not shown.
 */

const db = require('../../database/connectDB');

const M10 = (col) => `right(regexp_replace(${col}, '\\D', '', 'g'), 10)`;
const OWNER = require('./notMe').OWNER;

const viaWhatsApp = (m) => `EXISTS (SELECT 1 FROM policy_consents ac WHERE ac.is_active AND ${M10('ac.mobile_number')} = ${m})`;
const viaWeb = (m) => `EXISTS (SELECT 1 FROM parent_web_sessions aw WHERE ${M10('aw.mobile_number')} = ${m})`;
const stopped = (m) => `EXISTS (SELECT 1 FROM whatsapp_sessions so WHERE so.opted_out AND ${M10('so.mobile_number')} = ${m})`;

/** SQL: the mobile in `col` belongs to a family who agreed (and did not STOP, unless they came back on the web). */
const sql = (col) => {
  const m = M10(col);
  return `((${viaWhatsApp(m)} AND NOT ${stopped(m)}) OR ${viaWeb(m)})`;
};

/** SQL: where the family agreed — 'both', 'web' or 'whatsapp'. */
const channelSql = (col) => {
  const m = M10(col);
  return `(CASE WHEN ${viaWeb(m)} AND ${viaWhatsApp(m)} THEN 'both' WHEN ${viaWeb(m)} THEN 'web' ELSE 'whatsapp' END)`;
};

const KEYS = ['mobile', 'mobile_number', 'parent_mobile_number', 'parent_mobile', 'phone'];
const ten = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 ? d.slice(-10) : null;
};
const plain = (v) => v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v);

function collect(node, out, depth = 0) {
  if (!plain(node) || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) collect(x, out, depth + 1); return; }
  for (const [k, v] of Object.entries(node)) {
    if (KEYS.includes(k)) { const m = ten(v); if (m) out.add(m); } else if (plain(v)) collect(v, out, depth + 1);
  }
}

/** Of these 10-digit mobiles, the ones that may be shown. */
async function allowedOf(mobiles) {
  if (!mobiles.length) return new Set();
  const { rows } = await db.query(
    `SELECT m FROM unnest($1::text[]) AS m WHERE ${sql('m')} OR m = ANY($2::text[])`, [mobiles, OWNER]);
  return new Set(rows.map((r) => r.m));
}

const rowMobile = (x) => KEYS.map((k) => ten(x[k])).find(Boolean) || null;
function strip(node, allowed, depth = 0) {
  if (!plain(node) || depth > 8) return node;
  if (Array.isArray(node)) {
    return node
      .filter((x) => !(plain(x) && !Array.isArray(x) && rowMobile(x) && !allowed.has(rowMobile(x))))
      .map((x) => strip(x, allowed, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (KEYS.includes(k) && ten(v) && !allowed.has(ten(v))) { out[k] = null; out.hidden = true; } else out[k] = plain(v) ? strip(v, allowed, depth + 1) : v;
  }
  return out;
}

/** The answer with everyone who did not agree (or said STOP) taken out. */
async function filter(body) {
  const found = new Set();
  collect(body, found);
  if (!found.size) return body;
  const allowed = await allowedOf([...found]);
  if (allowed.size === found.size) return body;
  return strip(body, allowed);
}

module.exports = { sql, channelSql, filter, allowedOf, M10 };
