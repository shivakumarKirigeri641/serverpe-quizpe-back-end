/**
 * src/jobs/sendPool.js
 * ---------------------------------------------------------------------------
 * Concurrency + rate control for the evening WhatsApp burst.
 *
 * The old loop sent one message, slept 250 ms, sent the next — about 4 per
 * second. That was OUR limit, not Meta's: WhatsApp Cloud API accepts roughly
 * 80 messages per second by default. At 4/sec a lakh of parents would take
 * ~14 hours; at 40/sec the same batch fits inside the evening window.
 *
 * Two controls, deliberately separate:
 *
 *   CONCURRENCY  how many sends are in flight at once. Protects US — every
 *                send also writes to Postgres, so unbounded parallelism would
 *                drain the connection pool.
 *
 *   RATE         messages per second, enforced by handing each send a time
 *                slot. Protects META — exceeding their throughput earns
 *                429s, and repeated 429s hurt the quality rating that
 *                determines the messaging tier.
 *
 * Failures never stop the batch: one parent's bad number must not cost the
 * other 99,999 their quiz.
 * ---------------------------------------------------------------------------
 */

const SEND_CONCURRENCY = Number(process.env.WA_SEND_CONCURRENCY) || 8;
const SEND_RATE_PER_SEC = Number(process.env.WA_SEND_RATE_PER_SEC) || 20;

/**
 * Hands out evenly spaced time slots. Callers await their slot before sending,
 * so the aggregate rate holds no matter how many workers are running.
 */
function rateLimiter(perSec) {
  const gapMs = 1000 / Math.max(perSec, 0.1);
  let nextSlot = 0;
  return async function slot() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gapMs;
    const wait = at - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * Run `worker(item)` over every item with bounded concurrency.
 * Resolves when all are done. Never rejects — the worker owns its errors.
 */
async function runPool(items, worker, concurrency = SEND_CONCURRENCY) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (e) {
        // a worker that throws must not kill its lane and strand the rest
        console.error('[sendPool] worker threw:', e.message);
      }
    }
  });
  await Promise.all(lanes);
}

/** Convenience: pooled + rate-limited in one call. */
async function sendAll(items, worker, {
  concurrency = SEND_CONCURRENCY, ratePerSec = SEND_RATE_PER_SEC,
} = {}) {
  const slot = rateLimiter(ratePerSec);
  const started = Date.now();
  await runPool(items, async (item, i) => {
    await slot();
    await worker(item, i);
  }, concurrency);
  return { count: items.length, seconds: (Date.now() - started) / 1000 };
}

module.exports = { sendAll, runPool, rateLimiter, SEND_CONCURRENCY, SEND_RATE_PER_SEC };
