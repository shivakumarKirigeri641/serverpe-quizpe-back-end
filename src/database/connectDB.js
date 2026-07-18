/**
 * src/database/connectDB.js
 * ---------------------------------------------------------------------------
 * Single shared PostgreSQL connection pool (singleton) for the whole app.
 *
 * `pg.Pool` reads its connection settings from the standard PG* env vars
 * (PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE) loaded from .env, so
 * no config is passed here — keep the .env as the single source of truth.
 *
 * Require it anywhere and reuse the same pool:
 *   const db = require('./database/connectDB');
 *   const { rows } = await db.query('SELECT * FROM quizpe_plans WHERE id = $1', [id]);
 *
 * For multi-statement work that must share one connection (transactions), grab
 * a client and always release it:
 *   const client = await db.getClient();
 *   try { await client.query('BEGIN'); ...; await client.query('COMMIT'); }
 *   catch (e) { await client.query('ROLLBACK'); throw e; }
 *   finally { client.release(); }
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const { Pool } = require('pg');

// Guard against multiple pools when this module is required more than once
// (e.g. across differing require cache keys). Stash the singleton on globalThis.
const globalKey = Symbol.for('serverpe.quizpe.pgPool');

/** @type {import('pg').Pool} */
const pool =
  globalThis[globalKey] ||
  (globalThis[globalKey] = new Pool({
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }));

// Surface pool-level errors on idle clients instead of crashing silently.
pool.on('error', (err) => {
  console.error('[database] unexpected idle client error:', err.message);
});

module.exports = {
  pool,

  /** Run a one-off query on the pool. */
  query: (text, params) => pool.query(text, params),

  /** Check out a client for transactions; caller MUST release() it. */
  getClient: () => pool.connect(),

  /** Simple connectivity check — resolves true if the DB answers. */
  async ping() {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return rows[0].ok === 1;
  },

  /** Close the pool (call on graceful shutdown). */
  close: () => pool.end(),
};
