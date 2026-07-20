/**
 * src/pdf/reportNumber.js
 * ---------------------------------------------------------------------------
 * Sequential, collision-proof report filenames: <YYYYMMDD><n>.pdf
 * where n is "how many reports of this type exist, plus one" — the same shape
 * as the GST invoice numbers.
 *
 * Two things this must get right:
 *
 *  1. REGENERATION. Rebuilding a report for a tracker that already has one
 *     must reuse the SAME filename, or every rerun would leave another orphan
 *     PDF on disk while the DB row points only at the newest.
 *
 *  2. CONCURRENCY. Reports render in parallel (see utils/reportQueue), so two
 *     jobs can read the same count and pick the same number. A transaction-
 *     scoped advisory lock serialises just the numbering, per report type.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

/** Stable small int per report type, for the advisory lock key. */
const LOCK_KEYS = { daily: 8101, weekly: 8102, final: 8103, certificate: 8104 };

const TYPES = ['daily', 'weekly', 'final', 'certificate'];
const seqName = (t) => `report_seq_${TYPES.includes(t) ? t : 'daily'}`;

/**
 * Create the per-type sequences once, seeded past any reports that already
 * exist so old and new filenames can never collide.
 */
async function ensureSequences(exec = db) {
  for (const t of TYPES) {
    await exec.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName(t)} START 1`);
    const { rows: [r] } = await exec.query(
      `SELECT COUNT(*)::int n FROM quiz_reports WHERE report_type = $1`, [t]);
    // setval to at least the number of existing reports, so we start after them
    await exec.query(
      `SELECT setval($1::regclass, GREATEST($2::bigint, last_value), true) FROM ${seqName(t)}`,
      [seqName(t), r.n]);
  }
}

function compactDate(d0) {
  const d = new Date(d0);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {string} reportType  'daily' | 'weekly' | 'final' | 'certificate'
 * @param {number} trackerId   the report's tracker (null for non-quiz reports)
 * @param {Date|string} date   the report's date
 * @param {number} studentId   used to find an existing row when trackerId is null
 * @returns {Promise<string>}  e.g. "202607201.pdf"
 */
async function nextReportFileName({ reportType, trackerId, date, studentId }) {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    // serialise numbering for this report type only
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEYS[reportType] || 8199]);

    // Already numbered? Reuse it — regeneration must not mint a new file.
    const existing = (await c.query(
      `SELECT file_name FROM quiz_reports
        WHERE report_type = $1
          AND ($2::bigint IS NOT NULL AND tracker_id = $2::bigint
               OR $2::bigint IS NULL AND student_id = $3::bigint AND quiz_date = $4::date)
        LIMIT 1`,
      [reportType, trackerId || null, studentId || null, date])).rows[0];
    if (existing?.file_name) {
      await c.query('COMMIT');
      return existing.file_name;
    }

    // A sequence, not COUNT(*)+1. Counting is only correct if the row is
    // inserted before the next caller counts — but the row is written after
    // the PDF is rendered, so parallel jobs would all read the same count and
    // pick the same filename. nextval() hands out a distinct number every
    // time, which is the whole point: never two reports on one path.
    const { rows: [{ n }] } = await c.query(
      `SELECT nextval($1::regclass)::bigint AS n`, [seqName(reportType)]);
    await c.query('COMMIT');
    return `${compactDate(date)}${n}.pdf`;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { nextReportFileName, ensureSequences, compactDate };
