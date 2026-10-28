/**
 * src/admin/hq/mcq.js — PAY AS YOU ANSWER, THE ADMIN VIEW (user, 2026-10-28: "recharge concepts, how many users,
 * how much, history, total, analytics, vs inc/dec % and more", as in GaadiPe's admin). Read-only.
 *
 *   stats(days)  for the period and the one before it (with % up / down):
 *                recharges, families, new and repeat payers, ₹ (ex-GST and collected), MCQs sold, by pack;
 *                MCQs answered (free / paid / admin), students and families practising;
 *                free 50 given, used, and how many of those families went on to recharge;
 *                admin top-ups.
 *                Right now: MCQs outstanding (free / paid), families with a balance, low (≤ 20), the 31 March expiry.
 *                Per day: recharges, ₹, MCQs answered. History: the last 100 recharges. Top families by MCQs answered.
 */
const db = require('../../database/connectDB');

const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

async function period(from, to) {
  const r = (await db.query(
    `WITH rc AS (SELECT * FROM mcq_lots WHERE source = 'recharge' AND created_at >= $1 AND created_at < $2),
          firsts AS (SELECT parent_id, min(created_at) AS first_at FROM mcq_lots WHERE source = 'recharge' GROUP BY 1)
     SELECT
       (SELECT count(*) FROM rc)::int AS recharges,
       (SELECT count(DISTINCT parent_id) FROM rc)::int AS paying_families,
       (SELECT count(*) FROM firsts WHERE first_at >= $1 AND first_at < $2)::int AS new_payers,
       (SELECT count(DISTINCT rc.parent_id) FROM rc JOIN firsts f ON f.parent_id = rc.parent_id WHERE f.first_at < $1)::int AS repeat_payers,
       (SELECT coalesce(sum(rupees), 0) FROM rc)::numeric AS rupees,
       (SELECT coalesce(sum(p.amount), 0) FROM rc JOIN payments p ON p.id = rc.payment_id)::numeric AS collected,
       (SELECT coalesce(sum(mcqs), 0) FROM rc)::int AS mcqs_sold,
       (SELECT count(*) FROM mcq_usage WHERE created_at >= $1 AND created_at < $2)::int AS mcqs_answered,
       (SELECT count(*) FROM mcq_usage WHERE created_at >= $1 AND created_at < $2 AND source = 'free')::int AS free_answered,
       (SELECT count(*) FROM mcq_usage WHERE created_at >= $1 AND created_at < $2 AND source = 'recharge')::int AS paid_answered,
       (SELECT count(*) FROM mcq_usage WHERE created_at >= $1 AND created_at < $2 AND source = 'admin')::int AS admin_answered,
       (SELECT count(DISTINCT student_id) FROM mcq_usage WHERE created_at >= $1 AND created_at < $2)::int AS students_practising,
       (SELECT count(DISTINCT parent_id) FROM mcq_usage WHERE created_at >= $1 AND created_at < $2)::int AS families_practising,
       (SELECT count(*) FROM mcq_lots WHERE source = 'free' AND created_at >= $1 AND created_at < $2)::int AS free_given,
       (SELECT count(*) FROM mcq_lots f WHERE f.source = 'free' AND f.created_at >= $1 AND f.created_at < $2
           AND EXISTS (SELECT 1 FROM mcq_lots x WHERE x.parent_id = f.parent_id AND x.source = 'recharge'))::int AS free_then_paid,
       (SELECT count(*) FROM mcq_lots WHERE source = 'admin' AND created_at >= $1 AND created_at < $2)::int AS topups,
       (SELECT coalesce(sum(mcqs), 0) FROM mcq_lots WHERE source = 'admin' AND created_at >= $1 AND created_at < $2)::int AS topup_mcqs`,
    [from, to])).rows[0];
  for (const k of Object.keys(r)) r[k] = Number(r[k]);
  r.avg_recharge = r.recharges ? Math.round(r.rupees / r.recharges) : 0;
  r.per_family = r.paying_families ? Math.round(r.rupees / r.paying_families) : 0;
  r.free_conversion_pct = r.free_given ? Math.round((r.free_then_paid / r.free_given) * 1000) / 10 : null;
  return r;
}

async function stats({ days = 30 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 366);
  const now = new Date();
  const from = new Date(now - d * 864e5);
  const prevFrom = new Date(now - 2 * d * 864e5);
  const [cur, prev] = await Promise.all([period(from, now), period(prevFrom, from)]);
  const change = Object.fromEntries(Object.keys(cur).map((k) => [k, pct(cur[k], prev[k])]));

  const nowRow = (await db.query(
    `SELECT coalesce(sum(mcqs - used), 0)::int AS outstanding,
            coalesce(sum(mcqs - used) FILTER (WHERE source = 'free'), 0)::int AS outstanding_free,
            coalesce(sum(mcqs - used) FILTER (WHERE source <> 'free'), 0)::int AS outstanding_paid,
            count(DISTINCT parent_id) FILTER (WHERE mcqs > used)::int AS families_with_balance
       FROM mcq_lots WHERE expires_at > now()`)).rows[0];
  const low = (await db.query(
    `SELECT count(*)::int AS n FROM (SELECT parent_id, sum(mcqs - used) AS left FROM mcq_lots
       WHERE expires_at > now() GROUP BY 1 HAVING sum(mcqs - used) BETWEEN 1 AND 20) x`)).rows[0].n;
  const ever = (await db.query(
    `SELECT count(DISTINCT parent_id) FILTER (WHERE source = 'recharge')::int AS paying_ever,
            coalesce(sum(rupees) FILTER (WHERE source = 'recharge'), 0)::numeric AS rupees_ever,
            count(*) FILTER (WHERE source = 'recharge')::int AS recharges_ever,
            count(*) FILTER (WHERE source = 'free')::int AS free_ever
       FROM mcq_lots`)).rows[0];

  const packs = (await db.query(
    `SELECT rupees::int AS rupees, max(mcqs)::int AS mcqs, count(*)::int AS recharges, count(DISTINCT parent_id)::int AS families
       FROM mcq_lots WHERE source = 'recharge' AND created_at >= $1 GROUP BY 1 ORDER BY 1`, [from])).rows;

  const daily = (await db.query(
    `WITH d AS (SELECT generate_series(($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM mcq_lots l WHERE l.source = 'recharge' AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.day)::int AS recharges,
            (SELECT coalesce(sum(rupees), 0) FROM mcq_lots l WHERE l.source = 'recharge' AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.day)::int AS rupees,
            (SELECT count(*) FROM mcq_usage u WHERE u.used_on = d.day)::int AS answered,
            (SELECT count(*) FROM mcq_usage u WHERE u.used_on = d.day AND u.source = 'free')::int AS free_answered,
            (SELECT count(*) FROM mcq_lots l WHERE l.source = 'free' AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.day)::int AS free_given
       FROM d ORDER BY d.day`, [from])).rows;

  const history = (await db.query(
    `SELECT l.id, l.created_at, l.rupees::int AS rupees, l.mcqs, l.used, l.expires_at, l.source, l.note,
            p.id AS parent_id, p.parent_name, right(p.parent_mobile_number, 10) AS mobile,
            pay.amount AS collected, pay.payment_id, i.invoice_id
       FROM mcq_lots l
       JOIN parents p ON p.id = l.parent_id
       LEFT JOIN payments pay ON pay.id = l.payment_id
       LEFT JOIN invoices i ON i.payment_id = l.payment_id
      WHERE l.source IN ('recharge', 'admin')
      ORDER BY l.created_at DESC LIMIT 100`)).rows;

  const top = (await db.query(
    `SELECT p.id AS parent_id, p.parent_name, right(p.parent_mobile_number, 10) AS mobile, count(u.*)::int AS answered,
            (SELECT coalesce(sum(mcqs - used), 0)::int FROM mcq_lots l WHERE l.parent_id = p.id AND l.expires_at > now()) AS left,
            (SELECT coalesce(sum(rupees), 0)::int FROM mcq_lots l WHERE l.parent_id = p.id AND l.source = 'recharge') AS spent
       FROM mcq_usage u JOIN parents p ON p.id = u.parent_id
      WHERE u.created_at >= $1 GROUP BY p.id ORDER BY answered DESC LIMIT 20`, [from])).rows;

  return {
    days: d, from, cur, prev, change,
    now: { ...nowRow, low_families: low, year_end: require('../../prepaid/wallet').yearEnd() },
    ever: { ...ever, rupees_ever: Number(ever.rupees_ever) },
    packs, daily, history, top,
  };
}

module.exports = { stats };
