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

  // A child who is clearly on top of the current chapter gets a small taste of
  // the NEXT one before the frontier formally moves. Two reasons to keep it
  // small: the school may not have taught it yet, so these are a stretch rather
  // than an expectation — and a child who meets a whole quiz of unfamiliar work
  // reads it as failure. One or two questions is curiosity; five is a wall.
  PREVIEW_ACCURACY: 0.85,     // must be doing better than "mastered" to earn it
  PREVIEW_MIN_ANSWERED: 8,    // and have answered enough for that to mean anything
  PREVIEW_MAX: 2,             // never more than this many, whatever the quiz length

  MAX_PER_SHAPE: 2,           // most questions of one TEMPLATE in a single quiz
  MAX_PER_CONCEPT: 3,         // most questions testing one SKILL in a single quiz
  BASE_QUESTIONS: 10,         // doing well -> standard quiz
  MID_QUESTIONS: 15,          // wobbling  -> more practice
  MAX_QUESTIONS: 20,          // struggling -> most practice (hard ceiling)
};

/**
 * The CONCEPT a question tests — coarser than its sentence shape.
 *
 * A frame-stem separates "Who has MORE?" from "Which is GREATER?" — different
 * grammar, but the SAME skill: comparing two numbers. In the lower grades that
 * skill is nearly half the chapter, so capping only by shape still let a child
 * meet six comparisons in one quiz, worded four different ways. This groups all
 * of them under 'compare' so the per-concept cap can hold.
 *
 * Order matters: the first branch that matches wins, so operator signals ('+',
 * 'in all', 'gave away') are tested before the looser comparison words, or an
 * addition ending "how many more" would be miscounted as a comparison.
 *
 * Evaluated over lower(question_whatsapp). Purely heuristic — it does not need
 * to be perfect, only to keep same-skill questions in the same bucket.
 */
const CONCEPT_SQL = `
  CASE
    WHEN lower(qb.question_whatsapp) ~ '₹' THEN 'money'
    WHEN lower(qb.question_whatsapp) ~ '(×|✖|multipl| in each|boxes with|rows of|times as|array)' THEN 'multiply'
    WHEN lower(qb.question_whatsapp) ~ '(÷|➗|divid|shared|share |each get|groups of|packed|per box)' THEN 'divide'
    WHEN lower(qb.question_whatsapp) ~ '( \\+ |plus|in all|altogether|how many.*(in all|now)|got \\d+ more|gets \\d+ more|buys \\d+ more|and gets)' THEN 'add'
    WHEN lower(qb.question_whatsapp) ~ '( - |−|minus|gave away|are left|how many.*left|take away|remain|spent|how many more)' THEN 'subtract'
    WHEN lower(qb.question_whatsapp) ~ '(greater|smaller|greatest|smallest|largest|biggest|who has more|who has fewer|longer|shorter|taller|heavier|lighter)' THEN 'compare'
    WHEN lower(qb.question_whatsapp) ~ '(next number|comes (just )?(before|after)|which number is between|added each time|missing (number|term)|what comes next|skip count|pattern|triangular)' THEN 'sequence'
    WHEN lower(qb.question_whatsapp) ~ '(digit|place|tens|ones|hundreds|expanded|face value)' THEN 'place_value'
    WHEN lower(qb.question_whatsapp) ~ '(number name|in words|written)' THEN 'number_name'
    WHEN lower(qb.question_whatsapp) ~ '(picture (chart|graph)|tally|how many symbols|stands for)' THEN 'data'
    ELSE 'other'
  END`;

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
    // Refresh the display chapter by SEQ (a level may hold several chapters),
    // never by array position — see the note in selectQuestions.
    const maxSeq = chapters.reduce((m, c) => Math.max(m, c.seq), 1);
    const fSeq = Math.min(p.frontier_seq, maxSeq);
    const fChapter = chapters.find(c => c.seq === fSeq)?.chapter || p.frontier_chapter;
    p = (await exec.query(
      `UPDATE student_subject_progress SET total_chapters=$3,
              frontier_chapter=$4, modified_at=now()
        WHERE id=$1 RETURNING *`,
      [p.id, subjectId, total, fChapter])).rows[0];
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

  // A "level" (seq) can hold MORE THAN ONE chapter: the NEP-restructured lower
  // grades bundle several playful-named chapters into one revision month, so
  // seq repeats. The frontier is therefore the whole SET of chapters at the
  // current seq, never a single array position — indexing chapters[seq-1] would
  // serve one chapter while mastery was judged on another that was never shown,
  // freezing the child. So everything below keys off seq, not array index.
  const maxSeq = chapters.reduce((m, c) => Math.max(m, c.seq), 1);
  const frontierSeq = Math.min(progress.frontier_seq, maxSeq);
  const frontierChapters = chapters.filter(c => c.seq === frontierSeq).map(c => c.chapter);
  const frontierChapter = frontierChapters[0];        // representative, for the return value
  const stats = await perChapterStats(studentId, subjectId, chapters, exec);

  const weakEarlier = stats.filter(s => s.seq < frontierSeq && s.answered > 0 && !s.mastered)
    .sort((a, b) => a.accuracy - b.accuracy).map(s => s.chapter);      // weakest first
  const masteredEarlier = stats.filter(s => s.seq < frontierSeq && s.mastered).map(s => s.chapter);

  /**
   * Pick `n` questions, spread across question SHAPES rather than drawn purely
   * at random.
   *
   * A plain ORDER BY random() is uniform over rows, not over kinds of question.
   * Where a chapter is dominated by one template — "Which is the GREATEST? …"
   * exists dozens of times, differing only in the numbers — a fair draw lands
   * on it again and again, and a child gets six near-identical questions in a
   * ten-question quiz. That reads as broken and teaches one skill instead of
   * the chapter.
   *
   * So each question is reduced to a `stem`: lowercased, with digits, emoji and
   * punctuation stripped, truncated to its opening words. Questions that differ
   * only by their numbers collapse to the same stem. Ranking within each stem
   * and ordering by that rank takes one of every shape first, then a second of
   * each, and so on — variety when the pool allows it, and a graceful fall back
   * to repeats only once the shapes are exhausted.
   */
  const pick = async (chapterList, n, exclude, maxPerShape = CFG.MAX_PER_SHAPE,
                      maxPerConcept = CFG.MAX_PER_CONCEPT, bannedConcepts = []) => {
    if (!n || !chapterList.length) return [];
    const { rows } = await exec.query(
      `WITH pool AS (
         SELECT qb.id,
                ${CONCEPT_SQL} AS concept,
                -- The SENTENCE FRAME, not the opening words.
                --
                -- Keeping only function words throws away everything that
                -- varies for flavour — the child's name, the object being
                -- counted, the numbers — and leaves the grammatical skeleton.
                -- So "Dev had 310 stars and got 108 more" and "Tara had 451
                -- laddus and got 235 more" both reduce to "had and got more how
                -- many in all", and count as ONE shape. Opening-words matching
                -- could not see that: the names differ at word one.
                --
                -- Non-word-problems still separate correctly, because their
                -- frames genuinely differ ("which is the", "in what is the
                -- of the digit in the place", and so on).
                array_to_string(ARRAY(
                  SELECT w FROM unnest(regexp_split_to_array(btrim(regexp_replace(
                    regexp_replace(lower(qb.question_whatsapp), '[^a-z ]', ' ', 'g'),
                    '\s+', ' ', 'g')), ' ')) AS w
                   WHERE w = ANY(ARRAY[
                     'a','all','altogether','and','another','are','as','at','before','between',
                     'by','comes','complete','count','counted','descending','ascending','did',
                     'digit','does','each','estimate','face','first','from','got','greater',
                     'greatest','had','has','have','how','in','is','it','its','just','left',
                     'less','many','middle','more','much','name','nearest','of','on','order',
                     'place','put','remain','round','same','sits','smallest','sum','than',
                     'the','then','there','these','they','to','total','value','what','which',
                     'while','who','why','words','write','written'])
                ), ' ') AS stem
           FROM question_bank qb JOIN students st ON st.id = $1
          WHERE qb.board_id = st.board_id AND qb.grade_id = st.grade_id
            AND qb.medium_id = st.medium_id AND qb.subject_id = $2 AND qb.is_active
            AND qb.revision = qb.current_month
            AND qb.chapter = ANY($3)
            AND NOT ( qb.id = ANY($5::bigint[]) )
            AND NOT EXISTS (SELECT 1 FROM student_quizpe_histories h
                              JOIN quizpe_tracker t ON t.id = h.tracker_id
                             WHERE t.student_id = $1 AND h.question_id = qb.id)
       ), ranked AS (
         SELECT id, concept,
                row_number() OVER (PARTITION BY stem    ORDER BY random()) AS rn_shape,
                row_number() OVER (PARTITION BY concept ORDER BY random()) AS rn_concept
           FROM pool
       )
       -- Two caps, both must hold:
       --   per SHAPE  — no four copies of one template (thin chapters like
       --               KSEAB Grade 7 "Fractions", 3,600 questions from 3 shapes)
       --   per CONCEPT — no six comparisons worded four ways (the Grade 1
       --               complaint). Ordering by rn_concept first lays down one
       --               of each skill before any second, so a short quiz is
       --               spread across skills rather than clustered.
       -- Returning FEWER than asked is deliberate: the caller tops up from
       -- other unlocked chapters, a better quiz than repetition.
       SELECT id, concept FROM ranked
        WHERE rn_shape <= $6 AND rn_concept <= $7
          AND concept <> ALL($8::text[])
        ORDER BY rn_concept, rn_shape, random() LIMIT $4`,
      [studentId, subjectId, chapterList, n, exclude, maxPerShape, maxPerConcept, bannedConcepts]);
    return rows;   // [{ id, concept }]
  };

  // ---- assembly with a GLOBAL concept budget --------------------------------
  // Each pick() spreads WITHIN its own draw, but a quiz is built from several
  // draws (weak + frontier + revision + top-up), so the same concept can creep
  // past the cap across them. The budget below is the single enforcement point:
  // a concept already at the cap is both excluded from the next SQL draw AND
  // refused here, so the finished quiz can never exceed it.
  const ids = [];
  const seen = new Set();
  const conceptCount = {};
  const bannedConcepts = () => Object.keys(conceptCount).filter(k => conceptCount[k] >= CFG.MAX_PER_CONCEPT);

  const take = async (chapterList, n, opts = {}) => {
    const want = Math.min(n, count - ids.length);
    if (want <= 0 || !chapterList.length) return [];
    const ignoreCap = opts.relax === true;
    const rows = await pick(
      chapterList, n, ids, opts.maxPerShape ?? CFG.MAX_PER_SHAPE,
      opts.maxPerConcept ?? CFG.MAX_PER_CONCEPT, ignoreCap ? [] : bannedConcepts());
    const added = [];
    for (const r of rows) {
      if (ids.length >= count) break;
      if (seen.has(r.id)) continue;
      // The real cap: never let a concept exceed the budget, even if a draw
      // over-supplied it (a concept sitting at 2 is not yet banned in SQL).
      if (!ignoreCap && (conceptCount[r.concept] || 0) >= CFG.MAX_PER_CONCEPT) continue;
      ids.push(r.id); seen.add(r.id); added.push(r.id);
      conceptCount[r.concept] = (conceptCount[r.concept] || 0) + 1;
    }
    return added;
  };

  // Stretch questions from the NEXT level, for a child who has the current one
  // well in hand. Mastery of the frontier is judged across ALL chapters at the
  // current seq, aggregated — not one of them.
  const level = stats.filter(s => s.seq === frontierSeq);
  const fAnswered = level.reduce((a, s) => a + s.answered, 0);
  const fAccuracy = fAnswered ? level.reduce((a, s) => a + s.correct, 0) / fAnswered : 0;
  const nextChapters = chapters.filter(c => c.seq === frontierSeq + 1).map(c => c.chapter);
  const earnsPreview = nextChapters.length
    && fAnswered >= CFG.PREVIEW_MIN_ANSWERED
    && fAccuracy >= CFG.PREVIEW_ACCURACY;
  let previewCount = 0;
  if (earnsPreview) {
    previewCount = (await take(nextChapters, Math.min(CFG.PREVIEW_MAX, Math.max(1, Math.floor(count * 0.1))))).length;
  }

  const reinforceN = weakEarlier.length ? Math.round(count * CFG.REINFORCE_RATIO) : 0;
  const frontierN = Math.round(count * CFG.FRONTIER_RATIO) + (masteredEarlier.length ? 0 : Math.round(count * 0.2));

  await take(weakEarlier, reinforceN);
  await take(frontierChapters, Math.max(frontierN, count - ids.length - (masteredEarlier.length ? Math.round(count * 0.2) : 0)));
  if (ids.length < count && masteredEarlier.length) await take(masteredEarlier, count - ids.length);

  // Top up from any unlocked chapter — concept budget still holds, so a thin
  // frontier borrows VARIETY from earlier work rather than repeating itself.
  const unlocked = chapters.slice(0, frontierSeq).map(c => c.chapter);
  if (ids.length < count) await take(unlocked, count - ids.length);

  // Last resort: the child is genuinely out of fresh, varied questions. Relax
  // both caps rather than send a short quiz — a repeat is a worse quiz, but
  // eight questions instead of ten is a broken one.
  if (ids.length < count) await take(unlocked, count - ids.length, { relax: true });

  return { ids: ids.slice(0, count), progress, chapters, frontierChapter, weakChapters: weakEarlier,
           previewChapter: previewCount ? nextChapters[0] : null, previewCount };
}

/**
 * After a quiz, move the frontier forward when the current chapter is either
 * MASTERED (≥80% over ≥12) OR sufficiently EXPOSED (≥ EXPOSURE_CAP attempts) —
 * so no child freezes. Unmastered chapters stay in the reinforcement pool.
 */
async function evaluateAndPromote(studentId, subjectId, exec = db) {
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  if (progress.status === 'completed' || !chapters.length) return { promoted: false, status: progress.status };

  const maxSeq = chapters.reduce((m, c) => Math.max(m, c.seq), 1);
  const frontierSeq = Math.min(progress.frontier_seq, maxSeq);
  const frontierChapter = chapters.find(c => c.seq === frontierSeq)?.chapter || null;
  const stats = await perChapterStats(studentId, subjectId, chapters, exec);

  // Judge the whole LEVEL: sum answers across every chapter sharing this seq, so
  // a two-chapter month is mastered on its combined record, not one half of it.
  const level = stats.filter(s => s.seq === frontierSeq);
  const answered = level.reduce((a, s) => a + s.answered, 0);
  const correct = level.reduce((a, s) => a + s.correct, 0);
  const accuracy = answered ? correct / answered : 0;
  const masteredNow = answered >= CFG.MIN_ANSWERED && accuracy >= CFG.MASTERY_ACCURACY;
  const exposed = answered >= CFG.EXPOSURE_CAP;
  if (!masteredNow && !exposed) {
    return { promoted: false, chapter: frontierChapter, accuracy, answered, status: 'learning' };
  }

  if (frontierSeq >= maxSeq) {
    // reached the last level — only "complete" once it is genuinely mastered
    if (masteredNow) {
      await exec.query(`UPDATE student_subject_progress SET status='completed', last_promoted_at=now(), modified_at=now() WHERE id=$1`, [progress.id]);
      return { promoted: true, from: frontierChapter, to: null, accuracy, status: 'completed' };
    }
    return { promoted: false, chapter: frontierChapter, accuracy, answered, status: 'learning' };
  }

  // The next level's representative chapter — found by seq, not array position.
  const next = chapters.find(c => c.seq === frontierSeq + 1)?.chapter || frontierChapter;
  await exec.query(
    `UPDATE student_subject_progress SET frontier_seq=frontier_seq+1, frontier_chapter=$2, last_promoted_at=now(), modified_at=now() WHERE id=$1`,
    [progress.id, next]);
  return { promoted: true, from: frontierChapter, to: next, accuracy, mastered: masteredNow, status: 'learning' };
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
  // Progress is measured in LEVELS (seq), not raw chapters — a level may bundle
  // several chapters, so counting chapters would understate how far along a
  // child in the lower grades actually is.
  const maxSeq = chapters.reduce((m, c) => Math.max(m, c.seq), 1);
  const mastered = Math.max(0, Math.min(progress.frontier_seq, maxSeq) - 1);
  return {
    frontier_chapter: progress.frontier_chapter,
    frontier_seq: progress.frontier_seq,
    mastered, total: maxSeq,
    status: progress.status,
    pct: maxSeq ? Math.round(mastered * 100 / maxSeq) : 0,
  };
}

module.exports = {
  chapterSequence, getProgress, perChapterStats, selectQuestions, evaluateAndPromote,
  progressSummary, recommendedQuestionCount, currentStreak, CFG,
};
