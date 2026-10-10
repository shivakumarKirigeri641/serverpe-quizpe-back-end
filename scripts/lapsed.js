#!/usr/bin/env node
/**
 * scripts/lapsed.js — WHO LAPSED AND DID NOT COME BACK (user, 2026-10-10).
 *
 *   node scripts/lapsed.js            the list, newest lapse first
 *   node scripts/lapsed.js --csv      the same as CSV (to a file: > lapsed.csv)
 *
 * READ-ONLY: only SELECTs.
 *
 * A family has LAPSED when its last plan (free trial or paid) has ended and nothing
 * is running or booked after it. Each one shows whether they came back at all since
 * the plan ended — opened quizpe.in/app, or a child took a quiz (free access) — so
 * "gone quiet" stands apart from "still looking". The admin's own numbers
 * (ADMIN_MOBILES) are left out.
 *
 * What can reach them is listed too: email, phone notifications on the app, and
 * whether they paused everything (STOP) or deactivated — those are not to be chased.
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');
const ME = require('../src/admin/hq/notMe').mobile;

const CSV = process.argv.includes('--csv');

(async () => {
  const { rows } = await db.query(
    `WITH last AS (
       SELECT DISTINCT ON (s.parent_id) s.parent_id, s.plan_start_date, s.plan_end_date, pl.plan_name, pl.is_trial
         FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
        ORDER BY s.parent_id, s.plan_end_date DESC, s.id DESC
     )
     SELECT p.id, p.parent_name, right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10) AS mobile,
            p.email, p.service_paused, p.deactivated_at, p.is_active,
            l.plan_name, l.is_trial, l.plan_start_date, l.plan_end_date,
            (CURRENT_DATE - l.plan_end_date)::int AS days_since,
            (SELECT count(*) FROM students st WHERE st.parent_id = p.id AND st.is_active)::int AS children,
            -- Paid before? (any non-trial plan, ever)
            EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s2 JOIN quizpe_plans p2 ON p2.id = s2.plan_id
                     WHERE s2.parent_id = p.id AND NOT p2.is_trial) AS ever_paid,
            -- Quizzes finished while the plan ran, and the last one ever.
            (SELECT count(*) FROM quizpe_tracker t JOIN students st ON st.id = t.student_id JOIN quizpe_status qs ON qs.id = t.status_id
              WHERE st.parent_id = p.id AND qs.status_code IN ('completed', 'closed')
                AND t.quiz_date BETWEEN l.plan_start_date AND l.plan_end_date)::int AS quizzes_in_plan,
            (SELECT max(t.quiz_date) FROM quizpe_tracker t JOIN students st ON st.id = t.student_id JOIN quizpe_status qs ON qs.id = t.status_id
              WHERE st.parent_id = p.id AND qs.status_code IN ('completed', 'closed')) AS last_quiz,
            -- Came back since it ended: the app, or a quiz.
            (SELECT max(w.last_seen_at) FROM parent_web_sessions w
              WHERE right(regexp_replace(w.mobile_number, '\\D', '', 'g'), 10) = right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10)) AS last_app_visit,
            EXISTS (SELECT 1 FROM quizpe_tracker t JOIN students st ON st.id = t.student_id
                     WHERE st.parent_id = p.id AND t.quiz_date > l.plan_end_date) AS quiz_since,
            (SELECT count(*) FROM parent_push x
              WHERE right(regexp_replace(x.mobile_number, '\\D', '', 'g'), 10) = right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10))::int AS push_devices,
            EXISTS (SELECT 1 FROM whatsapp_sessions ws
                     WHERE ws.mobile_number = p.parent_mobile_number AND ws.opted_out) AS stopped
       FROM parents p JOIN last l ON l.parent_id = p.id
      WHERE l.plan_end_date < CURRENT_DATE
        -- Nothing running or booked after it.
        AND NOT EXISTS (SELECT 1 FROM parents_quizpe_subscriptions s3
                         WHERE s3.parent_id = p.id AND s3.is_active AND s3.plan_end_date >= CURRENT_DATE)
        AND ${ME('p.parent_mobile_number')}
      ORDER BY l.plan_end_date DESC, p.id`);

  const out = rows.map((r) => {
    const cameBack = (r.last_app_visit && new Date(r.last_app_visit) > new Date(r.plan_end_date)) || r.quiz_since;
    const reach = [r.email ? 'email' : null, r.push_devices ? 'app notifications' : null].filter(Boolean);
    const dontChase = r.deactivated_at ? 'deactivated' : r.service_paused || r.stopped ? 'paused / STOP' : !r.is_active ? 'removed' : '';
    return {
      name: r.parent_name || '—', mobile: r.mobile,
      plan: r.is_trial ? 'Free trial' : r.plan_name, paid_before: r.ever_paid ? 'yes' : 'no',
      ended: new Date(r.plan_end_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      days_since: r.days_since, children: r.children, quizzes_in_plan: r.quizzes_in_plan,
      last_quiz: r.last_quiz ? new Date(r.last_quiz).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—',
      came_back: cameBack ? 'looked again' : 'no',
      reach: reach.join(' + ') || 'none (no email, no app)',
      dont_chase: dontChase,
    };
  });
  const gone = out.filter((x) => x.came_back === 'no');

  if (CSV) {
    const cols = Object.keys(out[0] || { name: '' });
    console.log(cols.join(','));
    for (const x of out) console.log(cols.map((c) => `"${String(x[c]).replace(/"/g, '""')}"`).join(','));
    process.exit(0);
  }

  const trial = out.filter((x) => x.plan === 'Free trial');
  console.log(`\nLAPSED FAMILIES: ${out.length}  ·  did not come back: ${gone.length}  ·  came back to look: ${out.length - gone.length}`);
  console.log(`  ended a free trial and never paid: ${trial.filter((x) => x.paid_before === 'no').length}`);
  console.log(`  paid before, plan ended:            ${out.filter((x) => x.paid_before === 'yes').length}`);
  console.log(`  reachable by email or app:          ${out.filter((x) => !x.reach.startsWith('none')).length}`);
  console.log(`  not to be chased (paused/deactivated): ${out.filter((x) => x.dont_chase).length}\n`);
  console.table(out);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
