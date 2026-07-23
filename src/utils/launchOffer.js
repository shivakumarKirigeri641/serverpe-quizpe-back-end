/**
 * src/utils/launchOffer.js
 * ---------------------------------------------------------------------------
 * The founding-families launch offer: the first N students enrol at the launch
 * price, everyone after that pays the regular price.
 *
 * ONE RULE ABOVE ALL: the price a parent is charged is decided here, on the
 * server, at the moment of checkout. The website shows a price, but the website
 * can be stale or edited — so the seat count is re-read and re-checked inside
 * the checkout transaction. A parent must never be charged a launch price for a
 * seat that has already gone, nor a regular price while seats remain.
 *
 * A seat is a paying STUDENT, not a family: a three-child plan uses three
 * seats. That is what caps the real delivery load.
 *
 * Trials do not consume seats. A free trial that used up the allocation would
 * let the offer be exhausted without a rupee earned.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const DEFAULTS = { enabled: true, cap: 50, label: 'Founding Families' };

async function settings(client = db) {
  const { rows } = await client.query(
    `SELECT key, value FROM app_settings WHERE key LIKE 'launch_offer%'`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: (m.launch_offer_enabled ?? String(DEFAULTS.enabled)) === 'true',
    cap: Number(m.launch_offer_cap ?? DEFAULTS.cap) || DEFAULTS.cap,
    label: m.launch_offer_label || DEFAULTS.label,
  };
}

/**
 * How many launch seats have been taken.
 *
 * Counts students belonging to parents who hold (or have held) a PAID
 * subscription. Deliberately not restricted to currently-active plans: a
 * founding family that lapses does not free their seat for someone else, or
 * the count would slide backwards and the banner would lie.
 */
async function seatsTaken(client = db) {
  const { rows } = await client.query(
    `SELECT COUNT(DISTINCT st.id)::int AS n
       FROM students st
       JOIN parents pa ON pa.id = st.parent_id
      WHERE EXISTS (SELECT 1
                      FROM parents_quizpe_subscriptions s
                      JOIN quizpe_plans p ON p.id = s.plan_id
                     WHERE s.parent_id = pa.id
                       AND COALESCE(p.is_trial, false) = false)`);
  return rows[0].n;
}

/** Public status, safe to show on the website. */
async function status(client = db) {
  const s = await settings(client);
  const taken = await seatsTaken(client);
  const remaining = Math.max(0, s.cap - taken);
  return {
    ...s,
    taken,
    remaining,
    // "active" means seats are still available AND the offer is switched on
    active: s.enabled && remaining > 0,
    // a progress bar reads better than a bare number
    pct_taken: s.cap > 0 ? Math.min(100, Math.round((taken / s.cap) * 100)) : 100,
  };
}

/**
 * The price to charge for a plan right now.
 *
 * @param seatsWanted how many students this purchase covers
 * @returns {{ price, regular, saving, isLaunch, seatsLeft }}
 *
 * A purchase that would straddle the cap (2 seats left, 3-child plan) is still
 * honoured at the launch price. Splitting a family's bill across two price
 * bands to save a few rupees would be a miserable first experience, and it can
 * only ever happen once.
 */
async function priceFor(plan, seatsWanted = 1, client = db) {
  const st = await status(client);
  const regular = Number(plan.regular_price ?? plan.price);
  const launch = Number(plan.price);
  const isLaunch = st.active && st.remaining > 0;
  return {
    price: isLaunch ? launch : regular,
    regular,
    launch,
    saving: isLaunch ? Math.max(0, regular - launch) : 0,
    isLaunch,
    seatsLeft: st.remaining,
    label: st.label,
  };
}

module.exports = { settings, seatsTaken, status, priceFor };
