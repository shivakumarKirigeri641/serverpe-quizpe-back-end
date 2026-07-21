/**
 * src/routers/publicRouter.js
 * ---------------------------------------------------------------------------
 * Public, unauthenticated endpoints for the parent-facing website.
 *
 *   GET /public/stats     headline numbers for a landing page
 *   GET /public/coverage  which boards, grades and mediums are actually live
 *
 * AGGREGATES ONLY. Nothing here can identify a parent, a child or a school —
 * no names, no numbers, no per-row data. These endpoints are reachable by
 * anyone on the internet, so the rule is simple: if a single person could be
 * picked out of a response, it does not belong here.
 *
 * Cached briefly in memory because a landing page can be hit far more often
 * than these numbers change.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');

const router = express.Router();
const TTL_MS = Number(process.env.PUBLIC_STATS_TTL_MS) || 60_000;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + TTL_MS });
  return value;
}

router.get('/stats', async (req, res) => {
  try {
    const stats = await cached('stats', async () => {
      const { rows: [r] } = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM parents WHERE is_active)                        AS parents,
          (SELECT COUNT(*)::int FROM students WHERE is_active)                       AS students,
          (SELECT COUNT(*)::int FROM quizpe_tracker)                                 AS quizzes_delivered,
          (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN quizpe_status s ON s.id=t.status_id
            WHERE s.status_code = 'completed')                                       AS quizzes_completed,
          (SELECT COUNT(*)::int FROM student_quizpe_histories
            WHERE answered_option IS NOT NULL)                                       AS questions_answered,
          (SELECT COUNT(*)::int FROM question_bank WHERE is_active)                  AS questions_available,
          (SELECT COUNT(*)::int FROM quiz_reports WHERE is_active)                   AS reports_generated,
          (SELECT COUNT(DISTINCT board_id)::int FROM question_bank WHERE is_active)  AS boards_live,
          (SELECT COUNT(DISTINCT grade_id)::int FROM question_bank WHERE is_active)  AS grades_live,
          (SELECT COUNT(DISTINCT state_code)::int FROM parents
            WHERE is_active AND state_code IS NOT NULL)                              AS states_reached,
          (SELECT COALESCE(ROUND(AVG(score_pct)), 0)::int FROM quiz_reports
            WHERE is_active)                                                         AS average_score_pct,
          (SELECT COALESCE(ROUND(AVG(rating), 1), 0)::numeric FROM feedbacks
            WHERE rating IS NOT NULL)                                                AS average_rating,
          (SELECT COUNT(*)::int FROM feedbacks WHERE rating IS NOT NULL)             AS ratings_count,
          (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date = CURRENT_DATE)  AS quizzes_today
      `);
      return r;
    });

    res.json({
      success: true,
      stats,
      // so a landing page can say "as of today" without guessing
      as_of: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[public] stats:', e.message);
    res.status(500).json({ success: false, error: 'Could not load statistics.' });
  }
});

/** What we can actually deliver — drives "available for" on a landing page. */
router.get('/coverage', async (req, res) => {
  try {
    const coverage = await cached('coverage', async () => {
      const { getAvailability } = require('../content/availability');
      const a = await getAvailability();
      const combos = [];
      for (const [board, grades] of Object.entries(a.availability)) {
        for (const [grade, gv] of Object.entries(grades)) {
          combos.push({
            board, grade, grade_name: gv.grade_name,
            mediums: Object.values(gv.mediums).map((m) => m.label),
          });
        }
      }
      return { boards: a.boards, grades: a.grades, combinations: combos };
    });
    res.json({ success: true, ...coverage });
  } catch (e) {
    console.error('[public] coverage:', e.message);
    res.status(500).json({ success: false, error: 'Could not load coverage.' });
  }
});

module.exports = router;
