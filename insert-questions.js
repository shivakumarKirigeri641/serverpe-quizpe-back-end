/**
 * insert-questions.js
 * ---------------------------------------------------------------------------
 * Bulk-loads the Grade-1 CBSE Maths MCQ bank into the existing PostgreSQL
 * table `question_bank` (DB creds read from .env via PG* env vars).
 *
 * Inserts ALL monthly rows (new + spiral-revision) = 28,235 rows.
 * The table is TRUNCATEd first so the load is idempotent (re-runnable).
 *
 * Column mapping:
 *   board_id/grade_id/subject_id = 1/1/1
 *   academic_year   = 2026            (start year of 2026-2027 session)
 *   current_month   = serving month  (6..12,1..3)
 *   chapter         = chapter title
 *   question_whatsapp = emoji question   | question_pdf = plain question
 *   option_a..d     = the four options
 *   answer          = correct option LETTER (A/B/C/D)
 *   explanation     = explanation
 *   question_type   = 'mcq'
 *   revision        = ORIGIN month number of the question
 *
 * USAGE
 *   npm install pg dotenv
 *   node insert-questions.js
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const JSON_FILE = path.join(__dirname, 'quiz-cbse-grade1-maths.json');
const ACADEMIC_YEAR = 2026;
const BATCH_ROWS = 1000;

// chapter number -> ORIGIN calendar month
const CH_MONTH = { 1: 6, 2: 7, 3: 7, 4: 8, 5: 8, 6: 9, 7: 10, 8: 11, 9: 12, 10: 1, 11: 2, 12: 3 };
const LETTERS = ['A', 'B', 'C', 'D'];

const COLS = [
  'board_id', 'grade_id', 'subject_id', 'academic_year', 'current_month', 'chapter',
  'question_whatsapp', 'question_pdf', 'option_a', 'option_b', 'option_c', 'option_d',
  'answer', 'explanation', 'question_type', 'revision',
];

function buildRows() {
  const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  const rows = [];
  for (const m of data.months) {
    for (const q of m.questions) {
      const o = q.options;
      const idx = o.indexOf(q.answer);
      if (idx < 0) throw new Error(`answer not in options for ${q.id}`);
      rows.push([
        1, 1, 1, ACADEMIC_YEAR, q.current_month, q.chapterTitle,
        q.question, q.questionPlain,
        o[0], o[1], o[2] ?? null, o[3] ?? null,
        LETTERS[idx], q.explanation ?? null, 'mcq', CH_MONTH[q.chapter],
      ]);
    }
  }
  return rows;
}

async function main() {
  const rows = buildRows();
  console.log(`Prepared ${rows.length} rows from ${path.basename(JSON_FILE)}`);

  const pool = new Pool(); // reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT from env
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE question_bank RESTART IDENTITY;');

    const nCols = COLS.length;
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const batch = rows.slice(i, i + BATCH_ROWS);
      const values = [];
      const tuples = batch.map((r, bi) => {
        const ph = r.map((_, ci) => `$${bi * nCols + ci + 1}`);
        values.push(...r);
        return `(${ph.join(',')})`;
      });
      await client.query(
        `INSERT INTO question_bank (${COLS.join(',')}) VALUES ${tuples.join(',')}`,
        values,
      );
      done += batch.length;
      process.stdout.write(`\rInserted ${done}/${rows.length}`);
    }
    process.stdout.write('\n');
    await client.query('COMMIT');

    const { rows: [{ count }] } = await client.query('SELECT COUNT(*) FROM question_bank');
    console.log(`Committed. question_bank now has ${count} rows.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
