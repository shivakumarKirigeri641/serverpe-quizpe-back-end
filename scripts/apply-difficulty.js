/**
 * scripts/apply-difficulty.js
 * ---------------------------------------------------------------------------
 * Load the exported difficulty levels into THIS database (whatever .env points
 * at). Safe to run more than once; safe to interrupt and re-run.
 *
 *   node scripts/apply-difficulty.js src/temp/difficulty-2026-09-24.tsv.gz
 *   node scripts/apply-difficulty.js <file> --check    report, change nothing
 *
 * It works grade by grade rather than in one statement over a million rows, so
 * no single transaction holds locks on question_bank for long. Reads of that
 * table are what serve quizzes; a parent tapping "Start quiz" during the load
 * must not wait behind it.
 *
 * Rows the file does not mention keep the DEFAULT of 2 that the migration gave
 * them. That is the deliberate fallback: level 2 is the middle band, which is
 * what the unfiltered selection already behaved like, so an unmatched question
 * behaves exactly as it does today rather than disappearing from every quiz.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const db = require('../src/database/connectDB');

/* MUST match scripts/export-difficulty.js exactly. */
const KEY_SQL = `md5(
    board_id || ':' || grade_id || ':' || subject_id || ':' || medium_id || ':' ||
    academic_year || ':' || current_month || ':' || chapter || ':' ||
    question_whatsapp || ':' || option_a || ':' || coalesce(option_b,'') || ':' ||
    coalesce(option_c,'') || ':' || coalesce(option_d,'') || ':' || answer)`;

const FILE = process.argv[2];
const CHECK = process.argv.includes('--check');

(async () => {
  if (!FILE || !fs.existsSync(FILE)) {
    console.error('usage: node scripts/apply-difficulty.js <difficulty-*.tsv.gz> [--check]');
    process.exit(1);
  }

  const col = (await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name='question_bank' AND column_name='difficulty_level'`)).rowCount;
  if (!col) {
    console.error('question_bank.difficulty_level does not exist — run: node scripts/migrate.js');
    process.exit(1);
  }

  console.log('\n  reading the export...');
  const pairs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(FILE).pipe(zlib.createGunzip()) });
  for await (const line of rl) {
    if (!line) continue;
    const [k, lvl] = line.split('\t');
    if (k && lvl) pairs.push([k, Number(lvl)]);
  }
  console.log(`  ${pairs.length.toLocaleString()} keys in the file`);

  /* A staging table, not a TEMP table: the work is split across several
     transactions (one per grade), and a TEMP table would not survive them on a
     pooled connection that hands out a different backend each time. */
  await db.query(`CREATE TABLE IF NOT EXISTS difficulty_import (
                    k char(32) PRIMARY KEY, lvl smallint NOT NULL)`);
  await db.query('TRUNCATE difficulty_import');

  const CHUNK = 5000;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const slice = pairs.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO difficulty_import (k, lvl)
       SELECT * FROM unnest($1::char(32)[], $2::smallint[]) ON CONFLICT (k) DO NOTHING`,
      [slice.map((p) => p[0]), slice.map((p) => p[1])]);
    process.stdout.write(`\r  staged ${Math.min(i + CHUNK, pairs.length).toLocaleString()} / ${pairs.length.toLocaleString()}`);
  }
  console.log('');

  const before = (await db.query(
    `SELECT difficulty_level lvl, count(*)::int n FROM question_bank GROUP BY 1 ORDER BY 1`)).rows;
  console.log(`  before: ${before.map((r) => `L${r.lvl}=${r.n.toLocaleString()}`).join('  ')}`);

  const wouldChange = (await db.query(
    `SELECT count(*)::int n FROM question_bank qb
       JOIN difficulty_import d ON d.k = ${KEY_SQL}
      WHERE qb.difficulty_level IS DISTINCT FROM d.lvl`)).rows[0].n;
  console.log(`  ${wouldChange.toLocaleString()} rows would change`);

  if (CHECK) { console.log('\n  --check: nothing written.\n'); process.exit(0); }

  const grades = (await db.query(
    `SELECT DISTINCT grade_id FROM question_bank ORDER BY grade_id`)).rows.map((r) => r.grade_id);
  let touched = 0;
  for (const g of grades) {
    const r = await db.query(
      `UPDATE question_bank qb SET difficulty_level = d.lvl, modified_at = now()
         FROM difficulty_import d
        WHERE qb.grade_id = $1 AND d.k = ${KEY_SQL}
          AND qb.difficulty_level IS DISTINCT FROM d.lvl`, [g]);
    touched += r.rowCount;
    console.log(`  grade ${g}: ${r.rowCount.toLocaleString()} updated`);
  }

  const after = (await db.query(
    `SELECT difficulty_level lvl, count(*)::int n FROM question_bank GROUP BY 1 ORDER BY 1`)).rows;
  const unmatched = (await db.query(
    `SELECT count(*)::int n FROM question_bank qb
      WHERE NOT EXISTS (SELECT 1 FROM difficulty_import d WHERE d.k = ${KEY_SQL})`)).rows[0].n;

  console.log(`\n  after:  ${after.map((r) => `L${r.lvl}=${r.n.toLocaleString()}`).join('  ')}`);
  console.log(`  ${touched.toLocaleString()} rows updated, ${unmatched.toLocaleString()} not in the file (left at their current level)`);
  console.log('\n  The staging table difficulty_import can be dropped once this looks right:');
  console.log('    DROP TABLE difficulty_import;\n');
  process.exit(0);
})().catch((e) => { console.error('\napply failed:', e.message); process.exit(1); });
