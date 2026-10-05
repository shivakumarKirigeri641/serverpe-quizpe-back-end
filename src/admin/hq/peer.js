/**
 * src/admin/hq/peer.js — a READ-ONLY window into GaadiPe's database
 * (user, 2026-10-05: "do not mix up both dbs").
 *
 * WHY IT EXISTS AT ALL: GaadiPe and QuizPe send WhatsApp from the same Meta
 * business portfolio, and Meta's messaging limit (250 people in any 24 hours)
 * is shared by both. Neither app can keep under it without knowing what the
 * other has sent. That one number — and Meta's account news, which arrives at
 * GaadiPe's server — is all that is read here.
 *
 * WHAT IT NEVER DOES: write. The pool is opened with
 * default_transaction_read_only=on, so even a mistaken UPDATE is refused by
 * PostgreSQL itself. No table is copied, merged or joined across databases;
 * QuizPe's data stays in QuizPe's database and GaadiPe's in GaadiPe's.
 *
 * Off unless PEER_PGDATABASE (GaadiPe's database name) is set in .env. Host,
 * port, user and password are QuizPe's own (both live on the same server), and
 * can be overridden with PEER_PGHOST / PEER_PGPORT / PEER_PGUSER / PEER_PGPASSWORD.
 */

const { Pool } = require('pg');

let pool = null;

function configured() {
  return Boolean(process.env.PEER_PGDATABASE);
}

function get() {
  if (!configured()) return null;
  if (pool) return pool;
  pool = new Pool({
    host: process.env.PEER_PGHOST || process.env.PGHOST,
    port: Number(process.env.PEER_PGPORT || process.env.PGPORT || 5432),
    user: process.env.PEER_PGUSER || process.env.PGUSER,
    password: process.env.PEER_PGPASSWORD || process.env.PGPASSWORD,
    database: process.env.PEER_PGDATABASE,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 4000,
    statement_timeout: 4000,
    // The database itself refuses any write on these connections.
    options: '-c default_transaction_read_only=on',
  });
  pool.on('error', (e) => console.error('[peer] pool error:', e.message));
  return pool;
}

/** One read-only query against GaadiPe's database, or null when not linked / unreachable. */
async function read(sql, params = []) {
  const p = get();
  if (!p) return null;
  try {
    const { rows } = await p.query(sql, params);
    return rows;
  } catch (e) {
    console.error('[peer] read failed:', e.message);
    return null;
  }
}

module.exports = { configured, read };
