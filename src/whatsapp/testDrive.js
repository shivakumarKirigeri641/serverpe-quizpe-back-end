/**
 * src/whatsapp/testDrive.js
 * ===========================================================================
 * ⚠️  TEMPORARY — FOR TESTING ONLY. REMOVE BEFORE LAUNCH.
 * ===========================================================================
 *
 * Lets you run a real quiz for ANY board / grade / question count without
 * signing up, without waiting for 8 PM, and without touching real parent or
 * student data. The quiz and the PDF report are produced by exactly the same
 * code paths as a live quiz, so what you see is what a parent would see.
 *
 * How "genuine report, no stored data" is achieved:
 *   • one hidden scratch student (parent mobile 0000000000, is_active=false)
 *     is reused for every test drive — it is never in any menu, sweep or
 *     report list because every query filters on is_active
 *   • the quiz runs through the normal tracker/history tables, so the report
 *     generator has real rows to read
 *   • as soon as the report is sent, every row it created is deleted again
 *
 * ---------------------------------------------------------------------------
 * TO REMOVE THIS FEATURE COMPLETELY:
 *   1. delete this file
 *   2. src/whatsapp/flow.js       — remove the two `testDrive` blocks
 *   3. src/whatsapp/userContext.js — remove the `td_start` menu row
 *   4. run:  node -e "require('./src/whatsapp/testDrive').purge()"
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const wa = require('./client');
const Q = require('./quiz');

const TEST_MOBILE = '0000000000';           // never a real WhatsApp number
const COUNTS = [5, 10, 15, 20];

/** The hidden scratch parent+student, created on first use. */
async function scratchStudent(boardCode, gradeCode, mediumCode = 'ENGLISH') {
  const parent = (await db.query(
    `INSERT INTO parents (parent_name, parent_mobile_number, is_active)
     VALUES ('__TESTDRIVE__', $1, false)
     ON CONFLICT (parent_mobile_number) DO UPDATE SET modified_at = now()
     RETURNING id`, [TEST_MOBILE])).rows[0];

  const ids = (await db.query(
    `SELECT (SELECT id FROM boards  WHERE board_code=$1)  AS board_id,
            (SELECT id FROM grades  WHERE grade_code=$2)  AS grade_id,
            (SELECT id FROM mediums WHERE medium_code=$3) AS medium_id`,
    [boardCode, gradeCode, mediumCode])).rows[0];
  if (!ids.board_id || !ids.grade_id) return { error: 'BAD_COMBO' };

  const existing = (await db.query(
    `SELECT id FROM students WHERE parent_id=$1 LIMIT 1`, [parent.id])).rows[0];
  if (existing) {
    await db.query(
      `UPDATE students SET board_id=$2, grade_id=$3, medium_id=$4, is_active=false, modified_at=now()
        WHERE id=$1`, [existing.id, ids.board_id, ids.grade_id, ids.medium_id]);
    return { studentId: existing.id, parentId: parent.id };
  }
  const st = (await db.query(
    `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name, is_active)
     VALUES ($1,$2,$3,$4,'__TESTDRIVE__', false) RETURNING id`,
    [parent.id, ids.board_id, ids.grade_id, ids.medium_id])).rows[0];
  return { studentId: st.id, parentId: parent.id };
}

/** Board picker — only boards that actually have questions. */
async function askBoard(session, mobile, setState) {
  const boards = (await db.query(
    `SELECT DISTINCT b.board_code, b.board_name
       FROM question_bank qb JOIN boards b ON b.id = qb.board_id
      WHERE qb.is_active ORDER BY b.board_code LIMIT 10`)).rows;
  if (!boards.length) {
    await wa.sendText(session.id, mobile, '⚠️ No question content loaded yet.');
    return;
  }
  await wa.sendList(session.id, mobile, {
    header: '🧪 Test drive',
    text: '*TESTING ONLY*\n\nWhich board?',
    buttonText: 'Select board',
    rows: boards.map(b => ({ id: `td_b_${b.board_code}`, title: b.board_code, description: b.board_name })),
  });
  await setState(session, 'td_board', 'testdrive_board');
}

/** Grades that have questions for the chosen board. */
async function askGrade(session, mobile, boardCode, setState) {
  const grades = (await db.query(
    `SELECT DISTINCT g.grade_code, g.grade_name, g.display_order
       FROM question_bank qb
       JOIN grades g ON g.id = qb.grade_id
       JOIN boards b ON b.id = qb.board_id
      WHERE b.board_code = $1 AND qb.is_active
      ORDER BY g.display_order LIMIT 10`, [boardCode])).rows;
  if (!grades.length) {
    await wa.sendText(session.id, mobile, `⚠️ No questions for ${boardCode}.`);
    return;
  }
  await wa.sendList(session.id, mobile, {
    header: '🧪 Test drive',
    text: `Board *${boardCode}*.\n\nWhich grade?`,
    buttonText: 'Select grade',
    rows: grades.map(g => ({ id: `td_g_${g.grade_code}`, title: g.grade_name, description: `${boardCode} · ${g.grade_name}` })),
  });
  await setState(session, 'td_grade', 'testdrive_grade');
}

async function askCount(session, mobile, ctxData, setState) {
  await wa.sendList(session.id, mobile, {
    header: '🧪 Test drive',
    text: `*${ctxData.board} · ${ctxData.grade}*\n\nHow many questions?`,
    buttonText: 'Select count',
    rows: COUNTS.map(n => ({ id: `td_n_${n}`, title: `${n} questions`, description: n === 10 ? 'Normal daily length' : `${n}-question quiz` })),
  });
  await setState(session, 'td_count', 'testdrive_count');
}

/**
 * Build a real quiz for the scratch student and hand back a normal quiz link.
 * `onCleanup` is called by the quiz flow once the report has gone out.
 */
async function start(session, mobile, { board, grade, count }) {
  const s = await scratchStudent(board, grade);
  if (s.error) {
    await wa.sendText(session.id, mobile, `⚠️ No content for ${board} · ${grade}.`);
    return null;
  }

  // wipe anything left from a previous test drive for this student
  await purgeStudent(s.studentId);

  const sched = await Q.scheduleDailyQuizzes(s.studentId, db, { questionCount: Number(count) });
  const trackerId = sched.created.find(c => c.trackerId)?.trackerId;
  if (!trackerId) {
    await wa.sendText(session.id, mobile, `⚠️ Could not build a quiz for ${board} · ${grade}.`);
    return null;
  }

  const r = await Q.startQuiz(trackerId);
  if (r.error) {
    await wa.sendText(session.id, mobile,
      `⚠️ ${r.error === 'NO_QUESTIONS' ? `No unseen questions left for ${board} · ${grade}.` : r.error}`);
    await purgeStudent(s.studentId);
    return null;
  }

  const { createQuizLink } = require('../routers/quizWebRouter');
  const { url } = await createQuizLink(session.id, mobile, trackerId);
  await wa.sendCtaUrl(session.id, mobile, {
    header: '🧪 Test drive',
    body: `*TESTING ONLY — nothing is saved.*\n\n${board} · ${grade} · ${count} questions\n\nThe quiz and the PDF report are exactly what a parent gets.`,
    displayText: '▶️ Start test quiz',
    url,
    footer: 'QuizPe · test mode',
  });
  return { trackerId, studentId: s.studentId };
}

/** Is this tracker a test-drive one? Used to clean up after the report. */
async function isTestTracker(trackerId) {
  const { rows } = await db.query(
    `SELECT 1 FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id
       JOIN parents  p  ON p.id  = st.parent_id
      WHERE t.id = $1 AND p.parent_mobile_number = $2`, [trackerId, TEST_MOBILE]);
  return rows.length > 0;
}

/** Delete every row a test drive created for this scratch student. */
async function purgeStudent(studentId) {
  const t = (await db.query(
    `SELECT id FROM quizpe_tracker WHERE student_id = $1`, [studentId])).rows.map(r => r.id);
  if (t.length) {
    // remove the generated PDFs too, or test drives quietly fill the disk
    try {
      const fs = require('fs');
      const path = require('path');
      const { REPORTS_ROOT } = require('../pdf/dailyReport');
      const files = (await db.query(
        `SELECT file_path FROM quiz_reports WHERE tracker_id = ANY($1::bigint[])`, [t])).rows;
      for (const f of files) {
        if (f.file_path) fs.rmSync(path.join(REPORTS_ROOT, f.file_path), { force: true });
      }
    } catch (e) { console.error('[testDrive] report file cleanup failed:', e.message); }

    await db.query(`DELETE FROM quiz_links WHERE tracker_id = ANY($1::bigint[])`, [t]);
    await db.query(`DELETE FROM feedback_links WHERE tracker_id = ANY($1::bigint[])`, [t]);
    await db.query(`DELETE FROM feedbacks WHERE tracker_id = ANY($1::bigint[])`, [t]);
    await db.query(`DELETE FROM quiz_reports WHERE tracker_id = ANY($1::bigint[])`, [t]);
    await db.query(`DELETE FROM student_quizpe_histories WHERE tracker_id = ANY($1::bigint[])`, [t]);
    await db.query(`DELETE FROM quizpe_tracker WHERE id = ANY($1::bigint[])`, [t]);
  }
  await db.query(`DELETE FROM student_subject_progress WHERE student_id = $1`, [studentId]);
}

/** Remove the scratch parent/student entirely (used by the removal step). */
async function purge() {
  const st = (await db.query(
    `SELECT st.id FROM students st JOIN parents p ON p.id = st.parent_id
      WHERE p.parent_mobile_number = $1`, [TEST_MOBILE])).rows;
  for (const s of st) await purgeStudent(s.id);
  await db.query(
    `DELETE FROM students WHERE parent_id IN (SELECT id FROM parents WHERE parent_mobile_number=$1)`,
    [TEST_MOBILE]);
  await db.query(`DELETE FROM parents WHERE parent_mobile_number = $1`, [TEST_MOBILE]);
  console.log('[testDrive] scratch data purged');
}

module.exports = {
  TEST_MOBILE, COUNTS, askBoard, askGrade, askCount, start,
  isTestTracker, purgeStudent, purge,
};
