#!/usr/bin/env node
/**
 * scripts/sms-list.js — THE PARENTS TO TELL BY SMS (user, 2026-10-29: "give me the list of parents who did trial,
 * paid or lapsed" - for the approved DLT SMS that QuizPe is back on WhatsApp).
 *
 *   node scripts/sms-list.js              the list with each family's status, and the counts
 *   node scripts/sms-list.js --numbers    only the 10-digit numbers, one a line (for the SMS panel's upload)
 *   node scripts/sms-list.js --numbers --skip-active    the same, without families on a running plan
 *
 * READ-ONLY: only SELECTs, QuizPe's own database only.
 *
 * Every parent who ever had a plan (free trial or paid) or MCQs (free 50, recharge, referral, admin). Never on the
 * list: the admin's own numbers (ADMIN_MOBILES), anyone who said STOP on WhatsApp, paused the service or deactivated.
 * The file of numbers is for the SMS panel only - delete it once uploaded.
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');
const ME = require('../src/admin/hq/notMe').mobile;

const NUMBERS = process.argv.includes('--numbers');
const SKIP_ACTIVE = process.argv.includes('--skip-active');

(async () => {
  const { rows } = await db.query(
    `WITH ten AS (
       SELECT p.*, right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10) AS m10 FROM parents p
     ),
     last AS (
       SELECT DISTINCT ON (s.parent_id) s.parent_id, s.plan_end_date, pl.plan_name, pl.is_trial
         FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
        ORDER BY s.parent_id, s.plan_end_date DESC, s.id DESC
     )
     SELECT p.id, p.parent_name, p.m10 AS mobile, l.plan_name, l.is_trial, l.plan_end_date,
            EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
                     WHERE s.parent_id = p.id AND NOT pl.is_trial) AS ever_paid,
            EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s
                     WHERE s.parent_id = p.id AND s.is_active AND s.plan_end_date >= CURRENT_DATE) AS active_plan,
            (SELECT coalesce(sum(x.mcqs - x.used), 0) FROM mcq_lots x WHERE x.parent_id = p.id AND x.expires_at > now())::int AS mcqs_left,
            EXISTS (SELECT 1 FROM mcq_lots x WHERE x.parent_id = p.id AND x.source = 'recharge') AS recharged,
            EXISTS (SELECT 1 FROM mcq_lots x WHERE x.parent_id = p.id) AS has_mcqs
       FROM ten p LEFT JOIN last l ON l.parent_id = p.id
      WHERE (l.parent_id IS NOT NULL OR EXISTS (SELECT 1 FROM mcq_lots x WHERE x.parent_id = p.id))
        AND p.m10 ~ '^[6-9][0-9]{9}$'
        AND p.deactivated_at IS NULL AND NOT coalesce(p.service_paused, false)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions ws
                         WHERE right(regexp_replace(ws.mobile_number, '\\D', '', 'g'), 10) = p.m10 AND ws.opted_out)
        AND ${ME('p.parent_mobile_number')}
      ORDER BY active_plan DESC, ever_paid DESC, l.plan_end_date DESC NULLS LAST, p.id`);

  const status = (r) => (r.active_plan ? (r.is_trial ? 'trial running' : 'paid plan running')
    : r.ever_paid || r.recharged ? 'paid before, lapsed'
    : r.plan_name ? 'trial ended, never paid'
    : 'MCQs only (new)');
  const list = rows.map((r) => ({
    name: r.parent_name || '—', mobile: r.mobile, status: status(r),
    plan: r.plan_name ? `${r.is_trial ? 'Free trial' : r.plan_name} · ends ${new Date(r.plan_end_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : '—',
    mcqs_left: r.mcqs_left,
  }));
  // One row per number (a number on two parent rows is sent once).
  const seen = new Set();
  const uniq = list.filter((x) => (seen.has(x.mobile) ? false : seen.add(x.mobile)));
  const pick = SKIP_ACTIVE ? uniq.filter((x) => !x.status.endsWith('running')) : uniq;

  if (NUMBERS) {
    for (const x of pick) console.log(x.mobile);
    process.exit(0);
  }
  const by = (s) => uniq.filter((x) => x.status === s).length;
  console.log(`\nPARENTS TO TELL: ${uniq.length}  (STOP / paused / deactivated / admin numbers left out)`);
  for (const s of ['paid plan running', 'trial running', 'paid before, lapsed', 'trial ended, never paid', 'MCQs only (new)']) {
    console.log(`  ${s.padEnd(26)} ${by(s)}`);
  }
  console.log('');
  console.table(uniq);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
