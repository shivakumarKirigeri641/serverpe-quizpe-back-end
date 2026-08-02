/**
 * scripts/enrich-questions.js
 * ---------------------------------------------------------------------------
 * Fixes the "it's repetitive and boring" problem in question_bank.
 *
 * Some chapters were bulk-generated from one or two sentence templates with
 * only the numbers swapped, so a child could receive ten questions that read
 * identically. This script adds genuinely different QUESTION SHAPES to those
 * chapters — a mix of computation, word problems, reverse problems, spotting
 * errors and comparisons — so a quiz feels like ten different questions.
 *
 * Two rules this file never breaks:
 *
 *   1. Every answer is COMPUTED from the numbers that were generated, never
 *      typed by hand. A wrong answer key is worse than a boring question, so
 *      correctness is structural rather than something to proofread.
 *   2. Every insert is REVERSIBLE. Ids are written to a JSON file, so a batch
 *      can be undone with --revert <file> if the questions read badly.
 *
 *   node scripts/enrich-questions.js                 dry run, all mapped
 *   node scripts/enrich-questions.js --topic=sets    dry run, one topic
 *   node scripts/enrich-questions.js --insert        write, save ids
 *   node scripts/enrich-questions.js --revert=x.json undo a batch
 * ---------------------------------------------------------------------------
 */

const db = require('../src/database/connectDB');
const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.some((a) => a === f || a.startsWith(f + '='));
const val = (f) => (ARGS.find((a) => a.startsWith(f + '=')) || '').split('=')[1] || '';

const INSERT = has('--insert');
const ONLY_TOPIC = val('--topic');
const ONLY_CHAPTER = val('--chapter');
const REVERT = val('--revert');
const PER_SHAPE = Number(val('--per') || 16);

/* ------------------------------------------------------------------ random */
/**
 * WhatsApp text -> PDF/web text: strip the leading emoji a PDF font can't draw,
 * but KEEP the maths. A blanket [^\x00-\x7F] strip (the old way) deleted ÷ × −
 * ⬜ too, turning "120 ÷ 4" into "120 4". See scripts/fix-pdf-symbols.js.
 */
const toPdf = (s) => String(s || '')
  .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')                       // pictographs
  .replace(/[\u{2600}-\u{27BF}]/gu, '')                         // ➗ ➕ ✖ ✅ dingbats
  .replace(/[\u{2190}-\u{21FF}]/gu, '')                         // arrows
  .replace(/[\u{2B00}-\u{2B1B}\u{2B1D}-\u{2BFF}]/gu, '')        // 2B emoji, keep ⬜
  .replace(/[︀-️‍]/g, '')                        // variation selectors, ZWJ
  .replace(/−/g, '-').replace(/⬜/g, '___')                     // PDF-unsafe glyphs -> text
  .replace(/[ \t]{2,}/g, ' ').trim();

const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = ri(0, i); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const fmt = (n) => Number(n).toLocaleString('en-IN');
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const lcm = (a, b) => Math.abs(a * b) / gcd(a, b);
const round2 = (n) => Math.round(n * 100) / 100;

/** Indian names and everyday objects, so word problems feel local, not generic. */
const NAMES = ['Aarav', 'Riya', 'Kabir', 'Sara', 'Dev', 'Ira', 'Vihaan', 'Zoya', 'Arjun', 'Meena',
  'Nisha', 'Tara', 'Ravi', 'Pari', 'Ishaan', 'Anaya', 'Rohit', 'Diya', 'Aditya', 'Kavya',
  'Manu', 'Sneha', 'Farhan', 'Ayesha', 'Vikram', 'Lakshmi'];
const THINGS = ['pencils', 'marbles', 'stickers', 'sweets', 'apples', 'books', 'laddoos', 'crayons',
  'beads', 'coins', 'mangoes', 'chocolates', 'erasers', 'bananas', 'balloons'];
const SPORTS = [['cricket', 'football'], ['chess', 'carrom'], ['badminton', 'kabaddi'],
  ['swimming', 'cycling'], ['tennis', 'hockey'], ['kho-kho', 'throwball']];
const PLACES = ['the market', 'school', 'the temple fair', 'the library', 'the bus stand', 'the park'];

/**
 * Builds four distinct options and reports which letter holds the answer.
 * Distractors are near-misses on purpose — an option list of 8 / 400 / 12 / 9
 * lets a child guess by size alone, which teaches nothing.
 */
function opts(correct, distractors = []) {
  const key = String(correct);
  const c = Number(correct);
  // If the answer is not negative, no distractor may be. A negative option
  // next to a positive answer is a free elimination — nobody picks −3 apples.
  // Values often carry a unit ("40 cm²"), so test the leading sign as text
  // rather than relying on Number(), which returns NaN for those.
  const isNeg = (v) => /^\s*[-−]/.test(String(v));
  const allowNeg = isNeg(key);
  const set = new Set([key]);
  for (const d of distractors) {
    if (set.size >= 4) break;
    if (d === '' || d == null || !isFinite(Number(d)) && typeof d !== 'string') continue;
    if (!allowNeg && isNeg(d)) continue;
    set.add(String(d));
  }
  let n = 1;
  while (set.size < 4) {                       // top up if distractors collided
    if (!isFinite(c)) { set.add(correct + '_' + n); n++; if (n > 40) break; continue; }
    for (const cand of [c + n, c - n]) {
      if (set.size >= 4) break;
      if (!allowNeg && cand < 0) continue;
      set.add(String(round2(cand)));
    }
    n++;
    if (n > 60) { while (set.size < 4) set.add(String(round2(c + 10 * set.size))); }
  }
  const arr = shuffle([...set]).slice(0, 4);
  if (!arr.includes(key)) { arr[0] = key; }
  const L = ['A', 'B', 'C', 'D'];
  const o = {};
  arr.forEach((v, i) => { o[L[i]] = v; });
  o.answer = L[arr.indexOf(key)];
  return o;
}

/** Plain true/false-ish option set for "spot the mistake" shapes. */
function yesNo(isYes, yes = 'Yes', no = 'No', a = 'Only sometimes', b = 'Cannot be decided') {
  const arr = shuffle([yes, no, a, b]);
  const L = ['A', 'B', 'C', 'D'];
  const o = {};
  arr.forEach((v, i) => { o[L[i]] = v; });
  o.answer = L[arr.indexOf(isYes ? yes : no)];
  return o;
}

/**
 * Choose-the-right-statement shapes: one true line among false ones.
 *
 * The wrong options are built by rearranging the right one, so they can
 * collide with it or with each other — "3 3/4" scrambles to "3 3/4" when two
 * of the numbers happen to match. Returns null rather than ship a question
 * with a repeated option; the caller simply generates another.
 */
function among(correctText, wrongTexts) {
  const right = String(correctText);
  const wrong = [];
  for (const w of wrongTexts) {
    const s = String(w);
    if (s === right || wrong.includes(s) || !s.trim()) continue;
    wrong.push(s);
    if (wrong.length === 3) break;
  }
  if (wrong.length < 3) return null;
  const arr = shuffle([right, ...wrong]);
  const L = ['A', 'B', 'C', 'D'];
  const o = {};
  arr.forEach((v, i) => { o[L[i]] = v; });
  o.answer = L[arr.indexOf(right)];
  return o;
}

const near = (x) => {
  const n = Number(x);
  if (!isFinite(n)) return [];
  const step = Math.abs(n) >= 100 ? 10 : 1;
  return [n + step, n - step, n + 2 * step, n - 2 * step, n + 1, n - 1].map(round2);
};

/** Fraction helpers — reduced form, printed the way a child writes it. */
const red = (n, d) => { const g = gcd(n, d) || 1; return [n / g, d / g]; };
const F = (n, d) => { const [a, b] = red(n, d); return b === 1 ? String(a) : `${a}/${b}`; };

module.exports = { ri, pick, shuffle, opts, yesNo, among, near, F, red, fmt, gcd, lcm, round2,
  NAMES, THINGS, SPORTS, PLACES };

/* ===========================================================================
 * Everything below runs only when this file is executed directly, so the
 * topic files can require the helpers above without triggering the run.
 * ========================================================================= */
if (require.main !== module) return;

const TOPICS = {
  ...require('./enrich-topics-number.js'),
  ...require('./enrich-topics-algebra.js'),
  ...require('./enrich-topics-geometry.js'),
  ...require('./enrich-topics-extra.js'),
};
const MAP = require('./enrich-map.js');

const OUT_DIR = path.join(__dirname, '..', 'tmp');
const gradeNum = (name) => Number(String(name).replace(/\D/g, '')) || 5;

/* ----------------------------------------------------------------- revert */
async function revert(file) {
  const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(ids) || !ids.length) { console.log('Nothing to revert.'); return; }
  const { rows: [{ n }] } = await db.query(
    `SELECT COUNT(*)::int n FROM question_bank WHERE id = ANY($1)`, [ids]);
  console.log(`Reverting ${file}: ${ids.length} recorded id(s), ${n} still present.`);
  // Answered questions are referenced by student history, so deactivate rather
  // than delete — a report must never lose the question it was built from.
  const used = await db.query(
    `SELECT COUNT(DISTINCT question_id)::int n FROM student_quizpe_histories WHERE question_id = ANY($1)`, [ids]);
  if (used.rows[0].n > 0) {
    await db.query(`UPDATE question_bank SET is_active = false WHERE id = ANY($1)`, [ids]);
    console.log(`  ${used.rows[0].n} have been served to students — deactivated, not deleted.`);
  } else {
    const r = await db.query(`DELETE FROM question_bank WHERE id = ANY($1)`, [ids]);
    console.log(`  Deleted ${r.rowCount} row(s). None had been served.`);
  }
}

/* ------------------------------------------------------- generate one chapter */
function build(topicNames, G, existing, want) {
  const shapes = topicNames.flatMap((t) => (TOPICS[t] || []).map((fn) => ({ t, fn })));
  if (!shapes.length) return { rows: [], shapes: 0 };
  const seen = new Set();
  const rows = [];
  for (const { t, fn } of shapes) {
    let made = 0;
    for (let tries = 0; made < want && tries < want * 40; tries++) {
      let q;
      try { q = fn(G); } catch { continue; }
      if (!q || !q.wa || !q.o) continue;
      const key = q.wa.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key) || existing.has(key)) continue;
      const vals = [q.o.A, q.o.B, q.o.C, q.o.D];
      if (vals.some((v) => v == null || String(v).trim() === '')) continue;
      if (new Set(vals.map((v) => String(v).trim().toLowerCase())).size !== 4) continue;
      if (!['A', 'B', 'C', 'D'].includes(q.o.answer)) continue;
      if (!q.exp || !String(q.exp).trim()) continue;
      seen.add(key);
      rows.push({ ...q, topic: t, pdf: toPdf(q.wa) });
      made++;
    }
  }
  return { rows, shapes: shapes.length };
}

/* --------------------------------------------------------------------- main */
(async () => {
  if (REVERT) { await revert(REVERT); process.exit(0); }

  const SIG = "left(regexp_replace(lower(qb.question_whatsapp),'[^a-z]','','g'),24)";
  const { rows: thin } = await db.query(`
    SELECT s.bc, g.grade_name, s.chapter, s.q, s.shapes
      FROM (SELECT b.board_code bc, qb.grade_id gid, qb.chapter,
                   count(*)::int q, count(DISTINCT ${SIG})::int shapes
              FROM question_bank qb JOIN boards b ON b.id = qb.board_id
             WHERE qb.is_active AND qb.revision = qb.current_month
             GROUP BY 1,2,3) s
      JOIN grades g ON g.id = s.gid
     WHERE s.shapes < 8
     ORDER BY g.display_order, s.chapter, s.bc`);

  // One build per board+grade+chapter, but the same chapter name in the same
  // grade across boards can share generated text — so key the cache by both.
  const unmapped = new Set();
  const targets = [];
  for (const t of thin) {
    const topics = MAP[t.chapter];
    if (!topics) { unmapped.add(t.chapter); continue; }
    if (ONLY_TOPIC && !topics.includes(ONLY_TOPIC)) continue;
    if (ONLY_CHAPTER && t.chapter !== ONLY_CHAPTER) continue;
    targets.push({ ...t, topics, G: gradeNum(t.grade_name) });
  }

  if (unmapped.size) {
    console.log(`\n⚠️  ${unmapped.size} chapter(s) have no topic mapping and will be skipped:`);
    [...unmapped].sort().forEach((c) => console.log('    ' + c));
  }
  if (!targets.length) { console.log('\nNothing to do.'); process.exit(0); }

  console.log(`\nEnriching ${targets.length} chapter instance(s)...\n`);

  const built = [];
  for (const t of targets) {
    const existing = new Set((await db.query(
      `SELECT lower(regexp_replace(qb.question_whatsapp, '\\s+', ' ', 'g')) k
         FROM question_bank qb
         JOIN grades g ON g.id = qb.grade_id
         JOIN boards b ON b.id = qb.board_id
        WHERE g.grade_name = $1 AND b.board_code = $2 AND qb.chapter = $3`,
      [t.grade_name, t.bc, t.chapter])).rows.map((r) => r.k.trim()));
    const { rows, shapes } = build(t.topics, t.G, existing, PER_SHAPE);
    built.push({ ...t, rows, shapeCount: shapes });
  }

  console.table(built.map((b) => ({
    board: b.bc, grade: b.grade_name.replace('Grade ', 'G'),
    chapter: b.chapter.slice(0, 34), was: b.shapes,
    new_shapes: b.shapeCount, generated: b.rows.length,
  })).slice(0, 40));
  if (built.length > 40) console.log(`  ... and ${built.length - 40} more`);

  const total = built.reduce((a, b) => a + b.rows.length, 0);
  const empty = built.filter((b) => !b.rows.length);
  console.log(`\nTotal generated: ${total.toLocaleString('en-IN')} question(s)`);
  if (empty.length) console.log(`⚠️  ${empty.length} chapter(s) produced nothing — check their topic mapping.`);

  /* One worked sample per topic, so the wording gets read before it ships. */
  const bySample = {};
  for (const b of built) for (const r of b.rows) if (!bySample[r.topic]) bySample[r.topic] = r;
  console.log('\n--- one sample per topic ---');
  for (const [t, r] of Object.entries(bySample)) {
    console.log(`\n[${t}] ${r.wa.replace(/\n/g, ' ')}`);
    console.log(`   A) ${r.o.A}   B) ${r.o.B}   C) ${r.o.C}   D) ${r.o.D}   ✔ ${r.o.answer}`);
    console.log(`   why: ${r.exp}`);
  }

  if (!INSERT) { console.log('\nDRY RUN — nothing written. Add --insert to apply.'); process.exit(0); }

  /* ------------------------------------------------------------------ write */
  const client = await db.getClient();
  const ids = [];
  try {
    await client.query('BEGIN');
    for (const b of built) {
      if (!b.rows.length) continue;
      // Copy the classification of the rows already in this chapter so the new
      // questions land in the same subject, medium, year and serving month.
      const { rows: [tgt] } = await client.query(
        `SELECT qb.board_id, qb.grade_id, qb.subject_id, qb.medium_id,
                qb.academic_year, qb.current_month, COUNT(*) n
           FROM question_bank qb
           JOIN grades g ON g.id = qb.grade_id
           JOIN boards b ON b.id = qb.board_id
          WHERE g.grade_name = $1 AND b.board_code = $2 AND qb.chapter = $3
            AND qb.is_active AND qb.revision = qb.current_month
          GROUP BY 1,2,3,4,5,6 ORDER BY n DESC LIMIT 1`,
        [b.grade_name, b.bc, b.chapter]);
      if (!tgt) { console.log(`  skipped ${b.bc} ${b.grade_name} ${b.chapter} — no target row`); continue; }

      for (const r of b.rows) {
        const res = await client.query(
          `INSERT INTO question_bank (board_id, grade_id, subject_id, medium_id, academic_year,
             current_month, revision, chapter, question_whatsapp, question_pdf,
             option_a, option_b, option_c, option_d, answer, explanation, question_type, is_active)
           VALUES ($1,$2,$3,$4,$5,$6::smallint,$7::smallint,$8,$9,$10,$11,$12,$13,$14,$15,$16,'mcq',true)
           RETURNING id`,
          [tgt.board_id, tgt.grade_id, tgt.subject_id, tgt.medium_id, tgt.academic_year,
           tgt.current_month, tgt.current_month, b.chapter, r.wa, r.pdf,
           String(r.o.A), String(r.o.B), String(r.o.C), String(r.o.D), r.o.answer, r.exp]);
        ids.push(res.rows[0].id);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally { client.release(); }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `enrich-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(ids));
  console.log(`\n✅ Inserted ${ids.length.toLocaleString('en-IN')} question(s).`);
  console.log(`   Reversible: node scripts/enrich-questions.js --revert=${file}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
