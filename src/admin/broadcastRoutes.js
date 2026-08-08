/**
 * src/admin/broadcastRoutes.js
 * ---------------------------------------------------------------------------
 * Admin marketing broadcaster — send an APPROVED marketing template to a
 * segment, with guardrails that make over-sending hard:
 *
 *   • Only APPROVED templates can be picked.
 *   • Segments target the right people (trial / paid / lapsed / leads / all).
 *   • A FREQUENCY GUARD skips anyone who already got a marketing broadcast in
 *     the last N days (default 7) — the #1 way to protect the quality rating.
 *   • Parents who replied STOP (service_paused) are never included.
 *   • Every send is logged, so the next broadcast's guard can see it.
 *
 * Marketing messages are business-initiated; keep them occasional and targeted.
 * Convention: the chosen template's body has exactly ONE variable {{1}} = the
 * recipient's first name (our qp_promo_* / qp_referral_* / qp_winback_* etc.).
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const wa = require('../whatsapp/client');
const { requireAdmin } = require('./auth');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS marketing_broadcasts (
      id            bigserial PRIMARY KEY,
      mobile_number text        NOT NULL,
      template_name text        NOT NULL,
      segment       text,
      status        text        NOT NULL DEFAULT 'sent',
      wa_message_id text,
      error_message text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mkt_broadcasts_mobile ON marketing_broadcasts(mobile_number, created_at);`);
  // Header/footer text of a template, for the admin preview only (Meta stores
  // the live template; these columns just let us show the whole thing).
  await db.query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS header_text text;`);
  await db.query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS footer_text text;`);
  schemaReady = true;
}

const SEGMENTS = {
  all:    'All active parents',
  trial:  'On free trial (no payment)',
  paid:   'Paying parents',
  lapsed: 'Lapsed (no active plan)',
  leads:  'Chatted, never enrolled',
};

/** Recipients for a segment: {mobile_number, name, session_id}. */
async function recipients(segment) {
  if (segment === 'leads') {
    const { rows } = await db.query(`
      SELECT w.mobile_number,
             COALESCE(NULLIF(split_part(w.context->>'parent_name',' ',1),''),'there') AS name,
             w.id AS session_id
        FROM whatsapp_sessions w
       WHERE w.is_active
         AND NOT EXISTS (SELECT 1 FROM parents p WHERE p.parent_mobile_number = w.mobile_number)`);
    return rows;
  }
  let cond = 'p.is_active AND NOT p.service_paused';
  if (segment === 'trial') {
    cond += ` AND EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id=s.plan_id
                 WHERE s.parent_id=p.id AND s.is_active AND pl.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)
              AND NOT EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s2 JOIN quizpe_plans pl2 ON pl2.id=s2.plan_id
                 WHERE s2.parent_id=p.id AND s2.is_active AND NOT pl2.is_trial AND CURRENT_DATE <= s2.plan_end_date)`;
  } else if (segment === 'paid') {
    cond += ` AND EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id=s.plan_id
                 WHERE s.parent_id=p.id AND s.is_active AND NOT pl.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)`;
  } else if (segment === 'lapsed') {
    cond += ` AND NOT EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s
                 WHERE s.parent_id=p.id AND s.is_active AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)`;
  }
  const { rows } = await db.query(`
    SELECT p.parent_mobile_number AS mobile_number,
           COALESCE(NULLIF(split_part(p.parent_name,' ',1),''),'there') AS name,
           (SELECT id FROM whatsapp_sessions w WHERE w.mobile_number=p.parent_mobile_number AND w.is_active
             ORDER BY id DESC LIMIT 1) AS session_id
      FROM parents p WHERE ${cond}`);
  return rows;
}

/** Drop anyone who got a marketing broadcast within `cooldownDays`. */
async function applyCooldown(list, cooldownDays) {
  const days = Math.max(0, Number(cooldownDays) || 0);
  if (!days) return { keep: list, skippedCooldown: 0 };
  const { rows } = await db.query(
    `SELECT DISTINCT mobile_number FROM marketing_broadcasts
      WHERE status='sent' AND created_at > now() - ($1 || ' days')::interval`, [String(days)]);
  const recent = new Set(rows.map((r) => r.mobile_number));
  const keep = list.filter((r) => !recent.has(r.mobile_number));
  return { keep, skippedCooldown: list.length - keep.length };
}

/** Options for the compose screen: approved templates + segment counts. */
router.get('/broadcast/options', requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    const { rows: templates } = await db.query(
      `SELECT template_name, send_context, header_text, body_text, footer_text, buttons, variables FROM whatsapp_templates
        WHERE is_active AND approval_status='APPROVED' ORDER BY template_name`);
    const segCounts = {};
    for (const key of Object.keys(SEGMENTS)) segCounts[key] = (await recipients(key)).length;
    ok(res, { templates, segments: Object.entries(SEGMENTS).map(([key, label]) => ({ key, label, count: segCounts[key] })) });
  } catch (e) { console.error('[admin] broadcast options:', e.message); fail(res, 500, 'Could not load options.'); }
});

/** Dry run: how many would receive it, and how many are skipped and why. */
router.post('/broadcast/preview', requireAdmin, express.json(), async (req, res) => {
  const { segment, cooldownDays = 7 } = req.body || {};
  if (!SEGMENTS[segment]) return fail(res, 400, 'Pick a valid segment.');
  try {
    await ensureSchema();
    const all = await recipients(segment);
    const withSession = all.filter((r) => r.session_id);
    const { keep, skippedCooldown } = await applyCooldown(withSession, cooldownDays);
    ok(res, {
      total: all.length,
      no_session: all.length - withSession.length,
      skipped_cooldown: skippedCooldown,
      recipients: keep.length,
      // the actual people who WILL receive it, so the admin can glance before sending
      list: keep.slice(0, 500).map((r) => ({ name: r.name, mobile: r.mobile_number })),
    });
  } catch (e) { console.error('[admin] broadcast preview:', e.message); fail(res, 500, 'Could not preview.'); }
});

/** Send the template to the segment, respecting the guardrails. */
router.post('/broadcast/send', requireAdmin, express.json(), async (req, res) => {
  const { template, segment, cooldownDays = 7, params = [] } = req.body || {};
  if (!SEGMENTS[segment]) return fail(res, 400, 'Pick a valid segment.');
  if (!template) return fail(res, 400, 'Pick a template.');
  try {
    await ensureSchema();
    // template must be APPROVED — also read its variables to validate the fill
    const { rows: [t] } = await db.query(
      `SELECT variables FROM whatsapp_templates WHERE template_name=$1 AND is_active AND approval_status='APPROVED'`, [template]);
    if (!t) return fail(res, 400, 'That template is not approved.');

    // {{1}} is ALWAYS the recipient's first name (filled per-parent below); the
    // admin supplies the remaining variables ({{2}}..{{n}}) as free text. Validate
    // the count so Meta never rejects the whole batch for a missing parameter.
    const vars = Array.isArray(t.variables) ? t.variables
      : (() => { try { return JSON.parse(t.variables || '[]'); } catch { return []; } })();
    const extra = Array.isArray(params) ? params.map((x) => String(x ?? '').trim()) : [];
    const need = Math.max(0, vars.length - 1);
    if (extra.length !== need) return fail(res, 400, `This template needs ${need} text value(s) after the name.`);
    if (extra.some((v) => !v)) return fail(res, 400, 'Please fill every text field before sending.');

    const all = await recipients(segment);
    const withSession = all.filter((r) => r.session_id);
    const { keep } = await applyCooldown(withSession, cooldownDays);
    if (!keep.length) return ok(res, { sent: 0, failed: 0, note: 'No eligible recipients after the guardrails.' });

    let sent = 0, failed = 0;
    for (const r of keep) {
      try {
        const id = await wa.sendTemplate(r.session_id, r.mobile_number, template, [r.name, ...extra]);
        await db.query(
          `INSERT INTO marketing_broadcasts (mobile_number, template_name, segment, status, wa_message_id)
           VALUES ($1,$2,$3,'sent',$4)`, [r.mobile_number, template, segment, id || null]);
        sent++;
      } catch (e) {
        await db.query(
          `INSERT INTO marketing_broadcasts (mobile_number, template_name, segment, status, error_message)
           VALUES ($1,$2,$3,'failed',$4)`, [r.mobile_number, template, segment, e.message]);
        failed++;
      }
      await new Promise((res2) => setTimeout(res2, 250));   // stay under Meta's rate limit
    }
    console.log(`[broadcast] ${template} -> ${segment}: ${sent} sent, ${failed} failed`);
    ok(res, { sent, failed });
  } catch (e) { console.error('[admin] broadcast send:', e.message); fail(res, 500, 'Broadcast failed.'); }
});

module.exports = router;
