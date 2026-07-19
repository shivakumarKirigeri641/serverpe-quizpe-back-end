/**
 * src/whatsapp/mastery.js
 * ---------------------------------------------------------------------------
 * Per-child adaptive learning engine. No calendar, no parent input — each
 * child advances through the chapter sequence based purely on how they answer.
 *
 *   • Chapter order is derived from question_bank.revision (origin month).
 *   • A child has a "frontier" = the chapter they're currently learning.
 *   • Daily quiz  = mostly frontier-chapter (new) + some earlier (revision).
 *   • After each quiz: if they've MASTERED the frontier chapter, advance it.
 *
 * Canonical questions per chapter = the ORIGIN rows (revision = current_month),
 * so the spiral's month-copies never cause duplicate text.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const CFG = {
  MASTERY_ACCURACY: 0.80,     // accuracy needed to call a chapter "mastered"
  MIN_ANSWERED: 12,           // min answered in a chapter before it can be judged
  EXPOSURE_CAP: 25,           // move the frontier forward after this many attempts
                              // even if not mastered, so a child never freezes —
                              // the weak chapter keeps coming back until mastered
  REINFORCE_RATIO: 0.4,       // daily share for weak (unmastered) earlier chapters
  FRONTIER_RATIO: 0.4,        // daily share for the current/newest chapter
  // remaining ~0.2 = spaced revision of already-mastered chapters
  BASE_QUESTIONS: 10,         // doing well -> standard quiz
  MID_QUESTIONS: 15,          // wobbling  -> more practice
  MAX_QUESTIONS: 20,          // struggling -> most practice (hard ceiling)
};

/** Ordered chapters for a student's board/grade/subject/medium (seq 1..N). */
async function chapterSequence(studentId, subjectId, exec = db) {
  const { rows } = await exec.query(
    `SELECT qb.chapter,
            dense_rank() OVER (ORDER BY CASE WHEN min(qb.revision) >= 6 THEN min(qb.revision)
                                             ELSE min(qb.revision) + 12 END)::int AS seq
       FROM question_bank qb
       JOIN students st ON st.id = $1
      WHERE qb.board_id = st.board_id AND qb.grade_id = st.grade_id
        AND qb.medium_id = st.medium_id AND qb.subject_id = $2 AND qb.is_active
      GROUP BY qb.chapter
      ORDER BY seq`,
    [studentId, subjectId]);
  return rows;   // [{ chapter, seq }]
}

/** Get or create the progress row; keeps total_chapters + frontier_chapter fresh. */
async function getProgress(studentId, subjectId, exec = db) {
  const chapters = await chapterSequence(studentId, subjectId, exec);
  const total = chapters.length;
  let p = (await exec.query(
    `SELECT * FROM student_subject_progress WHERE student_id=$1 AND subject_id=$2`,
    [studentId, subjectId])).rows[0];

  if (!p) {
    p = (await exec.query(
      `INSERT INTO student_subject_progress (student_id, subject_id, frontier_seq, frontier_chapter, total_chapters)
       VALUES ($1,$2,1,$3,$4)
       ON CONFLICT (student_id, subject_id) DO UPDATE SET total_chapters=EXCLUDED.total_chapters, modified_at=now()
       RETURNING *`,
      [studentId, subjectId, chapters[0]?.chapter || null, total])).rows[0];
  } else if (p.total_chapters !== total || !p.frontier_chapter) {
    p = (await exec.query(
      `UPDATE student_subject_progress SET total_chapters=$3,
              frontier_chapter=$4, modified_at=now()
        WHERE id=$1 RETURNING *`,
      [p.id, subjectId, total, chapters[Math.min(p.frontier_seq, total) - 1]?.chapter || p.frontier_chapter])).rows[0];
  }
  return { progress: p, chapters };
}

/** Per-chapter performance for this child+subject, in syllabus order. */
async function perChapterStats(studentId, subjectId, chapters, exec = db) {
  const { rows } = await exec.query(
    `SELECT qb.chapter,
            COUNT(*) FILTER (WHERE h.answered_option IS NOT NULL)::int answered,
            COUNT(*) FILTER (WHERE h.is_correct)::int correct
       FROM student_quizpe_histories h
       JOIN quizpe_tracker t ON t.id = h.tracker_id
       JOIN question_bank qb ON qb.id = h.question_id
      WHERE t.student_id = $1 AND t.subject_id = $2
      GROUP BY qb.chapter`, [studentId, subjectId]);
  const by = Object.fromEntries(rows.map(r => [r.chapter, r]));
  return chapters.map(c => {
    const s = by[c.chapter] || { answered: 0, correct: 0 };
    const accuracy = s.answered ? s.correct / s.answered : 0;
    const mastered = s.answered >= CFG.MIN_ANSWERED && accuracy >= CFG.MASTERY_ACCURACY;
    return { chapter: c.chapter, seq: c.seq, answered: s.answered, correct: s.correct, accuracy, mastered };
  });
}

/**
 * Adaptive selection with REINFORCEMENT:
 *   ~40% weak earlier chapters (attempted but not yet mastered — Ch2/Ch3),
 *   ~40% the current/frontier chapter (new learning),
 *   ~20% spaced revision of already-mastered chapters.
 * So a child stuck on Ch2 keeps getting Ch2 to reinforce, WHILE also seeing
 * the newer chapters their class has moved on to. Empty buckets reflow.
 */
async function selectQuestions(studentId, subjectId, count, exec = db) {
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  if (!chapters.length) return { ids: [], progress, chapters };

  const frontierSeq = Math.min(progress.frontier_seq, chapters.length);
  const frontierChapter = chapters[frontierSeq - 1].chapter;
  const stats = await perChapterStats(studentId, subjectId, chapters, exec);

  const weakEarlier = stats.filter(s => s.seq < frontierSeq && s.answered > 0 && !s.mastered)
    .sort((a, b) => a.accuracy - b.accuracy).map(s => s.chapter);      // weakest first
  const masteredEarlier = stats.filter(s => s.seq < frontierSeq && s.mastered).map(s => s.chapter);

  const pick = async (chapterList, n, exclude) => {
    if (!n || !chapterList.length) return [];
    const { rows } = await exec.query(
      `SELECT qb.id
         FROM question_bank qb JOIN students st ON st.id = $1
        WHERE qb.board_id = st.board_id AND qb.grade_id = st.grade_id
          AND qb.medium_id = st.medium_id AND qb.subject_id = $2 AND qb.is_active
          AND qb.revision = qb.current_month
          AND qb.chapter = ANY($3)
          AND NOT ( qb.id = ANY($5::bigint[]) )
          AND NOT EXISTS (SELECT 1 FROM student_quizpe_histories h
                            JOIN quizpe_tracker t ON t.id = h.tracker_id
                           WHERE t.student_id = $1 AND h.question_id = qb.id)
        ORDER BY random() LIMIT $4`,
      [studentId, subjectId, chapterList, n, exclude]);
    return rows.map(r => r.id);
  };

  let ids = [];
  const reinforceN = weakEarlier.length ? Math.round(count * CFG.REINFORCE_RATIO) : 0;
  // if there's no mastered-revision pool, the frontier takes that share too
  const frontierN = Math.round(count * CFG.FRONTIER_RATIO) + (masteredEarlier.length ? 0 : Math.round(count * 0.2));

  ids = ids.concat(await pick(weakEarlier, reinforceN, ids));
  ids = ids.concat(await pick([frontierChapter], Math.max(frontierN, count - ids.length - (masteredEarlier.length ? Math.round(count * 0.2) : 0)), ids));
  if (ids.length < count && masteredEarlier.length) ids = ids.concat(await pick(masteredEarlier, count - ids.length, ids));
  // final top-up from any unlocked chapter, so the quiz is always full
  if (ids.length < count) ids = ids.concat(await pick(chapters.slice(0, frontierSeq).map(c => c.chapter), count - ids.length, ids));

  ids = [...new Set(ids)].slice(0, count);
  return { ids, progress, chapters, frontierChapter, weakChapters: weakEarlier };
}

/**
 * After a quiz, move the frontier forward when the current chapter is either
 * MASTERED (≥80% over ≥12) OR sufficiently EXPOSED (≥ EXPOSURE_CAP attempts) —
 * so no child freezes. Unmastered chapters stay in the reinforcement pool.
 */
async function evaluateAndPromote(studentId, subjectId, exec = db) {
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  if (progress.status === 'completed' || !chapters.length) return { promoted: false, status: progress.status };

  const frontierSeq = Math.min(progress.frontier_seq, chapters.length);
  const frontierChapter = chapters[frontierSeq - 1].chapter;
  const stats = await perChapterStats(studentId, subjectId, chapters, exec);
  const f = stats.find(s => s.seq === frontierSeq) || { answered: 0, accuracy: 0, mastered: false };

  const masteredNow = f.mastered;
  const exposed = f.answered >= CFG.EXPOSURE_CAP;
  if (!masteredNow && !exposed) {
    return { promoted: false, chapter: frontierChapter, accuracy: f.accuracy, answered: f.answered, status: 'learning' };
  }

  if (frontierSeq >= chapters.length) {
    // reached the last chapter — only "complete" once it's genuinely mastered
    if (masteredNow) {
      await exec.query(`UPDATE student_subject_progress SET status='completed', last_promoted_at=now(), modified_at=now() WHERE id=$1`, [progress.id]);
      return { promoted: true, from: frontierChapter, to: null, accuracy: f.accuracy, status: 'completed' };
    }
    return { promoted: false, chapter: frontierChapter, accuracy: f.accuracy, answered: f.answered, status: 'learning' };
  }

  const next = chapters[frontierSeq].chapter;
  await exec.query(
    `UPDATE student_subject_progress SET frontier_seq=frontier_seq+1, frontier_chapter=$2, last_promoted_at=now(), modified_at=now() WHERE id=$1`,
    [progress.id, next]);
  return { promoted: true, from: frontierChapter, to: next, accuracy: f.accuracy, mastered: masteredNow, status: 'learning' };
}

/**
 * Dynamic quiz length. A child who is coasting gets the standard 10; a child
 * carrying unmastered chapters gets more practice — capped at 20 so it never
 * becomes a chore.
 *   strong (>=80% recent, no weak chapters) -> 10
 *   wobbling (>=60%, or 1 weak chapter)     -> 15
 *   struggling (<60%, or 2+ weak chapters)  -> 20
 */
async function recommendedQuestionCount(studentId, subjectId, exec = db) {
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  if (!chapters.length) return CFG.BASE_QUESTIONS;

  // recent form: last 30 answered questions
  const recent = (await exec.query(
    `SELECT COUNT(*)::int answered, COUNT(*) FILTER (WHERE is_correct)::int correct
       FROM (SELECT h.is_correct
               FROM student_quizpe_histories h
               JOIN quizpe_tracker t ON t.id = h.tracker_id
              WHERE t.student_id=$1 AND t.subject_id=$2 AND h.answered_option IS NOT NULL
              ORDER BY h.answered_at DESC NULLS LAST LIMIT 30) r`,
    [studentId, subjectId])).rows[0];

  // brand-new child: start at the standard length
  if (recent.answered < CFG.MIN_ANSWERED) return CFG.BASE_QUESTIONS;

  const acc = recent.correct / recent.answered;
  const frontierSeq = Math.min(progress.frontier_seq, chapters.length);
  const stats = await perChapterStats(studentId, subjectId, chapters, exec);
  // "weak" = enough attempts to judge AND still not mastered. A chapter the
  // child only just started isn't weak, it's simply new.
  const weakCount = stats.filter(s =>
    s.seq <= frontierSeq && s.answered >= CFG.MIN_ANSWERED && !s.mastered).length;

  let count = CFG.BASE_QUESTIONS;
  if (acc < 0.60 || weakCount >= 2) count = CFG.MAX_QUESTIONS;        // 20
  else if (acc < 0.80 || weakCount === 1) count = CFG.MID_QUESTIONS;  // 15
  return count;
}

/**
 * Consecutive days (ending today or yesterday) with a finished quiz.
 * Done entirely in SQL on DATE values — JS date conversion shifts a day in
 * non-UTC timezones like IST.
 */
async function currentStreak(studentId, exec = db) {
  const { rows } = await exec.query(
    `WITH d AS (
        SELECT DISTINCT t.quiz_date::date AS day
          FROM quizpe_tracker t JOIN quizpe_status qs ON qs.id = t.status_id
         WHERE t.student_id = $1 AND qs.status_code IN ('completed','closed')
     ), anchor AS (
        SELECT MAX(day) AS a FROM d WHERE day >= CURRENT_DATE - 1
     ), run AS (
        SELECT d.day, ROW_NUMBER() OVER (ORDER BY d.day DESC) AS rn, anchor.a
          FROM d, anchor WHERE anchor.a IS NOT NULL AND d.day <= anchor.a
     )
     SELECT COUNT(*)::int AS streak FROM run
      WHERE day = a - ((rn - 1)::int)`, [studentId]);
  return rows[0]?.streak || 0;
}

/** Compact progress summary for reports / menus. */
async function progressSummary(studentId, subjectId, exec = db) {
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  const mastered = Math.max(0, Math.min(progress.frontier_seq, chapters.length) - 1);
  return {
    frontier_chapter: progress.frontier_chapter,
    frontier_seq: progress.frontier_seq,
    mastered, total: chapters.length,
    status: progress.status,
    pct: chapters.length ? Math.round(mastered * 100 / chapters.length) : 0,
  };
}

module.exports = {
  chapterSequence, getProgress, perChapterStats, selectQuestions, evaluateAndPromote,
  progressSummary, recommendedQuestionCount, currentStreak, CFG,
};
