/**
 * src/admin/questionRoutes.js
 * ---------------------------------------------------------------------------
 * question_bank grid + CRUD, and the Excel import pipeline.
 *
 * IMPORT DESIGN
 * The admin picks board / grade / medium / subject / month once; the sheet
 * carries only the question data. Foreign keys are resolved here, so nobody
 * has to know an id.
 *
 * DUPLICATE DETECTION — the important part.
 * QuizPe's spiral model deliberately repeats June's questions into July,
 * August and so on. Those rows are identical apart from `current_month`, and
 * they are correct. So a duplicate means the same question text within the
 * SAME board/grade/subject/medium AND the same serving month. Matching on
 * text alone would flag thousands of legitimate spiral rows — that mistake was
 * made once already during a content audit and would have destroyed the
 * revision model.
 *
 * Nothing is written by /preview. The admin sees exactly what will happen
 * first, then calls /commit.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');
const { requireAdmin } = require('./auth');

const router = express.Router();
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const clamp = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);
const LETTERS = ['A', 'B', 'C', 'D'];

/* ------------------------------------------------------------------- grid */
router.get('/questions', requireAdmin, async (req, res) => {
  const limit = clamp(req.query.limit, 50, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { board, grade, subject, medium, chapter, month } = req.query;
  const q = String(req.query.q || '').trim();

  try {
    const { rows } = await db.query(
      `SELECT qb.id, qb.chapter, qb.question_pdf, qb.question_whatsapp,
              qb.option_a, qb.option_b, qb.option_c, qb.option_d, qb.answer,
              qb.explanation, qb.question_type, qb.revision, qb.current_month,
              qb.academic_year, qb.is_active,
              b.board_code, g.grade_code, s.subject_code, m.medium_code,
              COUNT(*) OVER()::int AS total
         FROM question_bank qb
         JOIN boards b   ON b.id = qb.board_id
         JOIN grades g   ON g.id = qb.grade_id
         JOIN subjects s ON s.id = qb.subject_id
         JOIN mediums m  ON m.id = qb.medium_id
        WHERE ($1::text IS NULL OR b.board_code   = $1)
          AND ($2::text IS NULL OR g.grade_code   = $2)
          AND ($3::text IS NULL OR s.subject_code = $3)
          AND ($4::text IS NULL OR m.medium_code  = $4)
          AND ($5::text IS NULL OR qb.chapter     = $5)
          AND ($6::int  IS NULL OR qb.current_month = $6::int)
          AND ($7 = '' OR qb.question_pdf ILIKE '%' || $7 || '%'
                       OR qb.question_whatsapp ILIKE '%' || $7 || '%')
        ORDER BY qb.id DESC
        LIMIT $8 OFFSET $9`,
      [board || null, grade || null, subject || null, medium || null,
       chapter || null, month || null, q, limit, offset]);
    ok(res, { rows, total: rows[0]?.total || 0 });
  } catch (e) { console.error('[admin] questions:', e.message); fail(res, 500, 'Could not load questions.'); }
});

/** Distinct chapters and months for the filter dropdowns. */
router.get('/questions/facets', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.board_code, g.grade_code, s.subject_code, m.medium_code,
              qb.chapter, qb.current_month, COUNT(*)::int n
         FROM question_bank qb
         JOIN boards b   ON b.id = qb.board_id
         JOIN grades g   ON g.id = qb.grade_id
         JOIN subjects s ON s.id = qb.subject_id
         JOIN mediums m  ON m.id = qb.medium_id
        WHERE qb.is_active
        GROUP BY 1,2,3,4,5,6
        ORDER BY 1,2,3,5,6`);
    ok(res, { rows });
  } catch (e) { console.error('[admin] facets:', e.message); fail(res, 500, 'Could not load filters.'); }
});

const EDITABLE = ['chapter', 'question_pdf', 'question_whatsapp', 'option_a', 'option_b',
  'option_c', 'option_d', 'answer', 'explanation', 'question_type', 'is_active'];

router.patch('/questions/:id', requireAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad question id.');

  const sets = [], vals = [];
  for (const c of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, c)) {
      vals.push(req.body[c]); sets.push(`${c} = $${vals.length}`);
    }
  }
  if (!sets.length) return fail(res, 400, 'Nothing to update.');

  // an answer key that points nowhere makes the question unanswerable
  if (req.body.answer && !LETTERS.includes(String(req.body.answer).toUpperCase())) {
    return fail(res, 400, 'Answer must be A, B, C or D.');
  }
  vals.push(id);
  try {
    const { rows } = await db.query(
      `UPDATE question_bank SET ${sets.join(', ')}, modified_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return fail(res, 404, 'Question not found.');
    ok(res, { row: rows[0] });
  } catch (e) { console.error('[admin] edit question:', e.message); fail(res, 400, e.message); }
});

/**
 * Deactivate rather than delete. A question already served to a child is
 * referenced by student_quizpe_histories — deleting it would blank that
 * child's answer review and break their report.
 */
router.delete('/questions/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 400, 'Bad question id.');
  try {
    const used = (await db.query(
      `SELECT COUNT(*)::int n FROM student_quizpe_histories WHERE question_id = $1`, [id])).rows[0].n;
    await db.query(
      `UPDATE question_bank SET is_active = false, modified_at = now() WHERE id = $1`, [id]);
    ok(res, {
      deactivated: true,
      note: used
        ? `Deactivated. It stays in the database because ${used} child answer(s) reference it.`
        : 'Deactivated — it will no longer be served.',
    });
  } catch (e) { console.error('[admin] delete question:', e.message); fail(res, 400, e.message); }
});

/* ----------------------------------------------------------------- import */
function normalise(r) {
  const pick = (...keys) => {
    for (const k of keys) {
      const hit = Object.keys(r).find((x) => x.toLowerCase().replace(/[\s_]/g, '') === k);
      if (hit && r[hit] != null && String(r[hit]).trim() !== '') return String(r[hit]).trim();
    }
    return '';
  };
  return {
    chapter: pick('chapter', 'chaptername', 'topic'),
    question: pick('question', 'questiontext', 'questionpdf', 'q'),
    question_whatsapp: pick('questionwhatsapp', 'questionshort'),
    option_a: pick('optiona', 'a', 'option1'),
    option_b: pick('optionb', 'b', 'option2'),
    option_c: pick('optionc', 'c', 'option3'),
    option_d: pick('optiond', 'd', 'option4'),
    answer: pick('answer', 'correctanswer', 'correct', 'ans').toUpperCase().slice(0, 1),
    explanation: pick('explanation', 'reason', 'why'),
    question_type: pick('questiontype', 'type') || 'mcq',
  };
}

function validate(q) {
  if (!q.chapter) return 'chapter is missing';
  if (!q.question) return 'question text is missing';
  const opts = [q.option_a, q.option_b, q.option_c, q.option_d].filter(Boolean);
  if (opts.length < 2) return 'needs at least 2 options';
  if (!LETTERS.includes(q.answer)) return 'answer must be A, B, C or D';
  const idx = LETTERS.indexOf(q.answer);
  if (![q.option_a, q.option_b, q.option_c, q.option_d][idx]) return `answer ${q.answer} points at an empty option`;
  const lower = opts.map((o) => o.toLowerCase());
  if (new Set(lower).size !== lower.length) return 'two options are identical';
  return null;
}

async function resolveIds(body) {
  const { rows: [r] } = await db.query(
    `SELECT (SELECT id FROM boards   WHERE board_code   = $1) board_id,
            (SELECT id FROM grades   WHERE grade_code   = $2) grade_id,
            (SELECT id FROM subjects WHERE subject_code = $3) subject_id,
            (SELECT id FROM mediums  WHERE medium_code  = $4) medium_id`,
    [body.board, body.grade, body.subject, body.medium]);
  return r;
}

/** Dry run — says exactly what would happen, writes nothing. */
router.post('/questions/import/preview', requireAdmin, express.json({ limit: '25mb' }), async (req, res) => {
  const { rows = [], current_month, academic_year } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return fail(res, 400, 'The sheet has no rows.');
  if (rows.length > 20000) return fail(res, 400, 'Please split sheets larger than 20,000 rows.');

  try {
    const ids = await resolveIds(req.body);
    if (!ids.board_id || !ids.grade_id || !ids.subject_id || !ids.medium_id) {
      return fail(res, 400, 'Unknown board, grade, subject or medium.');
    }
    const month = parseInt(current_month, 10);
    if (!(month >= 1 && month <= 12)) return fail(res, 400, 'Pick the serving month.');

    // existing questions for THIS combination and month — the only rows that
    // can legitimately be duplicates
    const { rows: existing } = await db.query(
      `SELECT lower(COALESCE(question_pdf, question_whatsapp)) AS t
         FROM question_bank
        WHERE board_id=$1 AND grade_id=$2 AND subject_id=$3 AND medium_id=$4
          AND current_month=$5 AND is_active`,
      [ids.board_id, ids.grade_id, ids.subject_id, ids.medium_id, month]);
    const inDb = new Set(existing.map((e) => e.t));

    const seen = new Map();
    const out = rows.map((raw, i) => {
      const q = normalise(raw);
      const problem = validate(q);
      const key = q.question.toLowerCase();
      let status = 'new', note = '';

      if (problem) { status = 'invalid'; note = problem; }
      else if (inDb.has(key)) { status = 'duplicate_db'; note = 'already in the bank for this month'; }
      else if (seen.has(key)) { status = 'duplicate_file'; note = `same as sheet row ${seen.get(key) + 2}`; }

      if (status === 'new') seen.set(key, i);
      return { row: i + 2, status, note, ...q };
    });

    const summary = out.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
    ok(res, {
      rows: out,
      summary: {
        total: out.length,
        new: summary.new || 0,
        duplicate_db: summary.duplicate_db || 0,
        duplicate_file: summary.duplicate_file || 0,
        invalid: summary.invalid || 0,
      },
      target: { ...req.body, academic_year: academic_year || null, current_month: month },
      existingInMonth: inDb.size,
    });
  } catch (e) { console.error('[admin] import preview:', e.message); fail(res, 500, e.message); }
});

/** Inserts only the rows the preview marked `new`. */
router.post('/questions/import/commit', requireAdmin, express.json({ limit: '25mb' }), async (req, res) => {
  const { rows = [], current_month, academic_year, revision } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return fail(res, 400, 'Nothing to import.');

  try {
    const ids = await resolveIds(req.body);
    if (!ids.board_id || !ids.grade_id || !ids.subject_id || !ids.medium_id) {
      return fail(res, 400, 'Unknown board, grade, subject or medium.');
    }
    const month = parseInt(current_month, 10);
    const year = parseInt(academic_year, 10) || new Date().getFullYear();
    const rev = parseInt(revision, 10) || month;

    const good = rows.filter((r) => r.status === 'new');
    if (!good.length) return fail(res, 400, 'No importable rows — everything was a duplicate or invalid.');

    const c = await db.getClient();
    try {
      await c.query('BEGIN');
      let inserted = 0;
      // one statement per row keeps a bad row from failing the whole batch's
      // parameter binding; the transaction still makes it all-or-nothing
      for (const q of good) {
        await c.query(
          `INSERT INTO question_bank
             (board_id, grade_id, subject_id, medium_id, academic_year, current_month, revision,
              chapter, question_whatsapp, question_pdf, option_a, option_b, option_c, option_d,
              answer, explanation, question_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [ids.board_id, ids.grade_id, ids.subject_id, ids.medium_id, year, month, rev,
           q.chapter, q.question_whatsapp || q.question, q.question,
           q.option_a || null, q.option_b || null, q.option_c || null, q.option_d || null,
           q.answer, q.explanation || null, q.question_type || 'mcq']);
        inserted++;
      }
      await c.query('COMMIT');
      console.log(`[admin] imported ${inserted} questions into ${req.body.board}/${req.body.grade}/${req.body.subject}/${req.body.medium} month ${month}`);
      ok(res, { inserted });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } catch (e) { console.error('[admin] import commit:', e.message); fail(res, 400, e.message); }
});

module.exports = router;
