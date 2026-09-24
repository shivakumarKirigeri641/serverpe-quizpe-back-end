/**
 * src/whatsapp/difficulty.js
 * ---------------------------------------------------------------------------
 * One place for what "easy", "medium" and "hard" actually mean.
 *
 * A parent asked for this, and the shape they asked for is a choice made fresh
 * each day: hard tomorrow, medium the day after. So the level belongs to a
 * QUIZ, not to a child — the child's own setting is only the value we
 * pre-select, never the value we enforce.
 *
 * THE BANDS ARE OVERLAPPING, AND THAT IS THE WHOLE TRICK. A strict filter on
 * level 3 can fill a quiz in only 26 of Grade 9's 60 content scopes; allowing
 * {2,3} lifts that to 58. The middle level carries 60% of the bank, so letting
 * the outer choices borrow from it is what makes the feature deliverable at all
 * rather than failing a third of the time with "no questions left".
 *
 *   easy   -> levels 1 and 2      (never 3: the point is that nothing stings)
 *   medium -> level 2 only        (its own band, or Easy and Medium would be
 *                                  the same quiz and two of three buttons
 *                                  would visibly do nothing)
 *   hard   -> levels 2 and 3      (3 alone is too thin to fill ten questions)
 *
 * GRADES 1 AND 2 ARE EXCLUDED. Not a policy choice — the bank holds nothing but
 * level 1 for them, so there is no second option to offer. They keep the single
 * Start button, unchanged.
 * ---------------------------------------------------------------------------
 */

/* OPT-IN, not opt-out.
   Deploying this code must not, by itself, change what a single live family
   sees. Asking the level replaces the one-tap Start button with a three-button
   choice, and an extra decision between a parent and the quiz is exactly the
   kind of friction that loses people — so it stays silent until
   QUIZ_DIFFICULTY=1 is set deliberately on the server, the same way the
   referral prompt works. With it unset, every path below reports "no choice",
   the band is null, and selection behaves byte for byte as it does today. */
const ON = process.env.QUIZ_DIFFICULTY === '1';

const BANDS = { 1: [1, 2], 2: [2], 3: [2, 3] };

const LABELS = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
const BUTTON = { 1: '🙂 Easy', 2: '😐 Medium', 3: '🔥 Hard' };

/** The level used when nobody has chosen one. */
const DEFAULT_LEVEL = 2;

/**
 * Medium is the default, NOT easy.
 *
 * Today's quizzes draw from the unfiltered bank, which is 60% level 2. Starting
 * every existing family on "easy" would quietly make the product easier for
 * children who never asked, lift their scores, and break the comparison against
 * their own history in the weekly report. Medium reproduces what they have now;
 * only a parent who chooses gets a change.
 */
function clamp(level) {
  const n = Number(level);
  return BANDS[n] ? n : null;
}

/** The question levels a chosen difficulty may draw from; null = no filter. */
function band(level) {
  const n = clamp(level);
  return n ? BANDS[n] : null;
}

/** Grades 1-2 have only level-1 content, so they are never offered a choice. */
function gradeAllows(gradeCode) {
  if (!ON) return false;
  const n = Number(String(gradeCode || '').replace(/^G/i, ''));
  return Number.isFinite(n) && n >= 3;
}

const label = (level) => LABELS[clamp(level)] || null;

/** The three reply buttons, with the last-used level named in the body text. */
function buttons() {
  return [1, 2, 3].map((n) => ({ id: `qd_${n}`, title: BUTTON[n] }));
}

module.exports = { ON, BANDS, LABELS, BUTTON, DEFAULT_LEVEL, clamp, band, gradeAllows, label, buttons };
