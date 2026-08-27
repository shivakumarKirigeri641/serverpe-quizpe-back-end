/**
 * src/admin/freeQuizRoutes.js
 * ---------------------------------------------------------------------------
 * "Free quiz slot" — grant a free quiz to one or more mobile numbers.
 *
 * This is a make-good tool: when a quiz did not reach a family because of a
 * fault on our side, an admin hands them a real quiz at no charge. No payment
 * and no invoice; the usual report and feedback still follow, because the quiz
 * itself is an ordinary quiz.
 *
 * The grant hangs on the NUMBER, so it reaches a lapsed parent or a brand-new
 * number that has no student row yet. Delivery is handled in the chat flow
 * (see whatsapp/freeQuiz.js): the parent's next message — a tap, "hi", anything
 * — turns the grant into a quiz.
 *
 *   GET  /admin/api/free-quiz/search?q=…   who can I grant to
 *   GET  /admin/api/free-quiz/grants       recent grants + their state
 *   POST /admin/api/free-quiz/grant        grant to a list of numbers
 *   POST /admin/api/free-quiz/cancel       revoke a pending grant
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const wa = require('../whatsapp/client');
const { requireAdmin } = require('./auth');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const norm = (m) => String(m || '').replace(/\D/g, '').slice(-10);

// The notification template. Deliberately qp_announcement_v1: it is approved,
// its three variables are free text, and — unlike the templates that carry a
// "Start Quiz" button — it does not accuse the child of skipping a quiz that we
// failed to deliver. The grant fires on whatever the parent replies, so no
// button is required.
// Overridable: once a purpose-built template is approved in Meta, set
// FREE_QUIZ_TEMPLATE to its name and this switches over with no code change. A
// dedicated template only needs {{1}} = parent's first name; when one is set,
// the two free-text variables below are simply not sent.
const TEMPLATE = process.env.FREE_QUIZ_TEMPLATE || 'qp_announcement_v1';
const DEDICATED = TEMPLATE !== 'qp_announcement_v1';
const HEADLINE = '🎁 A free quiz for you — sorry about the trouble';
const DETAILS = "Sorry the last quiz didn't reach you — that was our fault, not yours. "
  + "We've added a *free quiz* to your number: reply *hi* and it will start right away. "
  + 'No payment, nothing to cancel. 🙏';

/**
 * Who a number belongs to, and what state they are in. Used by the admin UI so
 * the founder can see whether they are about to message a premium family, a
 * lapsed one, or someone who only ever said hi.
 */
async function describe(mobiles) {
  if (!mobiles.length) return [];
  const { rows } = await db.query(
    `SELECT p.id parent_id, p.parent_name, p.parent_mobile_number mobile, p.service_paused,
            (SELECT COUNT(*)::int FROM students st WHERE st.parent_id=p.id AND st.is_active) children,
            (SELECT string_agg(st.student_name, ', ' ORDER BY st.id)
               FROM students st WHERE st.parent_id=p.id AND st.is_active) child_names,
            EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id=s.plan_id
                     WHERE s.parent_id=p.id AND s.is_active AND NOT pl.is_trial
                       AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) is_premium,
            EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id=s.plan_id
                     WHERE s.parent_id=p.id AND s.is_active AND pl.is_trial
                       AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) is_trial
       FROM parents p
      WHERE p.parent_mobile_number = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM unnest($1::text[]) m WHERE p.parent_mobile_number LIKE '%'||m)`,
    [mobiles]);

  const byMobile = {};
  rows.forEach((r) => { byMobile[norm(r.mobile)] = r; });

  return mobiles.map((m) => {
    const r = byMobile[norm(m)];
    if (!r) return { mobile: m, segment: 'lead', label: 'Never enrolled', children: 0, known: false };
    const segment = r.is_premium ? 'premium' : r.is_trial ? 'trial' : r.children ? 'lapsed' : 'lead';
    return {
      mobile: norm(r.mobile), parent_name: r.parent_name, known: true,
      children: r.children, child_names: r.child_names, paused: r.service_paused,
      segment,
      label: { premium: 'Premium', trial: 'On trial', lapsed: 'Lapsed', lead: 'Never enrolled' }[segment],
    };
  });
}

/** Look up numbers to grant to — by mobile fragment or parent/child name. */
router.get('/free-quiz/search', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  try {
    if (!q) return ok(res, { rows: [] });
    const digits = q.replace(/\D/g, '');
    const { rows } = await db.query(
      `SELECT DISTINCT p.parent_mobile_number mobile
         FROM parents p
         LEFT JOIN students st ON st.parent_id = p.id AND st.is_active
        WHERE ($1 <> '' AND p.parent_mobile_number LIKE '%'||$1||'%')
           OR p.parent_name ILIKE '%'||$2||'%'
           OR st.student_name ILIKE '%'||$2||'%'
        LIMIT 25`, [digits, q]);

    // A number that only ever said hi has no parent row, so search the chat
    // sessions too — those are exactly the people this tool most often needs.
    const { rows: leads } = digits
      ? await db.query(
          `SELECT DISTINCT w.mobile_number mobile FROM whatsapp_sessions w
            WHERE w.mobile_number LIKE '%'||$1||'%'
              AND NOT EXISTS (SELECT 1 FROM parents p WHERE p.parent_mobile_number = w.mobile_number)
            LIMIT 15`, [digits])
      : { rows: [] };

    const mobiles = [...new Set([...rows, ...leads].map((r) => norm(r.mobile)))];
    ok(res, { rows: await describe(mobiles) });
  } catch (e) {
    console.error('[admin] free-quiz search:', e.message);
    fail(res, 500, 'Could not search.');
  }
});

/** Recent grants and what became of them. */
router.get('/free-quiz/grants', requireAdmin, async (req, res) => {
  try {
    await require('../whatsapp/freeQuiz').expireStale();
    const { rows } = await db.query(
      `SELECT g.id, g.mobile_number mobile, g.question_count, g.reason, g.granted_by, g.status,
              g.tracker_id, g.expires_at, g.created_at, g.consumed_at,
              COALESCE(p.parent_name,'—') parent_name,
              st.student_name,
              qs.status_code quiz_status,
              r.score_correct, r.score_total, r.score_pct
         FROM free_quiz_grants g
         LEFT JOIN parents p ON p.parent_mobile_number = g.mobile_number
         LEFT JOIN students st ON st.id = g.student_id
         LEFT JOIN quizpe_tracker t ON t.id = g.tracker_id
         LEFT JOIN quizpe_status qs ON qs.id = t.status_id
         LEFT JOIN quiz_reports r ON r.tracker_id = t.id
        ORDER BY g.id DESC LIMIT 100`);
    ok(res, { rows });
  } catch (e) {
    console.error('[admin] free-quiz grants:', e.message);
    fail(res, 500, 'Could not load grants.');
  }
});

/** Grant a free quiz to one or more numbers, and tell them it is waiting. */
router.post('/free-quiz/grant', requireAdmin, express.json(), async (req, res) => {
  const { mobiles, question_count = 15, reason = '', notify = true } = req.body || {};
  const list = [...new Set(String(mobiles || '').split(/[\s,;]+/).map(norm).filter((m) => m.length === 10))];
  if (!list.length) return fail(res, 400, 'Enter at least one valid 10-digit mobile number.');

  const qc = Math.max(4, Math.min(30, Number(question_count) || 15));
  const by = req.admin?.sub || 'admin';

  const out = [];
  for (const m of list) {
    try {
      // A parent who sent STOP must never be messaged, whatever the reason.
      const paused = (await db.query(
        `SELECT 1 FROM parents WHERE parent_mobile_number LIKE '%'||$1 AND service_paused`, [m])).rowCount;
      if (paused) { out.push({ mobile: m, status: 'skipped', note: 'Parent sent STOP' }); continue; }

      // One pending grant per number: top up rather than stack, so a repeated
      // click cannot hand out several free quizzes.
      const existing = (await db.query(
        `SELECT id FROM free_quiz_grants WHERE mobile_number=$1 AND status='pending' AND expires_at > now()`,
        [m])).rows[0];

      let grantId;
      if (existing) {
        await db.query(
          `UPDATE free_quiz_grants SET question_count=$2, reason=$3, granted_by=$4,
                  expires_at=now()+interval '7 days', modified_at=now() WHERE id=$1`,
          [existing.id, qc, reason, by]);
        grantId = existing.id;
      } else {
        grantId = (await db.query(
          `INSERT INTO free_quiz_grants (mobile_number, question_count, reason, granted_by)
           VALUES ($1,$2,$3,$4) RETURNING id`, [m, qc, reason, by])).rows[0].id;
      }

      if (notify) {
        const sess = (await db.query(
          `SELECT id FROM whatsapp_sessions WHERE mobile_number LIKE '%'||$1
            ORDER BY id DESC LIMIT 1`, [m])).rows[0];
        const name = (await db.query(
          `SELECT COALESCE(NULLIF(split_part(parent_name,' ',1),''),'there') n
             FROM parents WHERE parent_mobile_number LIKE '%'||$1`, [m])).rows[0]?.n || 'there';
        const params = DEDICATED ? [name] : [name, HEADLINE, DETAILS];
        await wa.sendTemplate(sess ? sess.id : null, m, TEMPLATE, params);
        await db.query(`UPDATE free_quiz_grants SET notified_at=now() WHERE id=$1`, [grantId]);
      }
      out.push({ mobile: m, status: 'granted', grant_id: grantId });
    } catch (e) {
      console.error('[admin] free-quiz grant', m, e.message);
      out.push({ mobile: m, status: 'failed', note: e.message });
    }
    await new Promise((r) => setTimeout(r, 250));   // stay under Meta's rate limit
  }

  const granted = out.filter((o) => o.status === 'granted').length;
  console.log(`[freequiz] ${granted} granted, ${out.length - granted} skipped/failed by ${by}`);
  ok(res, { results: out, granted });
});

/** Revoke a grant that has not been used yet. */
router.post('/free-quiz/cancel', requireAdmin, express.json(), async (req, res) => {
  const id = Number(req.body?.id);
  if (!id) return fail(res, 400, 'Which grant?');
  try {
    const { rowCount } = await db.query(
      `UPDATE free_quiz_grants SET status='cancelled', modified_at=now()
        WHERE id=$1 AND status='pending'`, [id]);
    if (!rowCount) return fail(res, 400, 'That grant is no longer pending.');
    ok(res, { cancelled: id });
  } catch (e) {
    console.error('[admin] free-quiz cancel:', e.message);
    fail(res, 500, 'Could not cancel.');
  }
});

module.exports = router;
