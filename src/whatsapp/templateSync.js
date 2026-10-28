/**
 * src/whatsapp/templateSync.js — THE TEMPLATES OF THE NEW NUMBER, AND ONLY THOSE (user, 2026-10-28: "did you handle
 * template pending vs approved? older ones disabled and stop sending them?").
 * ---------------------------------------------------------------------------
 * whatsapp_templates still held the OLD account's templates marked APPROVED. At start-up and every 30 minutes this
 * reads the new account's templates from Meta (GET only — WHATSAPP_WABAID) and:
 *   on the new account   status as Meta says (APPROVED / PENDING / REJECTED / PAUSED …), active, wording saved
 *   not on it            approval_status 'NOT_ON_NUMBER', is_active false — an old template, never sent
 * client.send() asks canSend(name) before ANY template: only one APPROVED on the new account goes, whatever
 * WHATSAPP_MODE says. If Meta cannot be read, nothing is approved — templates wait rather than guess.
 * ---------------------------------------------------------------------------
 */
const db = require('../database/connectDB');

let approved = new Set();
let syncedAt = 0;

async function sync() {
  const waba = String(process.env.WHATSAPP_WABAID || '').trim();
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!waba || !token) return { ok: false, error: 'WHATSAPP_WABAID or the token is not set' };
  const v = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const list = [];
  let next = `https://graph.facebook.com/${v}/${waba}/message_templates?fields=name,status,category,language,components&limit=200`;
  for (let i = 0; next && i < 10; i += 1) {
    const r = await fetch(next, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (j.error) return { ok: false, error: j.error.message };
    list.push(...(j.data || []));
    next = j.paging?.next || null;
  }
  const part = (t, type) => (t.components || []).find((c) => c.type === type);
  for (const t of list) {
    const buttons = part(t, 'BUTTONS')?.buttons || null;
    await db.query(
      `INSERT INTO whatsapp_templates (template_name, language, category, approval_status, body_text, header_text, footer_text, buttons, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (template_name) DO UPDATE SET
         language = EXCLUDED.language, category = EXCLUDED.category, approval_status = EXCLUDED.approval_status,
         body_text = EXCLUDED.body_text, header_text = EXCLUDED.header_text, footer_text = EXCLUDED.footer_text,
         buttons = EXCLUDED.buttons, is_active = true, modified_at = now()`,
      [t.name, t.language || 'en', String(t.category || '').toUpperCase(), String(t.status || '').toUpperCase(),
       part(t, 'BODY')?.text || '', part(t, 'HEADER')?.text || null, part(t, 'FOOTER')?.text || null,
       buttons ? JSON.stringify(buttons) : null]);
  }
  const names = list.map((t) => t.name);
  // Everything else is an old template (the banned account's): kept for the record, never sent.
  const off = await db.query(
    `UPDATE whatsapp_templates SET approval_status = 'NOT_ON_NUMBER', is_active = false, modified_at = now()
      WHERE NOT (template_name = ANY($1::text[])) AND (approval_status <> 'NOT_ON_NUMBER' OR is_active)`, [names]);
  approved = new Set(list.filter((t) => String(t.status).toUpperCase() === 'APPROVED').map((t) => t.name));
  syncedAt = Date.now();
  const out = { ok: true, total: list.length, approved: [...approved], pending: list.filter((t) => String(t.status).toUpperCase() === 'PENDING').map((t) => t.name), disabled: off.rowCount };
  console.log(`[templates] new number: ${out.total} template(s) — approved: ${out.approved.join(', ') || 'none'}; pending: ${out.pending.join(', ') || 'none'}; ${out.disabled} old one(s) disabled`);
  return out;
}

/** May this template be sent? Only when Meta's new account has it APPROVED (as of the last sync). */
const canSend = (name) => approved.has(String(name || ''));

function start() {
  const run = () => sync().catch((e) => console.error('[templates] sync failed:', e.message));
  setTimeout(run, 5000).unref?.();
  setInterval(run, 30 * 60 * 1000).unref?.();
}

module.exports = { sync, canSend, start, status: () => ({ approved: [...approved], syncedAt }) };
