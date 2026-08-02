/**
 * scripts/capacity-check.js
 * ---------------------------------------------------------------------------
 * Reads the live database and says how close QuizPe is to its known ceilings,
 * so scaling work starts from measurements instead of a hunch.
 *
 *   node scripts/capacity-check.js
 *
 * The numbers that actually bite, in the order they bite:
 *   1. the 8 PM send burst   — 250ms pacing = ~4 messages/second
 *   2. report rendering      — REPORT_CONCURRENCY at ~0.5s per PDF
 *   3. history table growth  — ~10 rows per student per day
 *   4. DB connection pool    — PG_POOL_MAX
 * ---------------------------------------------------------------------------
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const SEND_PACING_MS = 250;                                  // scheduler.js
const PDF_SECONDS = 0.5;                                     // measured, roughly
const REPORT_CONCURRENCY = Number(process.env.JOB_CONCURRENCY) || 2;
const SEND_RATE_PER_SEC = Number(process.env.WA_SEND_RATE_PER_SEC) || 20;
const POOL_MAX = Number(process.env.PG_POOL_MAX) || 25;

const mins = (s) => s < 60 ? `${Math.round(s)}s`
  : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} hours`;

/** Flag anything that would degrade the parent's experience. */
function verdict(label, value, warn, fail, fmt = (v) => v) {
  const state = value >= fail ? '🔴' : value >= warn ? '🟡' : '🟢';
  console.log(`  ${state} ${label.padEnd(34)} ${fmt(value)}`);
  return value >= fail ? 2 : value >= warn ? 1 : 0;
}

(async () => {
  const q = async (sql, p = []) => (await db.query(sql, p)).rows[0];

  const active = await q(
    `SELECT COUNT(DISTINCT p.id)::int parents, COUNT(st.id)::int students
       FROM parents p
       JOIN parents_quizpe_subscriptions s ON s.parent_id = p.id AND s.is_active
        AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date
       JOIN students st ON st.parent_id = p.id AND st.is_active
      WHERE p.is_active`);

  // Two separate pressures, and they no longer coincide:
  //
  //   NOTIFY  reminder + quiz trigger, inside the 19:00-21:00 stagger. This is
  //           the tight one — it is bounded by how fast WhatsApp accepts us.
  //   ANSWER  quizzes taken and reports rendered, spread across the whole
  //           19:00-23:45 window, so the same volume has ~2.4x longer to land.
  const W = require('../src/whatsapp/quizWindow');
  const { slots, SLOT_START_MIN, SLOT_END_MIN } = require('../src/whatsapp/quizSlot');

  const notifyWindowSec = Math.max((SLOT_END_MIN - SLOT_START_MIN) * 60, 60);
  const answerWindowSec = Math.max((W.CLOSE_MIN - W.OPEN_MIN) * 60, 60);

  const perEvening = active.students * 2;                    // reminder + quiz trigger
  const sendSeconds = perEvening / Math.max(SEND_RATE_PER_SEC, 0.1);
  const renderSeconds = (active.students * PDF_SECONDS) / REPORT_CONCURRENCY;

  // headroom: how many students each pressure could take before it overruns
  const notifyCapacity = Math.floor((notifyWindowSec * SEND_RATE_PER_SEC) / 2);
  const renderCapacity = Math.floor((answerWindowSec * REPORT_CONCURRENCY) / PDF_SECONDS);

  const hist = await q(`SELECT COUNT(*)::int n FROM student_quizpe_histories`);
  const perDay = active.students * 10;
  const size = await q(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
            pg_size_pretty(pg_total_relation_size('student_quizpe_histories')) AS hist`);

  const peakDay = await q(
    `SELECT send_date::text d, COUNT(*)::int n FROM notification_log
      GROUP BY send_date ORDER BY n DESC LIMIT 1`);

  console.log(`\n📊 QuizPe capacity — ${new Date().toLocaleString('en-IN')}\n`);
  console.log(`  Active parents  : ${active.parents}`);
  console.log(`  Active students : ${active.students}`);
  console.log(`  Busiest day so far: ${peakDay ? `${peakDay.n} messages on ${peakDay.d}` : 'none yet'}`);
  console.log(`  Database size   : ${size.db}  (histories ${size.hist}, ${hist.n.toLocaleString()} rows)\n`);

  const jobStats = await (async () => {
    try { return await require('../src/jobs/jobQueue').stats(); } catch { return {}; }
  })();
  const backlog = (jobStats.pending || 0) + (jobStats.running || 0);
  console.log(`  Job queue       : ${backlog} in flight` +
              (jobStats.failed ? `, ⚠️ ${jobStats.failed} FAILED (inspect job_queue)` : '') + '\n');

  console.log(`  Windows: notify ${mins(notifyWindowSec)} (staggered slots) · ` +
              `answer ${mins(answerWindowSec)} (${W.OPEN_HHMM}-${W.CLOSE_HHMM})`);
  console.log(`  Headroom: ~${notifyCapacity.toLocaleString('en-IN')} students on notifications, ` +
              `~${renderCapacity.toLocaleString('en-IN')} on report rendering
`);

  console.log('  Ceilings:');
  let worst = 0;
  worst = Math.max(worst, verdict('evening notification burst', sendSeconds, notifyWindowSec * 0.5,
    notifyWindowSec, mins));
  worst = Math.max(worst, verdict('report rendering', renderSeconds, answerWindowSec * 0.5,
    answerWindowSec, mins));
  worst = Math.max(worst, verdict('history rows added per day', perDay, 50_000, 250_000,
    (v) => v.toLocaleString()));
  worst = Math.max(worst, verdict('students (pool max ' + POOL_MAX + ')', active.students, 2_000, 10_000,
    (v) => v.toLocaleString()));
  worst = Math.max(worst, verdict('job backlog', backlog, 100, 1_000, (v) => v.toLocaleString()));

  console.log('');
  if (worst === 0) {
    console.log('  ✅ Comfortable. No scaling work needed yet.\n');
  } else if (worst === 1) {
    console.log(`  🟡 Approaching limits. Start the scale work now, before it hurts:
     • stagger quiz_time across the evening instead of everyone at 8 PM
     • move the report queue from memory to a durable job table
     • move report/invoice PDFs to object storage\n`);
  } else {
    console.log(`  🔴 Past comfortable limits. Parents are likely already waiting.
     • the evening burst no longer fits in the hour — stagger quiz_time NOW
     • raise REPORT_CONCURRENCY and/or move rendering to a worker process
     • partition student_quizpe_histories by month
     • request a higher WhatsApp messaging tier from Meta\n`);
  }

  await db.close();
})();
