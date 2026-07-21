/**
 * src/admin/mobileChange.js
 * ---------------------------------------------------------------------------
 * Change a parent's mobile number, re-linking every table that stores it.
 *
 * The number is this product's identity: WhatsApp sessions, message history,
 * consents, OTPs, notification logs and every pending link key off it. Simply
 * editing `parents.parent_mobile_number` would leave all of that pointing at a
 * number nobody owns — the parent would stop receiving quizzes and their
 * consent record would no longer be attributable. So the change is done as one
 * transaction across every operational table.
 *
 * TWO TABLES ARE DELIBERATELY NOT TOUCHED:
 *   gstr1_filing.customer_mobile — a filed GST record must keep the number as
 *                                 it was at the time of sale
 *   payments.contact            — what Razorpay actually received
 * Rewriting either would falsify a financial record.
 *
 * WHATSAPP DISPLAY NAME: Meta's Cloud API has no "look up the profile name for
 * this number" endpoint. The name only arrives in the webhook when the person
 * messages you (contacts[0].profile.name). So the name cannot be fetched on
 * demand — it is captured automatically the next time that number writes in.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

/** Operational tables keyed by the parent's number, safe to re-link. */
const RELINK = [
  ['whatsapp_sessions', 'mobile_number'],
  ['whatsapp_messages', 'mobile_number'],
  ['notification_log', 'mobile_number'],
  ['policy_consents', 'mobile_number'],
  ['otps', 'mobile_number'],
  ['report_sessions', 'mobile_number'],
  ['signup_links', 'mobile_number'],
  ['checkout_sessions', 'mobile_number'],
  ['quiz_links', 'mobile_number'],
  ['feedback_links', 'mobile_number'],
  ['feedbacks', 'mobile_number'],
  ['support_links', 'mobile_number'],
  ['support_tickets', 'mobile_number'],
];

const norm = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/**
 * @returns {Promise<{error?:string, moved?:object, from?:string, to?:string}>}
 */
async function changeMobile(parentId, rawNew, confirm) {
  const to = norm(rawNew);
  if (to.length !== 10) return { error: 'Enter a valid 10-digit mobile number.' };
  if (!/^[6-9]/.test(to)) return { error: 'Indian mobile numbers start with 6, 7, 8 or 9.' };

  const parent = (await db.query(
    'SELECT id, parent_name, parent_mobile_number FROM parents WHERE id = $1', [parentId])).rows[0];
  if (!parent) return { error: 'Parent not found.' };

  const from = parent.parent_mobile_number;
  if (from === to) return { error: 'That is already the number on file.' };
  if (norm(confirm) !== to) return { error: 'Type the new number again to confirm.' };

  const taken = (await db.query(
    'SELECT id, parent_name FROM parents WHERE parent_mobile_number = $1 AND id <> $2', [to, parentId])).rows[0];
  if (taken) {
    return { error: `${to} already belongs to another parent (${taken.parent_name || 'unnamed'}). Numbers must be unique.` };
  }

  const c = await db.getClient();
  const moved = {};
  try {
    await c.query('BEGIN');

    // A session may already exist for the NEW number (they messaged us before).
    // Two active sessions for one number would violate uq_wa_session_active, so
    // retire the old one rather than moving it on top.
    const existingSession = (await c.query(
      'SELECT id FROM whatsapp_sessions WHERE mobile_number = $1 AND is_active', [to])).rows[0];
    if (existingSession) {
      const r = await c.query(
        `UPDATE whatsapp_sessions SET is_active = false, modified_at = now()
          WHERE mobile_number = $1 AND is_active`, [from]);
      moved['whatsapp_sessions (old retired)'] = r.rowCount;
    }

    for (const [table, col] of RELINK) {
      // skip the session table when we already retired the old one above
      if (table === 'whatsapp_sessions' && existingSession) continue;
      const r = await c.query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [to, from]);
      if (r.rowCount) moved[table] = r.rowCount;
    }

    await c.query(
      `UPDATE parents SET parent_mobile_number = $1, modified_at = now() WHERE id = $2`, [to, parentId]);
    moved.parents = 1;

    await c.query('COMMIT');
    console.log(`[admin] parent ${parentId} moved ${from} -> ${to}:`, moved);
    return { from, to, moved, parent_name: parent.parent_name };
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('[admin] mobile change failed:', e.message);
    return { error: e.message };
  } finally {
    c.release();
  }
}

/** What a change would touch — shown before the admin commits. */
async function previewMobileChange(parentId) {
  const parent = (await db.query(
    'SELECT parent_mobile_number FROM parents WHERE id = $1', [parentId])).rows[0];
  if (!parent) return null;
  const from = parent.parent_mobile_number;

  const counts = {};
  for (const [table, col] of RELINK) {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = $1`, [from]);
    if (r.n) counts[table] = r.n;
  }
  const { rows: [gst] } = await db.query(
    `SELECT COUNT(*)::int n FROM gstr1_filing WHERE customer_mobile LIKE '%' || $1`, [from]);

  return { from, counts, frozen: { gstr1_filing: gst.n } };
}

module.exports = { changeMobile, previewMobileChange };
