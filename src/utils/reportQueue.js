/**
 * src/utils/reportQueue.js
 * ---------------------------------------------------------------------------
 * A tiny in-process work queue for jobs that are slow, single-threaded and
 * must not hold up an HTTP response — currently PDF report rendering and the
 * media upload that follows it.
 *
 * Why this exists: every child finishes their quiz within a few minutes of
 * 8 PM. Rendering each report inline meant N simultaneous PDFKit runs fighting
 * for one thread, so the last child waited for everyone ahead of them and the
 * whole app stalled. Queueing keeps report work to a fixed concurrency and
 * leaves the event loop free to answer requests.
 *
 * Deliberately in-memory: a report that is lost to a restart can be
 * regenerated from the database at any time (the quiz result is already
 * committed), so the complexity of a durable queue isn't earned yet. If
 * reports ever become un-regenerable, move this to a real job table.
 * ---------------------------------------------------------------------------
 */

const CONCURRENCY = Number(process.env.REPORT_CONCURRENCY) || 2;

const queue = [];
let running = 0;

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const { job, label } = queue.shift();
    running++;
    Promise.resolve()
      .then(job)
      .catch((e) => console.error(`[reportQueue] ${label} failed: ${e.message}`))
      .finally(() => { running--; pump(); });
  }
}

/**
 * Hand work to the queue. Returns immediately — never await this expecting the
 * job to be done, and never let the caller's success depend on it.
 */
function push(job, label = 'job') {
  queue.push({ job, label });
  if (queue.length > 20) {
    console.warn(`[reportQueue] backlog ${queue.length} — reports are lagging behind`);
  }
  pump();
}

/** Queue depth, for logging and health checks. */
const stats = () => ({ queued: queue.length, running, concurrency: CONCURRENCY });

module.exports = { push, stats };
