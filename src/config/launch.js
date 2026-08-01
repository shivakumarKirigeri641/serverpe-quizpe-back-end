/**
 * src/config/launch.js
 * ---------------------------------------------------------------------------
 * The single source of truth for when QuizPe went live to real users.
 *
 * Every admin analytics window begins here. Anything before this date is
 * pre-launch testing and would only distort the real growth picture, so all
 * charts, comparisons and counts are floored to LAUNCH_DATE.
 * ---------------------------------------------------------------------------
 */
module.exports = {
  // Real-time launch to the first apartment — 26 Jul 2026 (IST).
  LAUNCH_DATE: process.env.LAUNCH_DATE || '2026-07-26',
  TZ: 'Asia/Kolkata',
};
