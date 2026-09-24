/**
 * scripts/test-difficulty.js — the difficulty bands, the prompt gate and the
 * level recorded on a tracker. Nothing is sent and no database is touched:
 * the WhatsApp client and the db module are replaced with stand-ins.
 *
 *   node scripts/test-difficulty.js
 */

const path = require('path');

let sent = [];
const waPath = require.resolve(path.join(__dirname, '../src/whatsapp/client'));
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    sendButtons: async (s, m, body, buttons) => { sent.push({ body, buttons }); return 'wamid.x'; },
    sendText: async (s, m, body) => { sent.push({ body, buttons: [] }); return 'wamid.x'; },
  },
};

/* The feature is opt-in on the server; the tests must exercise it switched ON. */
process.env.QUIZ_DIFFICULTY = '1';
const DIFF = require('../src/whatsapp/difficulty');

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nDifficulty — bands, gates and what gets recorded\n');

/* ── the bands ─────────────────────────────────────────────────────────── */
check(same(DIFF.band(1), [1, 2]), 'easy draws from levels 1 and 2 — never 3');
check(same(DIFF.band(2), [2]), 'medium is its own band, so it is not the same quiz as easy');
check(same(DIFF.band(3), [2, 3]), 'hard draws from 2 and 3 — level 3 alone is too thin to fill a quiz');
check(!same(DIFF.band(1), DIFF.band(2)) && !same(DIFF.band(2), DIFF.band(3)),
  'all three choices give genuinely different pools');

/* ── junk in ───────────────────────────────────────────────────────────── */
check(DIFF.band(null) === null && DIFF.band(0) === null && DIFF.band(4) === null
   && DIFF.band('x') === null,
  'an absent or nonsense level means NO filter, never an empty pool');
check(DIFF.clamp('2') === 2, 'a level arriving as text from a button id is still understood');

/* ── who is offered a choice ───────────────────────────────────────────── */
check(!DIFF.gradeAllows('G1') && !DIFF.gradeAllows('G2'),
  'grades 1-2 are never asked: the bank holds only level-1 questions for them');
check(DIFF.gradeAllows('G3') && DIFF.gradeAllows('G10'), 'grades 3-10 are asked');
check(!DIFF.gradeAllows(null) && !DIFF.gradeAllows(''),
  'an unknown grade is not asked — the single Start button still works');

/* The switch itself: with QUIZ_DIFFICULTY unset, nobody is ever asked, so
   deploying the code changes nothing for a single live family. */
{
  delete require.cache[require.resolve('../src/whatsapp/difficulty')];
  const prev = process.env.QUIZ_DIFFICULTY;
  delete process.env.QUIZ_DIFFICULTY;
  const off = require('../src/whatsapp/difficulty');
  check(off.ON === false && !off.gradeAllows('G5') && !off.gradeAllows('G10'),
    'with QUIZ_DIFFICULTY unset, NO grade is asked — deploying changes nothing');
  process.env.QUIZ_DIFFICULTY = prev;
  delete require.cache[require.resolve('../src/whatsapp/difficulty')];
  require('../src/whatsapp/difficulty');
}

/* ── the buttons ───────────────────────────────────────────────────────── */
const b = DIFF.buttons();
check(b.length === 3, 'exactly three buttons — WhatsApp allows no more');
check(b.every((x) => x.title.length <= 20), 'every title fits the 20-character limit');
check(same(b.map((x) => x.id), ['qd_1', 'qd_2', 'qd_3']), 'button ids carry the level');
check(/^qd_[123]_\d+$/.test(`${b[2].id}_41`), 'with the student appended, the handler regex matches');

/* ── the default ───────────────────────────────────────────────────────── */
check(DIFF.DEFAULT_LEVEL === 2,
  'the default is MEDIUM, so an existing family\'s quizzes do not silently get easier');

/* ── startQuiz records the level, and a resume keeps it ────────────────── */
const rows = { tracker: null, updates: [] };
const dbPath = require.resolve(path.join(__dirname, '../src/database/connectDB'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async () => ({ rows: [], rowCount: 0 }),
    getClient: async () => ({
      query: async (sql, params = []) => {
        if (/FROM quizpe_tracker t JOIN subjects/.test(sql)) return { rows: [rows.tracker] };
        if (/COUNT\(\*\)::int n FROM student_quizpe_histories/.test(sql)) {
          return { rows: [{ n: rows.tracker.filled ? 5 : 0 }] };
        }
        if (/UPDATE quizpe_tracker/.test(sql)) { rows.updates.push(params[1]); return { rows: [] }; }
        return { rows: [] };
      },
      release() {},
    }),
  },
};
const masteryPath = require.resolve(path.join(__dirname, '../src/whatsapp/mastery'));
let askedFor = null;
require.cache[masteryPath] = {
  id: masteryPath, filename: masteryPath, loaded: true,
  exports: {
    selectQuestions: async (sid, subj, n, exec, level) => {
      askedFor = level;
      return { ids: Array.from({ length: n }, (_, i) => i + 1), frontierChapter: 'C1' };
    },
  },
};
const jobsPath = require.resolve(path.join(__dirname, '../src/jobs/jobQueue'));
require.cache[jobsPath] = { id: jobsPath, filename: jobsPath, loaded: true, exports: { push: async () => {} } };

const quiz = require('../src/whatsapp/quiz');

(async () => {
  rows.tracker = { id: 7, student_id: 1, subject_id: 1, question_count: 10,
                   quiz_type: 'daily', difficulty_level: null, subject_code: 'MATHS', filled: false };
  rows.updates = [];
  let r = await quiz.startQuiz(7, 3);
  check(askedFor === 3, 'the chosen level reaches question selection');
  check(rows.updates[0] === 3 && r.difficulty === 3, 'and is written onto the tracker');

  /* A resume: the tracker already carries a level and already has questions. */
  rows.tracker = { ...rows.tracker, difficulty_level: 1, filled: true };
  rows.updates = []; askedFor = 'untouched';
  r = await quiz.startQuiz(7, 3);
  check(r.resumed === true && r.difficulty === 1,
    'a resumed quiz keeps the level it was BUILT with, ignoring a newly tapped one');
  check(askedFor === 'untouched', 'and does not re-pick its questions');

  rows.tracker = { ...rows.tracker, difficulty_level: null, filled: false };
  await quiz.startQuiz(7, null);
  check(askedFor === null, 'no choice means no filter — the old behaviour, unchanged');

  console.log(fails ? `\n  ${fails} FAILURE(S)\n` : '\n  all checks passed\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('\n  ERROR', e.stack, '\n'); process.exit(1); });
