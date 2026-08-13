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

// OPEN ALL DAY, EVERY DAY: opens 06:00, closes 23:45. A child may take the quiz
// any time of day (still once per day). This replaced the old evening-only
// (19:00) window. Tune with QUIZ_WINDOW_OPEN.
const OPEN_MIN  = toMin(process.env.QUIZ_WINDOW_OPEN  || '06:00');
const CLOSE_MIN = toMin(process.env.QUIZ_WINDOW_CLOSE || '23:45');
const WEEKEND_OPEN_MIN = toMin(process.env.QUIZ_WEEKEND_OPEN || '06:00');   // same as every day now
// HOLIDAYS: dates (YYYY-MM-DD, IST) that behave like a weekend — window open all
// day, and the nudge greets "holiday" not "weekend". The founder RESERVES these
// from the admin calendar (quiz_holidays table); India's holidays are regional
// and change yearly, so they are curated, not auto-detected. QUIZ_HOLIDAYS (a
// comma-separated env list) is still honoured as an extra seed/fallback.
//
// The set is cached in memory because state() is synchronous and called on the
// hot path. A background refresh (every HOLIDAY_TTL_MS) reloads it from the DB,
// so reserving a date in the panel takes effect within minutes, no restart.
const HOLIDAY_ENV = new Set(String(process.env.QUIZ_HOLIDAYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean));
const HOLIDAY_TTL_MS = Number(process.env.HOLIDAY_TTL_MS) || 10 * 60 * 1000;   // 10 min
let holidaySet = new Set(HOLIDAY_ENV);
let holidayLoadedAt = 0;
let holidayLoading = null;

/** Reload reserved holidays from quiz_holidays into the in-memory set. */
async function refreshHolidays() {
  if (holidayLoading) return holidayLoading;
  holidayLoading = (async () => {
    try {
      const db = require('../database/connectDB');
      const { rows } = await db.query(
        `SELECT to_char(holiday_date,'YYYY-MM-DD') AS d FROM quiz_holidays WHERE is_active`);
      holidaySet = new Set([...HOLIDAY_ENV, ...rows.map((r) => r.d)]);
      holidayLoadedAt = Date.now();
    } catch (e) {
      // table may not exist yet, or DB blip — keep whatever we had, try again later
      holidayLoadedAt = Date.now();
    } finally {
      holidayLoading = null;
    }
  })();
  return holidayLoading;
}
// Warm the cache once at startup (fire-and-forget; env seed covers the gap).
refreshHolidays();

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

/** Day of week in the quiz timezone: 0=Sun … 6=Sat. */
function nowDow(d = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
}
/** Today's date as 'YYYY-MM-DD' in the quiz timezone (for holiday matching). */
function todayISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
/** Is today Saturday or Sunday (in the quiz timezone)? */
function isWeekend(d = new Date()) {
  const dow = nowDow(d);
  return dow === 0 || dow === 6;
}
/** Is today a reserved holiday? Reads the cached set; refreshes it in the
 *  background when stale (non-blocking, so the check stays synchronous). */
function isHoliday(d = new Date()) {
  if (Date.now() - holidayLoadedAt > HOLIDAY_TTL_MS) refreshHolidays();
  return holidaySet.has(todayISO(d));
}
/** Days the quiz is open all day: weekends and holidays alike. */
function isAllDayOpen(d = new Date()) {
  return isWeekend(d) || isHoliday(d);
}
/** The greeting word for an all-day day: 'holiday' | 'weekend' | null. */
function occasionFor(d = new Date()) {
  return isHoliday(d) ? 'holiday' : (isWeekend(d) ? 'weekend' : null);
}
/** Today's open minute — earlier on weekends/holidays, the usual evening slot otherwise. */
function openMinFor(d = new Date()) {
  return isAllDayOpen(d) ? WEEKEND_OPEN_MIN : OPEN_MIN;
}
/** Today's open time as 'HH:MM' — use in copy so the "opens at" line is correct. */
function openHHMM(d = new Date()) {
  return fromMin(openMinFor(d));
}

/**
 * Where we are in the day's quiz window.
 * Opens earlier on weekends (see openMinFor); closes at CLOSE_MIN every day.
 * @returns {'before'|'open'|'closed'}
 */
function state(at = nowHHMM(), d = new Date()) {
  const m = toMin(at);
  if (m < openMinFor(d)) return 'before';
  if (m > CLOSE_MIN) return 'closed';
  return 'open';
}

/** Minutes left before the window shuts — for the "hurry" nudge. */
function minutesLeft(at = nowHHMM()) {
  return Math.max(0, CLOSE_MIN - toMin(at));
}

const OPEN_HHMM = fromMin(OPEN_MIN);           // weekday open, for static copy
const CLOSE_HHMM = fromMin(CLOSE_MIN);
const WEEKEND_OPEN_HHMM = fromMin(WEEKEND_OPEN_MIN);

module.exports = {
  state, minutesLeft, nowHHMM, nowDow, todayISO,
  isWeekend, isHoliday, isAllDayOpen, occasionFor, openMinFor, openHHMM, refreshHolidays,
  OPEN_HHMM, CLOSE_HHMM, WEEKEND_OPEN_HHMM, OPEN_MIN, CLOSE_MIN, WEEKEND_OPEN_MIN, toMin, fromMin,
};
