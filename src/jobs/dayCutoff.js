/**
 * src/jobs/dayCutoff.js
 * ---------------------------------------------------------------------------
 * The daily hard stop (23:58 IST by default).
 *
 * A quiz belongs to ONE day. Without a cutoff, a quiz opened at 8 PM and left
 * unfinished stays 'in_progress' for ever, its link keeps working into the
 * next morning, and the day's result is never settled — so streaks, mastery
 * and reports all read from a day that never ended.
 *
 * At the cutoff every unsettled tracker for today is closed:
 *
 *   answered nothing      -> 'skipped'   (they never started)
 *   answered some, not all-> 'closed'    (partial attempt, still scored)
 *   unanswered questions  -> 'closed'    (so nothing stays 'scheduled')
 *
 * and every quiz link for today is spent, so a late tap gets the expired
 * message instead of resuming yesterday's quiz.
 *
 * Deliberately does NOT send WhatsApp messages: this runs two minutes before
 * midnight and nobody wants their phone lighting up then. The results are
 * saved and appear in the reports.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const CUTOFF_HHMM = process.env.DAY_CUTOFF_HHMM || '23:58';

async function closeOutDay() {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    // Everything still open for today.
    const open = (await c.query(
      `SELECT t.id,
              (SELECT COUNT(*)::int FROM student_quizpe_histories h
                WHERE h.tracker_id = t.id AND h.answered_option IS NOT NULL) AS answered
         FROM quizpe_tracker t
         JOIN quizpe_status qs ON qs.id = t.status_id
        WHERE t.quiz_date = CURRENT_DATE
          AND qs.status_code IN ('scheduled','delivered','yet_to_start','in_progress')
        FOR UPDATE OF t`)).rows;

    if (!open.length) { await c.query('COMMIT'); return { closed: 0, skipped: 0, links: 0 }; }

    const ids = open.map(r => r.id);
    const skipped = open.filter(r => r.answered === 0).map(r => r.id);
    const partial = open.filter(r => r.answered > 0).map(r => r.id);

    // Unanswered questions never stay 'scheduled' into the next day.
    await c.query(
      `UPDATE student_quizpe_histories
          SET status_id = (SELECT id FROM quizpe_status WHERE status_code='closed'), modified_at = now()
        WHERE tracker_id = ANY($1::bigint[]) AND answered_option IS NULL`, [ids]);

    if (skipped.length) {
      await c.query(
        `UPDATE quizpe_tracker
            SET status_id = (SELECT id FROM quizpe_status WHERE status_code='skipped'), modified_at = now()
          WHERE id = ANY($1::bigint[])`, [skipped]);
    }
    if (partial.length) {
      await c.query(
        `UPDATE quizpe_tracker
            SET status_id = (SELECT id FROM quizpe_status WHERE status_code='closed'), modified_at = now()
          WHERE id = ANY($1::bigint[])`, [partial]);
    }

    // Spend today's links so a late tap can't reopen a closed quiz.
    const links = await c.query(
      `UPDATE quiz_links SET finished_at = COALESCE(finished_at, now()), expires_at = now()
        WHERE tracker_id = ANY($1::bigint[]) AND finished_at IS NULL`, [ids]);

    await c.query('COMMIT');
    const out = { closed: partial.length, skipped: skipped.length, links: links.rowCount };
    console.log(`[cutoff] day closed — ${out.skipped} skipped, ${out.closed} partial, ${out.links} links expired`);
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('[cutoff] failed:', e.message);
    throw e;
  } finally {
    c.release();
  }
}

/** True when the day's quiz window has closed (used to refuse late starts). */
function pastCutoff(nowHHMM) {
  return nowHHMM >= CUTOFF_HHMM;
}

module.exports = { closeOutDay, pastCutoff, CUTOFF_HHMM };
