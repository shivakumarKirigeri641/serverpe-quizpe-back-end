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

  // A chapter must be the frontier for at least this many DAYS before mastery can
  // promote it — even for a child scoring 100%. Without this, a fast learner
  // clears a chapter in a quiz or two and the frontier races AHEAD of what the
  // school has actually taught, so the quiz asks chapters "not yet started"
  // (real parent feedback). Six days keeps advancement to ~1 chapter/week, in
  // step with a normal classroom, while leaving the child plenty of fresh, varied
  // revision on the current chapter meanwhile. The EXPOSURE_CAP escape hatch is
  // NOT time-gated, so a genuinely stuck child still moves on. Set to 0 to
  // restore the old instant-on-mastery behaviour.
  MIN_DAYS_ON_LEVEL: Number(process.env.MASTERY_MIN_DAYS_ON_LEVEL ?? 6),
  // A student with fewer than this many total answers is treated as brand-new
  // and eased in — a gentler, more foundational mix while they find their feet.
  EASE_IN_ANSWERED: Number(process.env.MASTERY_EASE_IN_ANSWERED ?? 24),
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
  // Next-chapter "stretch" questions. Turned OFF by default: they deliberately
  // showed material the school may not have taught, which is exactly the "not yet
  // started" complaint. Set MASTERY_PREVIEW_MAX=2 to bring the taste back.
  PREVIEW_MAX: Number(process.env.MASTERY_PREVIEW_MAX ?? 0),

  MAX_PER_SHAPE: 2,           // most questions of one TEMPLATE in a single quiz
  MAX_PER_CONCEPT: 3,         // most questions testing one SKILL in a single quiz
  MIN_QUESTIONS: 8,           // hard floor: never deliver fewer than this, for any
                              // grade — even a thin bank re-asks earlier questions
                              // rather than send a stub (see the backfill below)
  BASE_QUESTIONS: 15,         // doing well -> standard quiz
  MID_QUESTIONS: 18,          // wobbling  -> more practice
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

/**
 * The academic calendar: chapters are taught June → March (April/May = break).
 * A chapter's ORIGIN month (min revision) says which month it belongs to, so the
 * quiz can be anchored to the DATE — serve "June up to today's month", never a
 * future month the class has not reached. This is the school pace, month-wise.
 */
const ACAD_ORDER = [6, 7, 8, 9, 10, 11, 12, 1, 2, 3];   // June … March
const acadRank = (m) => ACAD_ORDER.indexOf(Number(m));   // June=0 … March=9, else -1

/** Where the CALENDAR is today: the current month's rank + how far through it. */
function calendarNow(d = new Date()) {
  const month = d.getMonth() + 1;
  const inYear = ACAD_ORDER.includes(month);
  // During the Apr/May break, open the whole taught year for revision.
  const rank = inYear ? acadRank(month) : ACAD_ORDER.length - 1;
  const daysInMonth = new Date(d.getFullYear(), month, 0).getDate();
  const monthProgress = inYear ? Math.min(1, d.getDate() / daysInMonth) : 1;   // 0..1 through the month
  return { month, rank, monthProgress, inYear };
}

/** Ordered chapters for a student's board/grade/subject/medium (seq 1..N) with month. */
async function chapterSequence(studentId, subjectId, exec = db) {
  const { rows } = await exec.query(
    `SELECT qb.chapter, min(qb.revision)::int AS month,
            dense_rank() OVER (ORDER BY CASE WHEN min(qb.revision) >= 6 THEN min(qb.revision)
                                             ELSE min(qb.revision) + 12 END)::int AS seq
       FROM question_bank qb
       JOIN students st ON st.id = $1
      WHERE qb.board_id = st.board_id AND qb.grade_id = st.grade_id
        AND qb.medium_id = st.medium_id AND qb.subject_id = $2 AND qb.is_active
      GROUP BY qb.chapter
      ORDER BY seq`,
    [studentId, subjectId]);
  return rows;   // [{ chapter, month, seq }]
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
      // last_promoted_at seeds the MIN_DAYS_ON_LEVEL clock from enrollment, so the
      // very first chapter is time-gated too (it is NULL otherwise, only ever set
      // on a later promotion).
      `INSERT INTO student_subject_progress (student_id, subject_id, frontier_seq, frontier_chapter, total_chapters, last_promoted_at)
       VALUES ($1,$2,1,$3,$4,now())
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
  // Never aim below the hard floor — a grade must always get at least this many.
  count = Math.max(Number(count) || 0, CFG.MIN_QUESTIONS);
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  if (!chapters.length) return { ids: [], progress, chapters };

  const stats = await perChapterStats(studentId, subjectId, chapters, exec);
  const statBy = Object.fromEntries(stats.map(s => [s.chapter, s]));

  // --- CALENDAR ANCHOR (month-wise) -----------------------------------------
  // Serve only what the school has taught by TODAY. Each chapter carries its
  // origin month; the CURRENT calendar month is the "new learning" band, earlier
  // taught months are revision, and FUTURE months are locked out entirely. The
  // current month's share ramps up through the month (light on the 1st, fuller
  // by month-end) so a just-started month is never dumped in full — the finest
  // resolution the month-tagged content allows.
  const cal = calendarNow();
  const withRank = chapters.map(c => ({ chapter: c.chapter, rank: acadRank(c.month) }))
    .filter(c => c.rank >= 0);
  // "current" = chapters of the present month; if this month has none yet (thin
  // content), fall back to the latest taught month so there is still a current band.
  let curRank = cal.rank;
  let currentBand = withRank.filter(c => c.rank === curRank).map(c => c.chapter);
  if (!currentBand.length) {
    curRank = withRank.filter(c => c.rank <= cal.rank).reduce((m, c) => Math.max(m, c.rank), -1);
    currentBand = withRank.filter(c => c.rank === curRank).map(c => c.chapter);
  }
  const revisionChapters = withRank.filter(c => c.rank >= 0 && c.rank < curRank).map(c => c.chapter);
  const taughtChapters = withRank.filter(c => c.rank <= curRank).map(c => c.chapter);   // never a future month
  const frontierChapter = currentBand[0] || taughtChapters[0] || null;

  // Weak (attempted, not-yet-mastered) taught chapters first — adaptive
  // reinforcement is kept, it just operates within the taught (calendar) range.
  const weakRevision = revisionChapters
    .filter(c => (statBy[c]?.answered || 0) > 0 && !statBy[c]?.mastered)
    .sort((a, b) => statBy[a].accuracy - statBy[b].accuracy);
  const otherRevision = revisionChapters.filter(c => !weakRevision.includes(c));

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
                      maxPerConcept = CFG.MAX_PER_CONCEPT, bannedConcepts = [],
                      anyMonth = false) => {
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
            ${anyMonth ? '' : 'AND qb.revision = qb.current_month'}
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
      opts.maxPerConcept ?? CFG.MAX_PER_CONCEPT, ignoreCap ? [] : bannedConcepts(),
      opts.anyMonth === true);
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

  // ---- WEIGHTS (calendar-anchored) ------------------------------------------
  // The current month is "new learning" and its share RAMPS UP through the month
  // (light on the 1st, fuller by the 30th), so a just-started month is a small
  // slice. The rest is revision of earlier taught months, weakest chapters first.
  // Brand-new students lean even harder on earlier, foundational revision.
  const totalAnswered = stats.reduce((a, s) => a + s.answered, 0);
  const newStudent = totalAnswered < CFG.EASE_IN_ANSWERED;
  const rawShare = 0.15 + 0.30 * cal.monthProgress;          // ~0.15 early month → ~0.45 late month
  const currentShare = revisionChapters.length ? (newStudent ? rawShare * 0.6 : rawShare) : 1;
  const currentN = currentBand.length ? Math.max(1, Math.round(count * currentShare)) : 0;

  await take(currentBand, currentN);                         // this month (new learning)
  await take(weakRevision, count - ids.length);              // weakest taught chapters first
  if (ids.length < count) await take(otherRevision, count - ids.length);   // other taught chapters

  // Top up WITHIN the taught (calendar) range only — never a future month. A
  // thin current month borrows VARIETY from earlier taught work, current-month
  // first then any revision month, and only then relaxes the caps.
  if (ids.length < count) await take(taughtChapters, count - ids.length);
  if (ids.length < count) await take(taughtChapters, count - ids.length, { anyMonth: true });
  if (ids.length < count) await take(taughtChapters, count - ids.length, { anyMonth: true, relax: true });

  // Absolute floor (MIN_QUESTIONS): everything above only ever draws questions
  // the child has NEVER seen, so a thin grade — or a child who has already seen
  // almost the whole bank — can still fall short. Rather than send fewer than
  // the minimum, re-ask earlier questions: least-recently-seen first, never a
  // future chapter, never one already in tonight's quiz. This is the only place
  // a question can repeat across quizzes, and only to reach the floor.
  if (ids.length < CFG.MIN_QUESTIONS) {
    const { rows } = await exec.query(
      `SELECT qb.id
         FROM question_bank qb JOIN students st ON st.id = $1
        WHERE qb.board_id = st.board_id AND qb.grade_id = st.grade_id
          AND qb.medium_id = st.medium_id AND qb.subject_id = $2 AND qb.is_active
          AND qb.chapter = ANY($3)
          AND NOT ( qb.id = ANY($4::bigint[]) )
        ORDER BY (SELECT MAX(t.quiz_date)
                    FROM student_quizpe_histories h
                    JOIN quizpe_tracker t ON t.id = h.tracker_id
                   WHERE t.student_id = $1 AND h.question_id = qb.id) ASC NULLS FIRST,
                 random()
        LIMIT $5`,
      [studentId, subjectId, taughtChapters, ids, CFG.MIN_QUESTIONS - ids.length]);
    for (const r of rows) { if (!seen.has(r.id)) { ids.push(r.id); seen.add(r.id); } }
  }

  return { ids: ids.slice(0, count), progress, chapters, frontierChapter,
           weakChapters: weakRevision, currentMonth: cal.month, taughtChapters };
}

/**
 * After a quiz, move the frontier forward when the current chapter is either
 * MASTERED (≥80% over ≥12) AND has been the frontier ≥ MIN_DAYS_ON_LEVEL days,
 * OR sufficiently EXPOSED (≥ EXPOSURE_CAP attempts) — so a fast learner does not
 * outrun the school, yet no child freezes. Unmastered chapters stay in the
 * reinforcement pool.
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

  // Time-gate the MASTERY path so a fast learner cannot outrun the school. A
  // chapter must have been the frontier for at least MIN_DAYS_ON_LEVEL days
  // before mastery may advance it; until then the child keeps getting fresh,
  // varied revision of the current chapter. EXPOSURE (a stuck child) bypasses
  // the gate so no one freezes. A legacy row with no timestamp is left alone —
  // we cannot know how long they have been here, so we do not hold them back.
  const daysOnLevel = progress.last_promoted_at
    ? (Date.now() - new Date(progress.last_promoted_at).getTime()) / 86400000
    : Infinity;
  if (masteredNow && !exposed && daysOnLevel < CFG.MIN_DAYS_ON_LEVEL) {
    return { promoted: false, chapter: frontierChapter, accuracy, answered,
             status: 'learning', heldForPacing: true, daysOnLevel: Math.floor(daysOnLevel) };
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
  return Math.max(CFG.MIN_QUESTIONS, count);   // never recommend below the floor
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

/** Compact progress summary for reports / menus — calendar (month) anchored. */
async function progressSummary(studentId, subjectId, exec = db) {
  const { progress, chapters } = await getProgress(studentId, subjectId, exec);
  const cal = calendarNow();
  const withRank = chapters.map(c => ({ chapter: c.chapter, rank: acadRank(c.month) })).filter(c => c.rank >= 0);
  // The current month's chapter is what the class is on now; if this month has
  // no chapter yet, fall back to the latest taught month.
  let curRank = cal.rank;
  let current = withRank.filter(c => c.rank === curRank);
  if (!current.length) {
    curRank = withRank.filter(c => c.rank <= cal.rank).reduce((m, c) => Math.max(m, c.rank), -1);
    current = withRank.filter(c => c.rank === curRank);
  }
  const taught = withRank.filter(c => c.rank <= curRank).map(c => c.chapter);
  const currentChapter = current[0]?.chapter || taught[taught.length - 1] || progress.frontier_chapter;
  // "mastered" = chapters the child has genuinely mastered among those taught so far.
  const stats = await perChapterStats(studentId, subjectId, chapters, exec);
  const mastered = stats.filter(s => taught.includes(s.chapter) && s.mastered).length;
  const total = taught.length || 1;
  return {
    frontier_chapter: currentChapter,
    frontier_seq: progress.frontier_seq,
    mastered, total,
    status: progress.status,
    pct: Math.round(mastered * 100 / total),
  };
}

module.exports = {
  chapterSequence, getProgress, perChapterStats, selectQuestions, evaluateAndPromote,
  progressSummary, recommendedQuestionCount, currentStreak, CFG,
};
