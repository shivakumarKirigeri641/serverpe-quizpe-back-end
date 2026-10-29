/**
 * scripts/mcq-check.js — WHERE DID THE MCQs GO? (user, 2026-10-29: "after End, balance didn't deduct"). Read-only.
 *
 *   node scripts/mcq-check.js                 the owner's number (9886122415), today
 *   node scripts/mcq-check.js --mobile 9xxxxxxxxx --days 3
 *
 * Shows the family's MCQ lots (what was added, used, left), every quiz in the period with WHO PAID (plan or
 * balance), questions answered and MCQs charged for it, and whether a live plan exists. A balance quiz whose
 * "charged" is lower than "answered" means a debit failed — look for "[chatQuiz] debit failed" in pm2 logs.
 */
require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const mobile = String(arg('--mobile', '9886122415')).replace(/\D/g, '').slice(-10);
const days = Math.max(1, Number(arg('--days', 1)) || 1);

(async () => {
  const p = (await db.query(`SELECT id, parent_name FROM parents WHERE right(parent_mobile_number, 10) = $1`, [mobile])).rows[0];
  if (!p) { console.log(`\nNo family for ${mobile} (parked? run fresh-number.js without flags).\n`); process.exit(0); }
  console.log(`\nFamily ${p.id} · ${p.parent_name || '—'} · ${mobile}`);

  const plan = (await db.query(
    `SELECT pl.plan_name, s.plan_start_date::text AS from, s.plan_end_date::text AS till
       FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE s.parent_id = $1 AND s.is_active AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date
      ORDER BY s.plan_end_date DESC LIMIT 1`, [p.id])).rows[0];
  console.log(plan ? `Live plan: ${plan.plan_name} (${plan.from} → ${plan.till}) — quizzes use the PLAN first.` : 'Live plan: none — quizzes use the MCQ balance.');

  const lots = (await db.query(
    `SELECT id, source, mcqs, used, mcqs - used AS left, to_char(expires_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') AS expires,
            note, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS added
       FROM mcq_lots WHERE parent_id = $1 ORDER BY id`, [p.id])).rows;
  console.log('\nMCQ lots:');
  console.table(lots.length ? lots : [{ source: '(none)' }]);

  const quizzes = (await db.query(
    `SELECT t.id AS tracker, st.student_name AS student, to_char(t.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS started,
            CASE WHEN t.paid_by = 'wallet' THEN 'MCQ balance' ELSE 'plan' END AS paid_by, qs.status_code AS status,
            (SELECT count(*) FROM student_quizpe_histories h WHERE h.tracker_id = t.id AND h.answered_option IS NOT NULL)::int AS answered,
            (SELECT count(*) FROM mcq_usage u WHERE u.tracker_id = t.id)::int AS charged
       FROM quizpe_tracker t JOIN students st ON st.id = t.student_id JOIN quizpe_status qs ON qs.id = t.status_id
      WHERE st.parent_id = $1 AND t.created_at > now() - make_interval(days => $2)
      ORDER BY t.id`, [p.id, days])).rows;
  console.log(`Quizzes, last ${days} day(s):`);
  console.table(quizzes.length ? quizzes : [{ tracker: '(none)' }]);
  const short = quizzes.filter((q) => q.paid_by === 'MCQ balance' && q.charged < q.answered);
  console.log(short.length
    ? `⚠️  ${short.length} balance quiz(zes) charged less than answered — check: pm2 logs serverpe-quizpe --lines 500 | grep "debit failed"`
    : 'Every balance quiz was charged exactly what was answered; plan quizzes never use MCQs.');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
