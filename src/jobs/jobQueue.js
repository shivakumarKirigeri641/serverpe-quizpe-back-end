/**
 * src/jobs/jobQueue.js
 * ---------------------------------------------------------------------------
 * A durable, multi-process work queue backed by `job_queue`.
 *
 * Replaces the in-memory queue that used to hold report rendering. That one
 * had two faults: a restart between "quiz finished" and "report sent" lost the
 * report silently, and it could not be shared once more than one Node process
 * runs. Both matter — the first at three users, the second at three thousand.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, the standard Postgres queue pattern:
 * each worker locks only the rows it takes, so N processes drain the same
 * queue without blocking one another and without ever handing the same job to
 * two workers.
 *
 * Failed jobs retry with exponential backoff up to `max_attempts`, then park
 * as 'failed' for inspection rather than vanishing.
 * ---------------------------------------------------------------------------
 */

const os = require('os');
const db = require('../database/connectDB');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const CONCURRENCY = Number(process.env.JOB_CONCURRENCY) || 2;
const POLL_MS = Number(process.env.JOB_POLL_MS) || 2000;
// a job still 'running' after this is presumed dead (its process was killed)
const STALE_MINUTES = Number(process.env.JOB_STALE_MINUTES) || 10;

const handlers = new Map();
let running = 0;
let timer = null;
let stopped = false;

/** Register what to do for a job kind. `fn(payload)` — throw to retry. */
function register(kind, fn) { handlers.set(kind, fn); }

/**
 * Enqueue work. `dedupeKey` makes it idempotent: while a job with that key is
 * pending or running, adding it again is a no-op — so a retried finishQuiz
 * cannot queue two reports for the same tracker.
 */
async function push(kind, payload = {}, { dedupeKey = null, runAfter = null, maxAttempts = 5 } = {}) {
  const { rows } = await db.query(
    `INSERT INTO job_queue (kind, payload, dedupe_key, max_attempts, run_after)
     VALUES ($1, $2::jsonb, $3, $4, COALESCE($5::timestamptz, now()))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [kind, JSON.stringify(payload), dedupeKey, maxAttempts, runAfter]);
  return rows[0]?.id || null;
}

/** Take one job, or null. SKIP LOCKED lets many workers drain in parallel. */
async function claim() {
  const { rows } = await db.query(
    `UPDATE job_queue
        SET status = 'running', attempts = attempts + 1,
            locked_by = $1, locked_at = now()
      WHERE id = (
        SELECT id FROM job_queue
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING *`, [WORKER_ID]);
  return rows[0] || null;
}

async function finish(job, error) {
  if (!error) {
    await db.query(
      `UPDATE job_queue SET status='done', completed_at=now(), locked_by=NULL WHERE id=$1`, [job.id]);
    return;
  }
  const giveUp = job.attempts >= job.max_attempts;
  // back off 4s, 8s, 16s… so a flapping dependency isn't hammered
  const delay = Math.min(2 ** job.attempts * 2, 300);
  await db.query(
    `UPDATE job_queue
        SET status = $2, last_error = $3, locked_by = NULL,
            run_after = now() + ($4 || ' seconds')::interval
      WHERE id = $1`,
    [job.id, giveUp ? 'failed' : 'pending', String(error).slice(0, 500), String(delay)]);
  console.error(`[jobs] ${job.kind}#${job.id} ${giveUp ? 'FAILED permanently' : `retrying in ${delay}s`}: ${error}`);
}

/** Hand back jobs whose worker died mid-run, so they are not stuck forever. */
async function requeueStale() {
  const { rowCount } = await db.query(
    `UPDATE job_queue
        SET status='pending', locked_by=NULL,
            last_error = COALESCE(last_error,'') || ' [requeued: worker vanished]'
      WHERE status='running' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [String(STALE_MINUTES)]);
  if (rowCount) console.warn(`[jobs] requeued ${rowCount} stale job(s)`);
}

async function tick() {
  if (stopped) return;
  try {
    while (running < CONCURRENCY) {
      const job = await claim();
      if (!job) break;
      running++;
      const fn = handlers.get(job.kind);
      Promise.resolve()
        .then(() => fn ? fn(job.payload, job) : Promise.reject(new Error(`no handler for "${job.kind}"`)))
        .then(() => finish(job, null))
        .catch((e) => finish(job, e.message))
        .finally(() => { running--; });
    }
  } catch (e) {
    console.error('[jobs] tick failed:', e.message);
  }
}

function start() {
  if (timer || process.env.JOBS_ENABLED === '0') return;
  stopped = false;
  requeueStale().catch(() => {});
  timer = setInterval(tick, POLL_MS);
  // pick up anything left behind by the last shutdown, immediately
  tick();
  console.log(`[jobs] worker ${WORKER_ID} started (concurrency ${CONCURRENCY})`);
}

function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; }

/** Queue depth by status — used by the capacity check and health endpoint. */
async function stats() {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int n FROM job_queue GROUP BY status`);
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}

module.exports = { register, push, start, stop, stats, requeueStale, WORKER_ID };
