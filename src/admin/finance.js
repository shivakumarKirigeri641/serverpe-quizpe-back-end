/**
 * src/admin/finance.js
 * ---------------------------------------------------------------------------
 * The founder's money view — turnover, GST and what is actually safe to
 * withdraw. Separate from the GSTR-1 compliance export (that answers "what do
 * I file?"); this answers "how much of this is mine?".
 *
 * THE ONE NUMBER THAT MATTERS: withdrawable profit.
 *
 *   Collected (gross)         everything parents paid, GST included
 *   − GST set aside           the tax portion — never yours, owed to the govt
 *   = Your sales (ex-GST)     actual business income
 *   − Expenses (ex-GST)       what running the business cost, tax stripped out
 *   = Withdrawable            take this out; leave the rest working
 *
 * Equivalently, in cash terms: Collected − net GST payable − total spend.
 * A NEGATIVE result is not an error — it means marketing outran revenue this
 * month, so the honest move is to keep investing, not to draw a salary.
 *
 * GST is netted: tax collected on sales minus input tax paid on expenses. Both
 * come from real rows (invoices for sales, expenses for costs), never guessed.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

// Everything is reckoned in IST, so a sale at 11:30 PM lands in the right day
// and the right month rather than sliding into UTC yesterday.
const IST = "AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'";

/** Turn the raw sums into the founder-facing figures. Shared by every period. */
function shape(rev, exp) {
  const collected = Number(rev.collected) || 0;
  const outputGst = Number(rev.output_gst) || 0;
  const salesExGst = Number(rev.sales_ex_gst) || 0;
  const spendGross = Number(exp.spend_gross) || 0;
  const inputGst = Number(exp.input_gst) || 0;
  const spendExGst = spendGross - inputGst;
  const netGstPayable = outputGst - inputGst;      // may be negative = credit
  const withdrawable = salesExGst - spendExGst;    // = collected − netGst − spend

  return {
    collected: round(collected),
    output_gst: round(outputGst),
    sales_ex_gst: round(salesExGst),
    spend_gross: round(spendGross),
    input_gst: round(inputGst),
    spend_ex_gst: round(spendExGst),
    gst_to_pay: round(netGstPayable),
    withdrawable: round(withdrawable),
    invoices: Number(rev.n) || 0,
    expense_count: Number(exp.n) || 0,
  };
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Revenue side for a date predicate (SQL fragment on i.created_at, in IST). */
async function revenue(where, params) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(i.total),0)::numeric      AS collected,
            COALESCE(SUM(i.cgst+i.sgst+i.igst),0)::numeric AS output_gst,
            COALESCE(SUM(i.amount_base),0)::numeric AS sales_ex_gst,
            COUNT(*)::int                           AS n
       FROM invoices i
      WHERE i.is_active AND ${where}`, params);
  return rows[0];
}

/** Cost side for a date predicate (SQL fragment on e.expense_date). */
async function expenses(where, params) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(e.amount),0)::numeric     AS spend_gross,
            COALESCE(SUM(e.gst_amount),0)::numeric AS input_gst,
            COUNT(*)::int                          AS n
       FROM expenses e
      WHERE e.is_active AND ${where}`, params);
  return rows[0];
}

/** Today, this calendar month, and all-time — the headline cards. */
async function summary() {
  const today = shape(
    await revenue(`(i.created_at ${IST})::date = (now() ${IST})::date`, []),
    await expenses(`e.expense_date = (now() ${IST})::date`, []));

  const month = shape(
    await revenue(`date_trunc('month', i.created_at ${IST}) = date_trunc('month', now() ${IST})`, []),
    await expenses(`date_trunc('month', e.expense_date) = date_trunc('month', now() ${IST})`, []));

  const allTime = shape(
    await revenue(`TRUE`, []),
    await expenses(`TRUE`, []));

  return { today, month, all_time: allTime, as_of: new Date().toISOString() };
}

/** Month-by-month history, newest first — the trend the founder reads down. */
async function monthly(months = 12) {
  const { rows: rev } = await db.query(
    `SELECT to_char(date_trunc('month', i.created_at ${IST}), 'YYYY-MM') AS ym,
            SUM(i.total)::numeric collected, SUM(i.cgst+i.sgst+i.igst)::numeric output_gst,
            SUM(i.amount_base)::numeric sales_ex_gst, COUNT(*)::int n
       FROM invoices i WHERE i.is_active
        AND i.created_at ${IST} > (now() ${IST}) - ($1::int || ' months')::interval
      GROUP BY 1`, [months]);
  const { rows: exp } = await db.query(
    `SELECT to_char(date_trunc('month', e.expense_date), 'YYYY-MM') AS ym,
            SUM(e.amount)::numeric spend_gross, SUM(e.gst_amount)::numeric input_gst, COUNT(*)::int n
       FROM expenses e WHERE e.is_active
        AND e.expense_date > (now() ${IST})::date - ($1::int || ' months')::interval
      GROUP BY 1`, [months]);

  const byMonth = {};
  for (const r of rev) byMonth[r.ym] = { rev: r, exp: { spend_gross: 0, input_gst: 0, n: 0 } };
  for (const r of exp) (byMonth[r.ym] ||= { rev: { collected: 0, output_gst: 0, sales_ex_gst: 0, n: 0 }, exp: null }).exp = r;

  return Object.entries(byMonth)
    .map(([ym, v]) => ({ month: ym, ...shape(v.rev, v.exp || {}) }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/* ------------------------------------------------------------- expenses CRUD */
const CATEGORIES = ['marketing', 'hosting', 'software', 'whatsapp', 'sms',
  'payment_fees', 'content', 'salary', 'office', 'legal', 'other'];

async function listExpenses(limit = 100) {
  const { rows } = await db.query(
    `SELECT id, expense_date, category, description, vendor,
            amount::numeric, gst_amount::numeric,
            invoice_file IS NOT NULL AS has_invoice, created_at
       FROM expenses WHERE is_active ORDER BY expense_date DESC, id DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ ...r, amount: Number(r.amount), gst_amount: Number(r.gst_amount) }));
}

async function addExpense({ expense_date, category, description, vendor, amount, gst_amount, invoice_file, added_by }) {
  const amt = Number(amount);
  const gst = Number(gst_amount) || 0;
  if (!(amt > 0)) throw new Error('Amount must be greater than zero.');
  if (gst > amt) throw new Error('GST cannot be more than the total amount.');
  if (!description || !String(description).trim()) throw new Error('Please describe the expense.');
  const cat = CATEGORIES.includes(category) ? category : 'other';
  const { rows } = await db.query(
    `INSERT INTO expenses (expense_date, category, description, vendor, amount, gst_amount, invoice_file, added_by)
     VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [expense_date || null, cat, String(description).trim().slice(0, 500),
     String(vendor || '').trim().slice(0, 120) || null, amt, gst,
     invoice_file || null, added_by || null]);
  return rows[0].id;
}

/** Soft delete — a removed expense should never silently change a filed month. */
async function removeExpense(id) {
  const { rowCount } = await db.query(
    `UPDATE expenses SET is_active=false, modified_at=now() WHERE id=$1 AND is_active`, [id]);
  return rowCount > 0;
}

module.exports = { summary, monthly, listExpenses, addExpense, removeExpense, CATEGORIES };
