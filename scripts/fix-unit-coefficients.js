/**
 * scripts/fix-unit-coefficients.js
 * ---------------------------------------------------------------------------
 * Removes the written-out coefficient of 1 from algebra text: "1x" -> "x".
 *
 * Nobody writes 1x. A child copying "f(x) = 1x + 4" into a notebook learns a
 * form no textbook or exam paper uses, so this is worth correcting across the
 * bank rather than only in new content.
 *
 * The match is deliberately narrow, because a careless replace here would
 * corrupt real numbers:
 *
 *   11x   must NOT become 1x     (the 1 is preceded by a digit)
 *   0.1x  must NOT become 0.x    (preceded by a decimal point)
 *   1st   must NOT be touched    ('s' is not an algebra variable)
 *   1kg   must NOT be touched    (a letter follows the unit letter)
 *   -1x   SHOULD become -x
 *
 * So: a 1 not preceded by a digit or dot, followed by exactly one variable
 * letter, with no further letter after it.
 *
 *   node scripts/fix-unit-coefficients.js           dry run
 *   node scripts/fix-unit-coefficients.js --apply   write, with a backup
 *   node scripts/fix-unit-coefficients.js --revert=<file>
 * ---------------------------------------------------------------------------
 */

const db = require('../src/database/connectDB');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const REVERT = (process.argv.find((a) => a.startsWith('--revert=')) || '').split('=')[1];

const FIELDS = ['question_whatsapp', 'question_pdf', 'explanation',
  'option_a', 'option_b', 'option_c', 'option_d'];

// One variable letter only, and only the letters actually used as variables.
const RE = /(^|[^0-9.])1([xyznabpq])(?![a-zA-Z])/g;

const fix = (s) => (s == null ? s : String(s).replace(RE, '$1$2'));

async function revert(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      await c.query(
        `UPDATE question_bank SET question_whatsapp=$2, question_pdf=$3, explanation=$4,
                option_a=$5, option_b=$6, option_c=$7, option_d=$8 WHERE id=$1`,
        [r.id, ...FIELDS.map((f) => r[f])]);
    }
    await c.query('COMMIT');
    console.log(`Reverted ${rows.length} row(s) from ${file}`);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

(async () => {
  if (REVERT) { await revert(REVERT); process.exit(0); }

  // Narrow with LIKE first so this does not read the whole million-row table.
  const like = FIELDS.flatMap((f) => ['x', 'y', 'z', 'n', 'a', 'b', 'p', 'q']
    .map((v) => `${f} LIKE '%1${v}%'`)).join(' OR ');
  const { rows } = await db.query(
    `SELECT id, ${FIELDS.join(', ')} FROM question_bank WHERE is_active AND (${like})`);

  const changed = [];
  for (const r of rows) {
    const patch = {};
    let any = false;
    for (const f of FIELDS) {
      const before = r[f];
      const after = fix(before);
      if (after !== before) { patch[f] = after; any = true; }
    }
    if (any) changed.push({ row: r, patch });
  }

  console.log(`scanned : ${rows.length.toLocaleString('en-IN')} candidate rows`);
  console.log(`to fix  : ${changed.length.toLocaleString('en-IN')}`);

  // Safety net: prove the narrow cases really are left alone.
  const guards = [
    ['11x + 2', '11x + 2'], ['0.1x', '0.1x'], ['1st place', '1st place'],
    ['1kg', '1kg'], ['f(x) = 1x + 4', 'f(x) = x + 4'], ['−1x', '−x'],
    ['21y − 1y', '21y − y'], ['1n + 1', 'n + 1'], ['101a', '101a'],
  ];
  console.log('\nguard cases:');
  let bad = 0;
  for (const [inp, want] of guards) {
    const got = fix(inp);
    if (got !== want) bad++;
    console.log(`  ${got === want ? 'ok  ' : 'FAIL'} ${JSON.stringify(inp)} -> ${JSON.stringify(got)}`);
  }
  if (bad) { console.error('\nGuard cases failed — refusing to write.'); process.exit(1); }

  console.log('\nsamples:');
  for (const { row, patch } of changed.slice(0, 6)) {
    const f = Object.keys(patch)[0];
    console.log(`  - ${String(row[f]).replace(/\n/g, ' ').slice(0, 66)}`);
    console.log(`  + ${String(patch[f]).replace(/\n/g, ' ').slice(0, 66)}`);
  }

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply.'); process.exit(0); }

  const dir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `coeff-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(changed.map(({ row }) => row)));

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    for (const { row, patch } of changed) {
      const keys = Object.keys(patch);
      await c.query(
        `UPDATE question_bank SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, modified_at=now()
          WHERE id=$1`, [row.id, ...keys.map((k) => patch[k])]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); console.error('FAILED:', e.message); process.exit(1); }
  finally { c.release(); }

  console.log(`\nFixed ${changed.length.toLocaleString('en-IN')} row(s).`);
  console.log(`Backup: ${backup}`);
  console.log(`Revert: node scripts/fix-unit-coefficients.js --revert=${backup}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
