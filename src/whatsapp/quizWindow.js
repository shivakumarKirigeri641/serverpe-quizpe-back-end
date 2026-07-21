/**
 * src/whatsapp/quizWindow.js
 * ---------------------------------------------------------------------------
 * The daily quiz WINDOW.
 *
 * A quiz is no longer a moment — it is a stretch of the evening. It opens at
 * 19:00 and closes at 23:45, and a child may answer once, whenever within that
 * suits the family. Homework overran, tuition finished late, dinner was early:
 * none of that should cost them the day.
 *
 * Two different times, often confused, so they are named apart:
 *
 *   WINDOW      19:00 → 23:45, the same for everyone. When a quiz CAN be taken.
 *   quiz_time   the parent's personal slot inside it. When we NOTIFY them.
 *
 * The personal slot is still staggered across 19:00–21:00 (see quizSlot.js),
 * because notifying tens of thousands of parents in the same minute is the
 * thing that breaks, not letting them answer whenever. So the load spreads
 * while the freedom stays whole.
 * ---------------------------------------------------------------------------
 */

const TZ = process.env.TZ_NAME || 'Asia/Kolkata';

const OPEN_MIN  = toMin(process.env.QUIZ_WINDOW_OPEN  || '19:00');
const CLOSE_MIN = toMin(process.env.QUIZ_WINDOW_CLOSE || '23:45');

function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
const fromMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 'HH:MM' right now, in the quiz timezone. */
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/**
 * Where we are in the evening.
 * @returns {'before'|'open'|'closed'}
 */
function state(at = nowHHMM()) {
  const m = toMin(at);
  if (m < OPEN_MIN) return 'before';
  if (m > CLOSE_MIN) return 'closed';
  return 'open';
}

/** Minutes left before the window shuts — for the "hurry" nudge. */
function minutesLeft(at = nowHHMM()) {
  return Math.max(0, CLOSE_MIN - toMin(at));
}

const OPEN_HHMM = fromMin(OPEN_MIN);
const CLOSE_HHMM = fromMin(CLOSE_MIN);

module.exports = {
  state, minutesLeft, nowHHMM,
  OPEN_HHMM, CLOSE_HHMM, OPEN_MIN, CLOSE_MIN, toMin, fromMin,
};
