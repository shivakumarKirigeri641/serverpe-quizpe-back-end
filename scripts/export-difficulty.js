/**
 * scripts/export-difficulty.js
 * ---------------------------------------------------------------------------
 * Carry the hand-assigned difficulty levels from the development database to
 * production, WITHOUT trusting question ids.
 *
 * WHY NOT ids. The two databases look like they share an id space — same row
 * count order, same id range — but they do not. Comparing a 1-in-97 sample of
 * question_bank across both, 25 of 10,432 ids (0.24%) hold DIFFERENT questions.
 * Shipping `id -> level` would therefore mislabel roughly 2,500 questions, and
 * nothing downstream would ever notice: a hard question tagged easy simply
 * turns up in the wrong quiz, forever, silently.
 *
 * WHAT IS USED INSTEAD. A fingerprint of what actually identifies a question:
 * its full scope (board, grade, subject, medium, year, month, chapter) plus its
 * text, options and answer. On 1,028,123 development rows that key produces
 * ZERO cases of one key carrying two different levels, so it is safe to apply
 * as an equality join. Where the same question legitimately appears in two
 * scopes — and 326,000 of them do — each copy keeps its own level, which
 * hashing the text alone would have destroyed (12,906 texts carry different
 * levels in different grades).
 *
 *   node scripts/export-difficulty.js
 *
 * Writes src/temp/difficulty-YYYY-MM-DD.tsv.gz. Run it against the DEVELOPMENT
 * database (the one holding the assignments); apply it with
 * scripts/apply-difficulty.js on the server.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../src/database/connectDB');

/* The identity of a question, as text. Kept in ONE place because the apply
   script must compute it identically — a difference of one separator here
   would match nothing there, and the failure would look like "no rows". */
const KEY_SQL = `md5(
    board_id || ':' || grade_id || ':' || subject_id || ':' || medium_id || ':' ||
    academic_year || ':' || current_month || ':' || chapter || ':' ||
    question_whatsapp || ':' || option_a || ':' || coalesce(option_b,'') || ':' ||
    coalesce(option_c,'') || ':' || coalesce(option_d,'') || ':' || answer)`;

const OUT = path.join(__dirname, '..', 'src', 'temp',
  `difficulty-${new Date().toISOString().slice(0, 10)}.tsv.gz`);

(async () => {
  const conflicts = (await db.query(
    `SELECT count(*)::int n FROM (
       SELECT ${KEY_SQL} k FROM question_bank
        GROUP BY 1 HAVING count(DISTINCT difficulty_level) > 1) x`)).rows[0].n;
  if (conflicts > 0) {
    console.error(`REFUSING: ${conflicts} keys carry more than one difficulty level.`);
    console.error('The key is not unique in this database, so the export would be ambiguous.');
    process.exit(1);
  }

  const { rows } = await db.query(
    `SELECT DISTINCT ${KEY_SQL} AS k, difficulty_level AS lvl FROM question_bank`);

  const gz = zlib.createGzip();
  const out = fs.createWriteStream(OUT);
  gz.pipe(out);
  for (const r of rows) gz.write(`${r.k}\t${r.lvl}\n`);
  gz.end();
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });

  const dist = (await db.query(
    `SELECT difficulty_level lvl, count(*)::int n FROM question_bank GROUP BY 1 ORDER BY 1`)).rows;
  console.log(`\n  ${rows.length.toLocaleString()} distinct question keys exported`);
  for (const d of dist) console.log(`    level ${d.lvl}: ${d.n.toLocaleString()} rows here`);
  console.log(`\n  -> ${OUT}`);
  console.log(`     (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)\n`);
  process.exit(0);
})().catch((e) => { console.error('export failed:', e.message); process.exit(1); });
