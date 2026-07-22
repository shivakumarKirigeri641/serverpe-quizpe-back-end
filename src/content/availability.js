/**
 * src/content/availability.js
 * ---------------------------------------------------------------------------
 * What QuizPe can ACTUALLY deliver right now, derived from question_bank.
 *
 * A board/grade/medium combination is only offerable when the base subject
 * (Maths) has questions for it. Anything else would sell — or trial — an empty
 * subscription: the parent signs up, and at 8 PM `selectQuestions` returns
 * nothing and the quiz fails on day one.
 *
 * Shared by the paid checkout and the free-trial signup so both offer exactly
 * the same set. New combinations appear automatically as content lands; no
 * code change, no list to maintain.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const BASE_SUBJECT = 'MATHS';

/**
 * @returns {Promise<{availability: object, boards: array, grades: array}>}
 *   availability[board][grade] = { grade_name, mediums: { CODE: { label, addons[] } } }
 *   boards/grades are already filtered to those that appear in availability,
 *   so a form can render them directly.
 */
async function getAvailability(exec = db) {
  const { rows } = await exec.query(
    `SELECT b.board_code, b.board_name, b.display_order AS board_order,
            g.grade_code, g.grade_name, g.display_order AS grade_order,
            m.medium_code, m.native_name, m.medium_name,
            s.subject_code, s.subject_name,
            a.price::numeric AS addon_price, COUNT(*)::int AS questions
       FROM question_bank qb
       JOIN boards   b ON b.id = qb.board_id  AND b.is_active
       JOIN grades   g ON g.id = qb.grade_id  AND g.is_active
       JOIN mediums  m ON m.id = qb.medium_id AND m.is_active
       JOIN subjects s ON s.id = qb.subject_id AND s.is_active
       JOIN grade_subjects gs ON gs.grade_id = qb.grade_id
                             AND gs.subject_id = qb.subject_id AND gs.is_active
       LEFT JOIN quizpe_addons a ON a.subject_id = s.id AND a.is_active
      WHERE qb.is_active
      GROUP BY b.board_code, b.board_name, b.display_order, g.grade_code, g.grade_name,
               g.display_order, m.medium_code, m.native_name, m.medium_name,
               s.subject_code, s.subject_name, a.price, gs.display_order
      ORDER BY b.display_order, g.display_order, gs.display_order`);

  const raw = {};
  for (const r of rows) {
    const b = (raw[r.board_code] ||= { board_name: r.board_name, order: r.board_order, grades: {} });
    const g = (b.grades[r.grade_code] ||= { grade_name: r.grade_name, order: r.grade_order, mediums: {} });
    const m = (g.mediums[r.medium_code] ||= { label: r.native_name || r.medium_name, subjects: {} });
    m.subjects[r.subject_code] = {
      subject_name: r.subject_name,
      price: r.addon_price == null ? null : Number(r.addon_price),
      questions: r.questions,
    };
  }

  const availability = {};
  const boardSeen = new Map(), gradeSeen = new Map();
  for (const [board, bv] of Object.entries(raw)) {
    for (const [grade, gv] of Object.entries(bv.grades)) {
      for (const [medium, mv] of Object.entries(gv.mediums)) {
        if (!mv.subjects[BASE_SUBJECT]) continue;          // no base content -> not offerable
        const addons = Object.entries(mv.subjects)
          .filter(([code, v]) => code !== BASE_SUBJECT && v.price != null && v.questions > 0)
          .map(([code, v]) => ({ subject_code: code, subject_name: v.subject_name, price: v.price }));

        (((availability[board] ||= {})[grade] ||= { grade_name: gv.grade_name, mediums: {} }).mediums)[medium] =
          { label: mv.label, addons };
        boardSeen.set(board, { board_code: board, board_name: bv.board_name, order: bv.order });
        gradeSeen.set(grade, { grade_code: grade, grade_name: gv.grade_name, order: gv.order });
      }
    }
  }

  const bySort = (a, z) => a.order - z.order;
  return {
    availability,
    boards: [...boardSeen.values()].sort(bySort).map(({ order, ...b }) => b),
    grades: [...gradeSeen.values()].sort(bySort).map(({ order, ...g }) => g),
  };
}

/** Server-side check — a form post must never create an undeliverable signup. */
async function isDeliverable(boardCode, gradeCode, mediumCode, exec = db) {
  const { rows } = await exec.query(
    `SELECT 1
       FROM question_bank qb
       JOIN boards   b ON b.id = qb.board_id  AND b.board_code  = $1
       JOIN grades   g ON g.id = qb.grade_id  AND g.grade_code  = $2
       JOIN mediums  m ON m.id = qb.medium_id AND m.medium_code = $3
       JOIN subjects s ON s.id = qb.subject_id AND s.subject_code = $4
      WHERE qb.is_active LIMIT 1`,
    [boardCode, gradeCode, mediumCode, BASE_SUBJECT]);
  return rows.length > 0;
}

module.exports = { getAvailability, isDeliverable, BASE_SUBJECT };
