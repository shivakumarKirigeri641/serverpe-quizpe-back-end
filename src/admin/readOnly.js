/**
 * src/admin/readOnly.js
 * ---------------------------------------------------------------------------
 * The one way the admin dashboards are allowed to touch the database.
 *
 * `BEGIN TRANSACTION READ ONLY` is enforced by PostgreSQL itself: an INSERT,
 * UPDATE, DELETE or DDL inside one is refused by the server with SQLSTATE
 * 25006, whatever the code above it intended. That is the point — these
 * screens are read while children are mid-quiz, and a guarantee the database
 * keeps is worth more than a promise a comment makes.
 *
 * Each statement also carries its own timeout. If a dashboard query cannot
 * answer in two seconds it is killed and the panel shows nothing. A blank
 * gauge costs nobody anything; a quiz waiting behind an admin's analytics
 * query costs a child their evening.
 *
 * scripts/test-quiz-live.js proves both properties by attempting a write
 * through this helper and asserting that it fails.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const TIMEOUT_MS = Number(process.env.ADMIN_READ_TIMEOUT_MS) || 2000;

/** The business runs on IST — a quiz day is an IST day, never a UTC one. */
const TZ = 'Asia/Kolkata';

/** Today, in IST, as SQL. */
const TODAY = `(now() AT TIME ZONE '${TZ}')::date`;

async function read(sql, params = []) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    return rows;
  } catch (e) {
    // Nothing to undo in a read-only transaction, but an open one would pin
    // this connection for the rest of the evening.
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { read, TZ, TODAY, TIMEOUT_MS };
