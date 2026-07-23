/**
 * src/utils/subscriptionPeriod.js
 * ---------------------------------------------------------------------------
 * Works out when a newly purchased plan should start and end.
 *
 * THE RULE: a renewal never throws away days the parent has already paid for.
 *
 * If someone is paid up to 28 Aug and renews on 15 Aug, the new 28-day period
 * runs 29 Aug – 25 Sep, not 15 Aug – 12 Sep. Resetting from "today" would
 * quietly delete 13 paid days, and a parent only has to notice that once to
 * stop trusting us. Stacking also removes any reason to wait until the last
 * day to renew, which makes renewals arrive earlier and more predictably.
 *
 * A trial never stacks. A trial is a taster, and someone who upgrades mid-trial
 * is choosing to start the real thing — carrying unused free days forward would
 * let a plan be extended indefinitely by re-triggering trials.
 *
 * Stacking is capped (MAX_STACKED_DAYS) so nobody can buy a year in advance and
 * leave us carrying that much unearned service.
 * ---------------------------------------------------------------------------
 */

/** Beyond roughly three 28-day periods, ask the parent to renew nearer the time. */
const MAX_STACKED_DAYS = 84;

/**
 * @param client   an open pg client (so this participates in the caller's transaction)
 * @param parentId who is buying
 * @param duration length of the plan being bought, in days
 * @param opts.isTrial  true when the plan being activated is the free trial
 * @returns {{ startDate, endDate, stacked, carriedDays, cappedFrom }}
 *          startDate/endDate are 'YYYY-MM-DD' strings, safe to pass to Postgres.
 */
async function computePeriod(client, parentId, duration, opts = {}) {
  const days = Math.max(1, Number(duration) || 0);

  // Dates are handled in LOCAL time throughout. toISOString() would convert to
  // UTC, and at IST (+5:30) local midnight falls on the previous UTC day — so
  // every date would silently shift back by one and the parent would be short
  // -changed a day on every renewal.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => { const x = midnight(d); x.setDate(x.getDate() + n); return x; };
  const today = midnight(new Date());

  // A trial always starts now — see the note above.
  if (opts.isTrial) {
    return { startDate: iso(today), endDate: iso(addDays(today, days)), stacked: false, carriedDays: 0, cappedFrom: null };
  }

  // The furthest-out paid cover this parent already holds. Trials are excluded
  // so upgrading mid-trial starts immediately rather than after the free days.
  const { rows } = await client.query(
    `SELECT MAX(s.plan_end_date) AS ends
       FROM parents_quizpe_subscriptions s
       JOIN quizpe_plans p ON p.id = s.plan_id
      WHERE s.parent_id = $1
        AND COALESCE(p.is_trial, false) = false
        AND s.plan_end_date >= CURRENT_DATE`,
    [parentId]);

  // pg returns a DATE as a JS Date at local midnight; normalise so the
  // day-difference arithmetic below is not thrown off by a time component.
  const existingEnd = rows[0] && rows[0].ends ? midnight(new Date(rows[0].ends)) : null;
  if (!existingEnd || existingEnd < today) {
    return { startDate: iso(today), endDate: iso(addDays(today, days)), stacked: false, carriedDays: 0, cappedFrom: null, countsFrom: null };
  }

  // The new row STARTS TODAY even though the paid days are added to the end.
  //
  // This matters: the scheduler only sends a quiz when CURRENT_DATE falls
  // between plan_start_date and plan_end_date, and activating a renewal
  // deactivates the previous row. Dating the new row in the future would
  // therefore leave the parent with no quizzes for exactly the days they had
  // already paid for — the opposite of what stacking is meant to protect.
  //
  // So service is continuous from today, and the purchased days are added on
  // to the existing end date. Same total days, no gap.
  const carriedDays = Math.max(0, Math.ceil((existingEnd - today) / 86400000));
  let end = addDays(existingEnd, days);

  // Refuse to stack unlimited cover. The purchase still completes — we simply
  // do not extend past the cap, and the caller tells the parent.
  const cap = addDays(today, MAX_STACKED_DAYS);
  let cappedFrom = null;
  if (end > cap) { cappedFrom = iso(end); end = cap; }

  return {
    startDate: iso(today),
    endDate: iso(end),
    stacked: true,
    carriedDays,
    cappedFrom,
    // when the newly bought days actually begin counting — for messaging only
    countsFrom: iso(addDays(existingEnd, 1)),
  };
}

/** The line shown to a parent whose renewal stacked. Kept here so WhatsApp,
 *  the invoice and the website all say exactly the same thing. */
function stackedMessage(period, fmtDate) {
  if (!period.stacked) return null;
  const d = fmtDate || ((x) => x);
  const n = period.carriedDays;
  return `🎁 *Your ${n} remaining day${n === 1 ? '' : 's'} were not wasted.*\n`
       + `We added your new days on top, so your plan now runs to *${d(period.endDate)}*. `
       + `Renewing early never costs you a single day.`;
}

module.exports = { computePeriod, stackedMessage, MAX_STACKED_DAYS };
