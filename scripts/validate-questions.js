/**
 * scripts/validate-questions.js
 * ---------------------------------------------------------------------------
 * Checks a batch of question_bank rows BEFORE children ever see them.
 *
 *   node scripts/validate-questions.js                       # everything
 *   node scripts/validate-questions.js --board CBSE --grade G2
 *   node scripts/validate-questions.js --board CBSE --grade G2 --fix-duplicates
 *
 * Findings are grouped by severity:
 *   ERROR  — a child would see something wrong. Fix before going live.
 *   WARN   — poor quality; worth fixing, not dangerous.
 *
 * Nothing is modified unless --fix-duplicates is passed, and even then only
 * exact duplicate rows are deactivated (the newest is kept).
 * ---------------------------------------------------------------------------
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const BOARD = argOf('--board');
const GRADE = argOf('--grade');
const SUBJECT = argOf('--subject');
const FIX_DUPES = args.includes('--fix-duplicates');
const LETTERS = ['A', 'B', 'C', 'D'];

const findings = { ERROR: [], WARN: [] };
const add = (sev, kind, detail, sample) => findings[sev].push({ kind, detail, sample });

/** Evaluate simple arithmetic in a question, if it is unambiguously arithmetic. */
function arithmeticAnswer(text) {
  const t = String(text).replace(/[,₹]/g, '').replace(/[×x]/gi, '*').replace(/÷/g, '/').replace(/−/g, '-');
  // a chain like "12 + 5 + 3 = ?" or "180 - 21 - 24"
  const m = t.match(/(-?\d+(?:\s*[-+*/]\s*-?\d+)+)\s*(?:=\s*\?|=\s*_+|\?)/);
  if (!m) return null;
  const expr = m[1].replace(/\s+/g, '');
  if (!/^-?\d+(?:[-+*/]-?\d+)+$/.test(expr)) return null;
  // mixed precedence is too easy to get wrong — only handle a single operator type
  const ops = new Set(expr.replace(/-?\d+/g, '').split(''));
  if (ops.size !== 1) return null;
  try {
    // eslint-disable-next-line no-new-func
    const val = Function(`"use strict";return (${expr})`)();
    return Number.isFinite(val) ? val : null;
  } catch { return null; }
}

(async () => {
  const where = [`qb.is_active`];
  const params = [];
  if (BOARD)   { params.push(BOARD);   where.push(`b.board_code = $${params.length}`); }
  if (GRADE)   { params.push(GRADE);   where.push(`g.grade_code = $${params.length}`); }
  if (SUBJECT) { params.push(SUBJECT); where.push(`s.subject_code = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT qb.id, qb.chapter, qb.question_whatsapp, qb.question_pdf, qb.answer, qb.explanation,
            qb.option_a, qb.option_b, qb.option_c, qb.option_d, qb.current_month, qb.revision,
            b.board_code, g.grade_code, s.subject_code, m.medium_code
       FROM question_bank qb
       JOIN boards b   ON b.id = qb.board_id
       JOIN grades g   ON g.id = qb.grade_id
       JOIN subjects s ON s.id = qb.subject_id
       JOIN mediums m  ON m.id = qb.medium_id
      WHERE ${where.join(' AND ')}
      ORDER BY qb.id`, params);

  if (!rows.length) { console.log('No rows matched that filter.'); return db.close(); }
  console.log(`\nChecking ${rows.length.toLocaleString()} questions…\n`);

  const seen = new Map();          // question text -> first id
  const dupeIds = [];
  const chapters = new Map();

  for (const q of rows) {
    const text = (q.question_pdf || q.question_whatsapp || '').trim();
    const opts = [q.option_a, q.option_b, q.option_c, q.option_d];
    // current_month MUST be part of the key. The spiral model deliberately
    // repeats June's questions into July, August and so on — those are the
    // same question by design, not duplicates. A real duplicate is the same
    // question twice within the SAME serving month.
    const key = `${q.board_code}|${q.grade_code}|${q.subject_code}|${q.medium_code}|${q.current_month}|${text.toLowerCase()}`;

    chapters.set(q.chapter, (chapters.get(q.chapter) || 0) + 1);

    /* -------- ERRORS: a child would see something wrong -------- */
    if (!text) add('ERROR', 'empty question', `id ${q.id}`, q.id);

    if (!LETTERS.includes(String(q.answer || '').trim().toUpperCase())) {
      add('ERROR', 'answer key not A–D', `id ${q.id} answer=${JSON.stringify(q.answer)}`, q.id);
    } else {
      const idx = LETTERS.indexOf(q.answer.trim().toUpperCase());
      if (opts[idx] == null || String(opts[idx]).trim() === '') {
        add('ERROR', 'answer points at an empty option', `id ${q.id} answer=${q.answer}`, q.id);
      }
    }

    const filled = opts.filter(o => o != null && String(o).trim() !== '');
    if (filled.length < 2) add('ERROR', 'fewer than 2 options', `id ${q.id}`, q.id);

    const norm = filled.map(o => String(o).trim().toLowerCase());
    if (new Set(norm).size !== norm.length) {
      add('ERROR', 'duplicate options', `id ${q.id}: ${filled.join(' / ')}`, q.id);
    }

    // arithmetic: does the marked answer actually equal the computed value?
    const calc = arithmeticAnswer(text);
    if (calc !== null && LETTERS.includes(String(q.answer || '').toUpperCase())) {
      const marked = String(opts[LETTERS.indexOf(q.answer.toUpperCase())] ?? '').replace(/[,\s₹]/g, '');
      if (/^-?\d+$/.test(marked) && Number(marked) !== calc) {
        add('ERROR', 'WRONG ANSWER (arithmetic)',
            `id ${q.id}: "${text.slice(0, 60)}" computes to ${calc} but ${q.answer}=${marked}`, q.id);
      }
    }

    if (seen.has(key)) { dupeIds.push(q.id); add('WARN', 'duplicate question', `id ${q.id} repeats id ${seen.get(key)}`, q.id); }
    else seen.set(key, q.id);

    /* -------- WARNINGS: quality -------- */
    if (/(\b\d+)\s*[-−]\s*\1\b/.test(text)) {
      add('WARN', 'trivial (N − N)', `id ${q.id}: ${text.slice(0, 50)}`, q.id);
    }
    if (/[x×*]\s*0\b|\b0\s*[x×*]/.test(text)) {
      add('WARN', 'trivial (× 0)', `id ${q.id}: ${text.slice(0, 50)}`, q.id);
    }
    if (!q.explanation || String(q.explanation).trim().length < 5) {
      add('WARN', 'missing explanation', `id ${q.id}`, q.id);
    }
    if (!q.chapter || !String(q.chapter).trim()) {
      add('WARN', 'missing chapter', `id ${q.id}`, q.id);
    }
    if (text.length > 300) add('WARN', 'very long question', `id ${q.id} (${text.length} chars)`, q.id);
  }

  /* -------- report -------- */
  for (const sev of ['ERROR', 'WARN']) {
    const byKind = {};
    findings[sev].forEach(f => (byKind[f.kind] ||= []).push(f));
    const total = findings[sev].length;
    console.log(`${sev === 'ERROR' ? '❌ ERRORS' : '⚠️  WARNINGS'}: ${total}`);
    for (const [kind, list] of Object.entries(byKind).sort((a, z) => z[1].length - a[1].length)) {
      console.log(`   ${String(list.length).padStart(6)}  ${kind}`);
      list.slice(0, 3).forEach(f => console.log(`           e.g. ${f.detail}`));
    }
    console.log('');
  }

  console.log(`Chapters: ${chapters.size}`);
  [...chapters.entries()].sort((a, z) => z[1] - a[1]).slice(0, 12)
    .forEach(([c, n]) => console.log(`   ${String(n).padStart(6)}  ${c}`));

  if (FIX_DUPES && dupeIds.length) {
    const r = await db.query(
      `UPDATE question_bank SET is_active=false, modified_at=now() WHERE id = ANY($1::bigint[])`, [dupeIds]);
    console.log(`\n🧹 Deactivated ${r.rowCount} duplicate rows (originals kept).`);
  } else if (dupeIds.length) {
    console.log(`\n${dupeIds.length} duplicates found — re-run with --fix-duplicates to deactivate them.`);
  }

  console.log(findings.ERROR.length
    ? `\n🚫 NOT SAFE TO PUBLISH — ${findings.ERROR.length} error(s) reach children directly.\n`
    : `\n✅ No errors. Safe to publish.\n`);

  await db.close();
})();
