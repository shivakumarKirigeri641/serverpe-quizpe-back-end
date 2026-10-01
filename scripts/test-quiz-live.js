#!/usr/bin/env node
/**
 * scripts/test-quiz-live.js
 * ---------------------------------------------------------------------------
 * Proves the live-quiz admin views cannot disturb a running quiz.
 *
 *   node scripts/test-quiz-live.js
 *
 * Three things are checked, in order of how much they matter:
 *
 *   1. THE READ-ONLY GUARANTEE IS REAL. An INSERT is deliberately attempted
 *      through the same helper the dashboards use. PostgreSQL must refuse it
 *      with 25006 (read_only_sql_transaction). If that write ever succeeds,
 *      every other assurance here is worthless — so it is tested first.
 *
 *   2. READING CHANGES NOTHING. Row counts of every table the quiz writes to
 *      are taken before and after opening all the views. They must match
 *      exactly, not approximately.
 *
 *   3. THE QUERIES ANSWER IN TIME. Each view is timed against the two-second
 *      statement timeout. Anything close to it is called out, because these
 *      screens are read while children are mid-quiz.
 *
 * Safe to run against production: it reads, and its one write is expected to
 * fail. It sends no WhatsApp messages and touches no external service.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const db = require('../src/database/connectDB');
const live = require('../src/admin/quizLive');

const TABLES = [
  'quizpe_tracker',
  'student_quizpe_histories',
  'quiz_reports',
  'question_bank',
  'students',
  'parents',
  'whatsapp_messages',
];

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m/\x1b[0m ${m}`);
const fail = (m) => { failures += 1; console.log(`  \x1b[31mX ${m}\x1b[0m`); };

async function counts() {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT count(*)::bigint AS n FROM ${t}`);
    out[t] = rows[0].n;
  }
  return out;
}

async function main() {
  console.log('\n\x1b[1mLive quiz views - safety check\x1b[0m');
  console.log(`  database: ${process.env.PGDATABASE} on ${process.env.PGHOST || 'localhost'}\n`);

  /* ── 1. the read-only guarantee ───────────────────────────────────────── */
  console.log('1. The read-only transaction actually refuses writes');
  try {
    await live.read(
      `INSERT INTO quizpe_tracker (student_id, subject_id, quiz_date)
       VALUES (-1, -1, CURRENT_DATE)`);
    fail('an INSERT SUCCEEDED through the read helper - stop and fix this');
  } catch (e) {
    if (e.code === '25006') pass('INSERT refused by PostgreSQL (25006 read_only_sql_transaction)');
    else fail(`refused, but for the wrong reason: ${e.code} ${e.message}`);
  }

  /* ── 2. reading changes nothing ───────────────────────────────────────── */
  console.log('\n2. Opening every view leaves the data untouched');
  const before = await counts();

  const timings = {};
  const run = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      timings[name] = Date.now() - t0;
      return out;
    } catch (e) {
      timings[name] = Date.now() - t0;
      fail(`${name} threw: ${e.message}`);
      return null;
    }
  };

  const pulse  = await run('pulse',            () => live.pulse());
  const series = await run('minuteSeries',     () => live.minuteSeries(120));
  const slots  = await run('slotFunnel',       () => live.slotFunnel());
  const flight = await run('inFlight',         () => live.inFlight({}));
  const quest  = await run('questionAccuracy', () => live.questionAccuracy({ days: 30, limit: 20 }));
  if (flight && flight.length) {
    await run('timeline', () => live.timeline(flight[0].tracker_id));
  }

  const after = await counts();
  let drift = 0;
  for (const t of TABLES) {
    if (before[t] !== after[t]) { fail(`${t}: ${before[t]} -> ${after[t]}`); drift += 1; }
  }
  if (!drift) pass(`all ${TABLES.length} tables unchanged (${TABLES.map((t) => `${t}=${before[t]}`).join(', ')})`);

  /* ── 3. fast enough to read during a quiz ─────────────────────────────── */
  console.log('\n3. Fast enough to be read while children are answering');
  for (const [name, ms] of Object.entries(timings)) {
    if (ms >= 1500) fail(`${name} took ${ms}ms - too close to the 2s timeout`);
    else if (ms >= 600) console.log(`  \x1b[33m!\x1b[0m ${name} took ${ms}ms - watch this as data grows`);
    else pass(`${name} ${ms}ms`);
  }

  /* ── what it actually found ───────────────────────────────────────────── */
  console.log('\n\x1b[1mToday, as the gauges would show it\x1b[0m');
  if (pulse) {
    console.log(`  quizzes built     ${pulse.quizzes_today}`);
    console.log(`  started           ${pulse.started}`);
    console.log(`  completed         ${pulse.completed}  (${pulse.completion_pct ?? '-'}%)`);
    console.log(`  in progress       ${pulse.in_progress}`);
    console.log(`  stalled >30 min   ${pulse.stalled}`);
    console.log(`  answers           ${pulse.questions_answered} of ${pulse.questions_sent} sent`);
    console.log(`  accuracy          ${pulse.accuracy_pct ?? '-'}%`);
    console.log(`  avg response      ${pulse.avg_response_seconds ?? '-'}s`);
  }
  if (slots?.length) {
    console.log('\n  slot  built  sent  started  completed');
    slots.forEach((s) => console.log(
      `  ${String(s.slot).padStart(4)}  ${String(s.built).padStart(5)}  ${String(s.sent).padStart(4)}`
      + `  ${String(s.started).padStart(7)}  ${String(s.completed).padStart(9)}`));
  }
  if (flight?.length) {
    console.log('\n  live quiz monitor (first 5)');
    flight.slice(0, 5).forEach((r) => console.log(
      `   ${String(r.student_name || '').slice(0, 18).padEnd(18)} ${String(r.answered).padStart(2)}/${r.total_questions}`
      + `  ${String(r.progress_pct ?? 0).padStart(3)}%  ${r.status}`));
  }
  if (series?.length) {
    const total = series.reduce((n, r) => n + Number(r.answers), 0);
    const busy = series.reduce((a, b) => (Number(b.answers) > Number(a.answers) ? b : a), series[0]);
    console.log(`\n  last 2 hours: ${total} answers, busiest minute ${busy.at} (${busy.answers})`);
  }
  if (quest?.length) {
    console.log('\n  weakest questions (accuracy, most-picked wrong option)');
    quest.slice(0, 5).forEach((q) => console.log(
      `   #${q.question_id}  ${String(q.accuracy_pct).padStart(5)}%  n=${String(q.attempts).padStart(3)}`
      + `  wrong->${q.top_wrong_option || '-'} ${q.top_wrong_pct || 0}%  (key ${q.correct_option})`));
  }

  console.log(
    failures
      ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
      : '\n\x1b[32mAll checks passed - these views cannot write, and did not.\x1b[0m\n');

  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\n', e); process.exit(1); });
