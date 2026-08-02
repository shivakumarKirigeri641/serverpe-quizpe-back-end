/**
 * scripts/fix-pdf-symbols.js
 * ---------------------------------------------------------------------------
 * Rebuilds question_pdf so it keeps the MATHS, not just the ASCII.
 *
 * The enrichment generator derived question_pdf as
 *     question_whatsapp.replace(/[^\x00-\x7F]/g, '')
 * to drop the leading emoji (🔢, ✖️ …) that a PDF font cannot render. But that
 * blanket strip also deleted ÷, ×, the − minus sign and the ⬜ blank — so
 * "120 ÷ 4 = 30" became "120 4 = 30" on the web quiz and in the report.
 *
 * This rederives question_pdf: emoji removed, maths kept. ÷ × ² ³ ° etc. are
 * Latin-1 / basic and render fine; the two that some PDF fonts miss are mapped
 * to safe text (− → -, ⬜ → ___).
 *
 *   node scripts/fix-pdf-symbols.js            dry run
 *   node scripts/fix-pdf-symbols.js --apply    write, with a reversible backup
 *   node scripts/fix-pdf-symbols.js --revert=<file>
 * ---------------------------------------------------------------------------
 */

const db = require('../src/database/connectDB');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const REVERT = (process.argv.find((a) => a.startsWith('--revert=')) || '').split('=')[1];

/**
 * question_whatsapp -> question_pdf: strip emoji, keep the maths.
 *
 * Emoji live in a few well-known blocks. The maths operators (÷ × − √ ≤ ≥ ² ³
 * ∠ ° π …) sit in the Latin-1 and Mathematical-Operators blocks, which are NOT
 * touched — except the two that render unreliably in PDF, mapped to plain text.
 */
function toPdf(s) {
  return String(s || '')
    // pictographic emoji
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    // misc symbols & dingbats: ➗ ➕ ➖ ✖ ✅ ❌ 🔺(most) 🎯 …
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // arrows ⬅ ➡ (kept out of the maths; questions don't rely on them)
    .replace(/[\u{2190}-\u{21FF}]/gu, '')
    // the 2B block is emoji EXCEPT ⬜ (U+2B1C), which is a real "fill the blank"
    .replace(/[\u{2B00}-\u{2B1B}\u{2B1D}-\u{2BFF}]/gu, '')
    .replace(/[︀-️‍]/g, '')      // variation selectors + ZWJ
    // the two maths glyphs some PDF fonts lack -> safe text
    .replace(/−/g, '-')                    // minus sign − -> hyphen
    .replace(/⬜/g, '___')                  // ⬜ blank -> ___
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function revert(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      await c.query(`UPDATE question_bank SET question_pdf=$2 WHERE id=$1`, [r.id, r.question_pdf]);
    }
    await c.query('COMMIT');
    console.log(`Reverted ${rows.length} rows from ${file}`);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

(async () => {
  if (REVERT) { await revert(REVERT); process.exit(0); }

  // Only rows whose pdf is actually missing a symbol its whatsapp text has.
  const { rows } = await db.query(
    `SELECT id, question_whatsapp, question_pdf
       FROM question_bank
      WHERE is_active
        AND (question_whatsapp LIKE '%÷%' OR question_whatsapp LIKE '%×%'
             OR question_whatsapp LIKE '%−%' OR question_whatsapp LIKE '%⬜%'
             OR question_whatsapp LIKE '%√%' OR question_whatsapp LIKE '%≤%'
             OR question_whatsapp LIKE '%≥%')`);

  // Only fix a row when the CONTENT differs, not merely the spacing. Most
  // original questions already carry ÷ × and only differ from toPdf by a space
  // ("=?" vs "= ?"); rewriting 70k rows for that is noise and risk. Comparing
  // with whitespace removed isolates the real defect: a symbol that is missing.
  const bare = (s) => String(s || '').replace(/\s+/g, '');
  const changed = [];
  for (const r of rows) {
    const next = toPdf(r.question_whatsapp);
    if (bare(next) !== bare(r.question_pdf)) changed.push({ id: r.id, question_pdf: r.question_pdf, next });
  }

  console.log(`candidate rows : ${rows.length.toLocaleString('en-IN')}`);
  console.log(`to fix         : ${changed.length.toLocaleString('en-IN')}`);
  console.log('\nsamples:');
  for (const c of changed.slice(0, 8)) {
    console.log(`  - ${String(c.question_pdf).slice(0, 52)}`);
    console.log(`  + ${String(c.next).slice(0, 52)}`);
  }

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply.'); process.exit(0); }

  const dir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `pdf-symbols-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(changed.map((c) => ({ id: c.id, question_pdf: c.question_pdf }))));

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    for (const ch of changed) {
      await c.query(`UPDATE question_bank SET question_pdf=$2, modified_at=now() WHERE id=$1`, [ch.id, ch.next]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); console.error('FAILED:', e.message); process.exit(1); }
  finally { c.release(); }

  console.log(`\nFixed ${changed.length.toLocaleString('en-IN')} rows.`);
  console.log(`Backup: ${backup}`);
  console.log(`Revert: node scripts/fix-pdf-symbols.js --revert=${backup}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
