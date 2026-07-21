/**
 * src/routers/legalRouter.js
 * ---------------------------------------------------------------------------
 * Policies, served two ways:
 *
 *   PUBLIC  (no auth)  GET /legal            list of documents
 *                      GET /legal/:code      one document with its sections
 *                      GET /legal.html?doc=  a readable page for parents
 *
 *   ADMIN   (bearer)   mounted under /admin/api by adminRouter — full CRUD
 *
 * Public on purpose: a privacy policy nobody can read is not a privacy policy,
 * and WhatsApp links to these before anyone has an account. They contain only
 * business details that already appear on invoices — never customer data.
 *
 * Placeholders such as {{company_name}} are filled from business_details at
 * READ time, so the policies can never contradict the invoice, and changing
 * the business row updates every document at once.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

/** Values available to {{placeholders}} in policy text. */
async function tokens() {
  const b = (await db.query(
    `SELECT company_name, company_tagline, product_name, product_tagline, proprietor_name,
            gstin, pan, address, support_email, product_support_email, product_website,
            grievance_officer_name, grievance_officer_designation,
            grievance_officer_email, grievance_officer_phone,
            grievance_response_hours, grievance_resolution_days
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};
  return b;
}

/** Replace {{key}} with the business value; leave unknown keys visible. */
function fill(text, t) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    (t[key] === null || t[key] === undefined || t[key] === '') ? whole : String(t[key]));
}

async function loadDoc(code) {
  const doc = (await db.query(
    `SELECT id, doc_code, title, version, summary, effective_from, requires_consent
       FROM legal_documents WHERE doc_code = $1 AND is_active`, [code])).rows[0];
  if (!doc) return null;
  const { rows: sections } = await db.query(
    `SELECT section_no, title, description FROM legal_sections
      WHERE document_id = $1 AND is_active ORDER BY display_order, id`, [doc.id]);
  const t = await tokens();
  return {
    ...doc,
    summary: fill(doc.summary, t),
    sections: sections.map((s) => ({ ...s, title: fill(s.title, t), description: fill(s.description, t) })),
  };
}

/* ------------------------------------------------------------------ public */
router.get('/', async (req, res) => {
  try {
    const t = await tokens();
    const { rows } = await db.query(
      `SELECT doc_code, title, summary, version, effective_from, requires_consent
         FROM legal_documents WHERE is_active ORDER BY display_order, id`);
    ok(res, {
      documents: rows.map((d) => ({ ...d, summary: fill(d.summary, t) })),
      business: {
        company_name: t.company_name, product_name: t.product_name,
        address: t.address, gstin: t.gstin,
        // what a PARENT should use; the company address is the grievance one
        support_email: t.product_support_email || t.support_email,
        company_email: t.support_email,
      },
      grievance_officer: {
        name: t.grievance_officer_name, designation: t.grievance_officer_designation,
        email: t.grievance_officer_email, phone: t.grievance_officer_phone,
        acknowledge_hours: t.grievance_response_hours,
        resolve_days: t.grievance_resolution_days,
      },
    });
  } catch (e) { console.error('[legal] list:', e.message); fail(res, 500, 'Could not load policies.'); }
});

router.get('/:code', async (req, res) => {
  try {
    const doc = await loadDoc(req.params.code);
    if (!doc) return fail(res, 404, 'No such policy.');
    ok(res, { document: doc });
  } catch (e) { console.error('[legal] read:', e.message); fail(res, 500, 'Could not load the policy.'); }
});

module.exports = router;
module.exports.loadDoc = loadDoc;
module.exports.tokens = tokens;
module.exports.fill = fill;
