/**
 * scripts/archive-data.js
 * ---------------------------------------------------------------------------
 * Moves old rows out of the hot tables into `<table>_archive`, keeping the
 * database small without losing anything.
 *
 *   node scripts/archive-data.js                 # DRY RUN — shows what would move
 *   node scripts/archive-data.js --apply         # actually move it
 *   node scripts/archive-data.js --apply --days 90
 *
 * ---------------------------------------------------------------------------
 * WHY PRIMARY KEYS ARE NEVER RESET
 *
 * The original request was to archive and restart ids from 1. That would break
 * three things, quietly and permanently:
 *
 *   1. GST. Invoice numbers must be unique and unbroken within a financial
 *      year. Reusing 202607210001 after an archive is a compliance failure,
 *      not a cosmetic one. Invoices and gstr1_filing are therefore NEVER
 *      archived here at all — statutory retention is years, not months.
 *
 *   2. Foreign keys. quizpe_tracker -> student_quizpe_histories ->
 *      quiz_reports are joined by id. Renumbering makes surviving rows point
 *      at the wrong child's data, with no error to notice.
 *
 *   3. The adaptive engine. mastery.js reads a child's answer history to pick
 *      tomorrow's questions. Corrupt that mapping and every child's
 *      progression silently degrades.
 *
 * So: rows move, ids stay, sequences keep counting forward. The disk saving is
 * identical; only the corruption is missing.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DAYS = (() => {
  const i = args.indexOf('--days');
  return i >= 0 ? Math.max(parseInt(args[i + 1], 10) || 0, 30) : null;
})();

/**
 * Archive plan. Children BEFORE parents, so a foreign key never dangles.
 * `keepDays` is how much recent data stays hot.
 */
const PLAN = [
  {
    table: 'student_quizpe_histories',
    keepDays: 180,
    // only histories whose quiz is itself old enough to archive
    where: `tracker_id IN (SELECT id FROM quizpe_tracker WHERE quiz_date < CURRENT_DATE - $1::int)`,
    note: 'answer-by-answer history — the biggest table by far',
  },
  {
    table: 'quizpe_tracker',
    keepDays: 180,
    where: `quiz_date < CURRENT_DATE - $1::int
            AND id NOT IN (SELECT tracker_id FROM student_quizpe_histories WHERE tracker_id IS NOT NULL)`,
    note: 'one row per child per subject per day',
  },
  {
    table: 'whatsapp_messages',
    keepDays: 90,
    where: `created_at < now() - ($1::int || ' days')::interval`,
    note: 'every inbound and outbound message',
  },
  {
    table: 'whatsapp_session_events',
    keepDays: 90,
    where: `created_at < now() - ($1::int || ' days')::interval`,
    note: 'state-machine transitions',
  },
  {
    table: 'notification_log',
    keepDays: 180,
    where: `send_date < CURRENT_DATE - $1::int`,
    note: 'reminder / quiz-trigger sends',
  },
  {
    table: 'job_queue',
    keepDays: 30,
    where: `status = 'done' AND completed_at < now() - ($1::int || ' days')::interval`,
    note: 'finished background jobs',
  },
];

/** Tables that must never be touched, with the reason, so nobody adds them later. */
const PROTECTED = {
  invoices: 'GST records — statutory retention, and invoice numbers must never be reused',
  gstr1_filing: 'filed GST returns',
  payments: 'financial record tied to Razorpay',
  parents: 'live customer',
  students: 'live customer',
  parents_quizpe_subscriptions: 'drives daily delivery',
  quiz_reports: 'parents can re-download old reports',
  question_bank: 'content, not transactional data',
};

async function ensureArchive(table) {
  // LIKE ... INCLUDING DEFAULTS copies the shape but NOT constraints, indexes
  // or identity — an archive must never fight the live table for sequences.
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${table}_archive (LIKE ${table} INCLUDING DEFAULTS)`);
  await db.query(
    `ALTER TABLE ${table}_archive ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT now()`);
}

async function run() {
  console.log(`\n${APPLY ? '📦 ARCHIVING' : '🔍 DRY RUN — nothing will move'}\n`);

  const before = (await db.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;
  console.log(`Database size now: ${before}\n`);

  let moved = 0;
  for (const step of PLAN) {
    const days = DAYS || step.keepDays;
    if (PROTECTED[step.table]) {                       // belt and braces
      console.log(`⛔ ${step.table} is protected — skipped (${PROTECTED[step.table]})`);
      continue;
    }

    const { rows: [c] } = await db.query(
      `SELECT COUNT(*)::int n FROM ${step.table} WHERE ${step.where}`, [days]);

    if (!c.n) {
      console.log(`✅ ${step.table.padEnd(28)} nothing older than ${days} days`);
      continue;
    }

    if (!APPLY) {
      console.log(`   ${step.table.padEnd(28)} ${String(c.n).padStart(8)} rows would move  (keep ${days}d) — ${step.note}`);
      moved += c.n;
      continue;
    }

    await ensureArchive(step.table);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // copy then delete in ONE transaction: a crash between the two would
      // otherwise either lose rows or duplicate them
      const ins = await client.query(
        `INSERT INTO ${step.table}_archive
         SELECT *, now() FROM ${step.table} WHERE ${step.where}`, [days]);
      const del = await client.query(
        `DELETE FROM ${step.table} WHERE ${step.where}`, [days]);
      if (ins.rowCount !== del.rowCount) throw new Error(
        `copied ${ins.rowCount} but deleted ${del.rowCount} — rolled back`);
      await client.query('COMMIT');
      console.log(`📦 ${step.table.padEnd(28)} ${String(del.rowCount).padStart(8)} rows archived`);
      moved += del.rowCount;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`❌ ${step.table}: ${e.message}`);
    } finally {
      client.release();
    }
  }

  if (APPLY && moved) {
    console.log('\nReclaiming space…');
    for (const s of PLAN) await db.query(`VACUUM ANALYZE ${s.table}`).catch(() => {});
    const after = (await db.query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;
    console.log(`Database size after: ${after}`);
  }

  console.log(`\n${APPLY ? `Done — ${moved} row(s) archived.` : `${moved} row(s) would move. Re-run with --apply.`}`);
  console.log('Primary keys and sequences are untouched by design — see the header of this file.\n');
  console.log('Never archived: ' + Object.keys(PROTECTED).join(', ') + '\n');

  await db.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
