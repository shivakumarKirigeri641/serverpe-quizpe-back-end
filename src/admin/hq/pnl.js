/**
 * src/admin/hq/pnl.js — QuizPe's profit & loss for a period (user, 2026-10-05,
 * admin revamp phase 4), the same statement as GaadiPe's in QuizPe's terms:
 *
 *   what families paid (invoices, GST included)
 *   − GST paid to the government            = revenue
 *   − Razorpay (actual fee where stored, else estimated)
 *   − WhatsApp templates (marketing / utility rate per template sent)
 *   = left from sales
 *   − Meta ads for QuizPe (hq_ads_daily_paise a day, unless "ads" expenses
 *     were entered for the period)
 *   − other expenses entered on Finance → Expenses
 *   − fixed costs (hq_fixed_monthly_paise, spread over the days)
 *   = profit or loss
 *
 * GST paid ON costs is left out: it is claimed back as input credit.
 * READ-ONLY.
 */

const db = require('../../database/connectDB');
const shared = require('./shared');

const MARKETING = /promo|winback|offer|referral|announcement|promote|weekend/i;

async function statement(days = 30) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const since = `now() - make_interval(days => ${d})`;
  const { rows: [inv] } = await db.query(
    `SELECT count(*)::int AS invoices, coalesce(sum(total), 0)::float AS paid, coalesce(sum(amount_base), 0)::float AS taxable,
            coalesce(sum(coalesce(cgst, 0) + coalesce(sgst, 0) + coalesce(igst, 0)), 0)::float AS gst
       FROM invoices WHERE is_active AND created_at > ${since}`);
  const { rows: [pay] } = await db.query(
    `SELECT coalesce(sum(amount), 0)::float AS amount, coalesce(sum(fee), 0)::float AS fee, count(*) FILTER (WHERE fee IS NULL)::int AS no_fee,
            coalesce(sum(amount) FILTER (WHERE fee IS NULL), 0)::float AS amount_no_fee
       FROM payments WHERE status = 'captured' AND created_at > ${since}
        -- Not the owner's TEST-mode payments (2026-10-10); their invoices are inactive already.
        AND ${require('./notMe').payment('payments')}`);
  // Razorpay stores fee in paise when it gives one; the estimate is 2% + 18% GST, GST left out (input credit).
  const feePct = Number(await shared.setting('hq_razorpay_fee_percent', '2')) || 2;
  const gateway = pay.fee / 100 + (pay.amount_no_fee * feePct) / 100;

  const { rows: tpl } = await db.query(
    `SELECT coalesce(payload->'template'->>'name', '') AS name, count(*)::int AS n
       FROM whatsapp_messages WHERE direction = 'outbound' AND message_type = 'template'
        AND coalesce(status, '') <> 'failed' AND created_at > ${since} GROUP BY 1`);
  const mRate = (await shared.num('hq_whatsapp_marketing_paise', 85)) / 100;
  const uRate = (await shared.num('hq_whatsapp_utility_paise', 11)) / 100;
  const marketing = tpl.filter((t) => MARKETING.test(t.name)).reduce((a, t) => a + t.n, 0);
  const utility = tpl.reduce((a, t) => a + t.n, 0) - marketing;
  const whatsapp = marketing * mRate + utility * uRate;

  const { rows: exp } = await db.query(
    `SELECT lower(coalesce(category, 'other')) AS category, coalesce(sum(amount), 0)::float AS amount
       FROM expenses WHERE is_active AND expense_date > CURRENT_DATE - $1::int GROUP BY 1`, [d]);
  const adsEntered = exp.filter((e) => /ad|marketing|meta|facebook|instagram/.test(e.category)).reduce((a, e) => a + e.amount, 0);
  const otherExpenses = exp.filter((e) => !/ad|marketing|meta|facebook|instagram/.test(e.category)).reduce((a, e) => a + e.amount, 0);
  const adsDaily = (await shared.num('hq_ads_daily_paise', 10000)) / 100;
  const ads = adsEntered > 0 ? adsEntered : adsDaily * d;
  const fixedMonthly = (await shared.num('hq_fixed_monthly_paise', 0)) / 100;
  const fixed = (fixedMonthly * d) / 30;

  const revenue = inv.paid - inv.gst;
  const fromSales = revenue - gateway - whatsapp;
  const profit = fromSales - ads - otherExpenses - fixed;
  const takeHome = inv.invoices ? fromSales / inv.invoices : null;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    days: d, invoices: inv.invoices,
    paid: r2(inv.paid), gst: r2(inv.gst), revenue: r2(revenue),
    gateway: r2(gateway), gateway_estimated: pay.no_fee, fee_percent: feePct,
    whatsapp: r2(whatsapp), templates: { marketing, utility, marketing_rate: mRate, utility_rate: uRate },
    from_sales: r2(fromSales),
    ads: r2(ads), ads_source: adsEntered > 0 ? 'expenses' : 'assumed', ads_daily: adsDaily,
    other_expenses: r2(otherExpenses), expenses_by_category: exp,
    fixed: r2(fixed), fixed_monthly: fixedMonthly,
    profit: r2(profit),
    take_home_per_sale: takeHome === null ? null : r2(takeHome),
    sales_to_break_even: takeHome > 0 ? Math.ceil((ads + otherExpenses + fixed) / takeHome) : null,
  };
}

async function saveAssumptions({ ads_daily, fixed_monthly }) {
  const set = async (k, rupees) => {
    const n = Math.round(Number(rupees) * 100);
    if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Enter amounts in rupees.'), { status: 400 });
    await db.query(`UPDATE app_settings SET value = $2 WHERE key = $1`, [k, String(n)]);
  };
  if (ads_daily !== undefined) await set('hq_ads_daily_paise', ads_daily);
  if (fixed_monthly !== undefined) await set('hq_fixed_monthly_paise', fixed_monthly);
  shared.forget();
  return { ok: true };
}

module.exports = { statement, saveAssumptions };
