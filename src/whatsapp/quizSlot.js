/**
 * src/whatsapp/quizSlot.js
 * ---------------------------------------------------------------------------
 * Spreads daily quiz times across the evening instead of sending everyone's
 * quiz at 8 PM.
 *
 * WHY: the 8 PM burst is the first ceiling QuizPe hits. Sending is paced, so
 * N students means N×2 messages down one pipe in one minute — at a few
 * thousand parents the last family gets their quiz long after the first.
 * Spreading over SLOT_START..SLOT_END turns one spike into a steady flow, and
 * suits families better anyway: not everyone finishes dinner at the same time.
 *
 * The slot is DERIVED FROM THE PARENT ID, not random:
 *   • the same parent always gets the same time, even if the row is rebuilt
 *   • the spread is even, with no clustering
 *   • it is reproducible, so support can explain why a parent has 7:45
 *
 * The parent can always override it (⏰ Change quiz time), and the reminder
 * follows automatically at REMINDER_LEAD_MIN before whatever they choose.
 * ---------------------------------------------------------------------------
 */

const SLOT_START_MIN = Number(process.env.QUIZ_SLOT_START_MIN) || 19 * 60;   // 19:00
const SLOT_END_MIN   = Number(process.env.QUIZ_SLOT_END_MIN)   || 21 * 60;   // 21:00
const SLOT_STEP_MIN  = Number(process.env.QUIZ_SLOT_STEP_MIN)  || 15;
// The quiz stays open for hours, so the reminder is a nudge rather than a
// countdown — 30 minutes is close enough to be useful without arriving so
// early that it is forgotten.
const REMINDER_LEAD_MIN = Number(process.env.REMINDER_LEAD_MIN) || 30;

const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Every slot we hand out, e.g. 19:00, 19:15 … 21:00. */
function slots() {
  const out = [];
  for (let m = SLOT_START_MIN; m <= SLOT_END_MIN; m += SLOT_STEP_MIN) out.push(m);
  return out;
}

/**
 * The quiz + reminder time for a parent.
 * @param {number|string} parentId
 * @returns {{quiz_time:string, reminder_time:string}} 'HH:MM'
 */
function slotFor(parentId) {
  const all = slots();
  // A plain modulo on the id spreads sequential signups evenly across slots,
  // which is exactly what we want — parent 1 -> 19:00, parent 2 -> 19:15, …
  const n = Math.abs(Number(parentId) || 0) % all.length;
  const quizMin = all[n];
  return {
    quiz_time: hhmm(quizMin),
    reminder_time: hhmm((quizMin - REMINDER_LEAD_MIN + 1440) % 1440),
  };
}

/** How many parents each slot can hold before sends overrun the window. */
function capacityPerSlot(sendPacingMs = 250, messagesPerStudent = 2) {
  const perSlotSeconds = SLOT_STEP_MIN * 60;
  return Math.floor(perSlotSeconds / ((sendPacingMs / 1000) * messagesPerStudent));
}

module.exports = {
  slotFor, slots, capacityPerSlot, hhmm,
  SLOT_START_MIN, SLOT_END_MIN, SLOT_STEP_MIN, REMINDER_LEAD_MIN,
};
