/**
 * scripts/regenerate-invoice.js
 * ---------------------------------------------------------------------------
 * Re-issue the GST invoice for a payment that was captured but never invoiced.
 *
 *   node scripts/regenerate-invoice.js pay_XXXXXXXXXXXX          # inspect only
 *   node scripts/regenerate-invoice.js pay_XXXXXXXXXXXX --write  # actually issue
 *   node scripts/regenerate-invoice.js pay_XXXXXXXXXXXX --write --send
 *
 * Why this exists: finalizeInstant() is idempotent and returns early the moment
 * the checkout is marked paid. If the invoice step failed AFTER that mark (a bad
 * migration, a disk error), reconciling again reports "already" and issues
 * nothing — the money is captured with no tax invoice against it, which is the
 * one state GST does not tolerate.
 *
 * Safe by default: without --write it only reports. It never issues a second
 * invoice for a payment that already has one.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const db = require('./../src/database/connectDB');

const PAY_ID = (process.argv[2] || '').trim();
const WRITE = process.argv.includes('--write');
const SEND = process.argv.includes('--send');

(async () => {
  if (!/^pay_[A-Za-z0-9]+$/.test(PAY_ID)) {
    console.error('Usage: node scripts/regenerate-invoice.js pay_XXXXXXXX [--write] [--send]');
    process.exit(1);
  }

  const pay = (await db.query(
    `SELECT id, payment_id, amount, status, description, contact, order_id
       FROM payments WHERE payment_id=$1`, [PAY_ID])).rows[0];
  if (!pay) {
    console.error(`No payment row for ${PAY_ID}. Reconcile it first:`);
    console.error(`  admin panel -> reconcile, or reconcileByPaymentId('${PAY_ID}')`);
    process.exit(1);
  }
  console.log(`payment   : ${pay.payment_id}  Rs ${pay.amount}  ${pay.status}  "${pay.description}"`);
  console.log(`mobile    : ${pay.contact}`);

  const inv = (await db.query(
    `SELECT invoice_id, total, invoice_path FROM invoices WHERE payment_id=$1 AND is_active
      ORDER BY id DESC LIMIT 1`, [pay.id])).rows[0];
  if (inv) {
    console.log(`invoice   : ${inv.invoice_id} (Rs ${inv.total}) — ALREADY EXISTS, nothing to do.`);
    process.exit(0);
  }
  console.log('invoice   : NONE — this payment has no tax invoice.');

  // The checkout carries who it was for. Match on the payer's number + the exact
  // amount so a parent with several purchases can never be attributed the wrong one.
  const c = (await db.query(
    `SELECT id, cart, whatsapp_session_id, mobile_number
       FROM checkout_sessions
      WHERE mobile_number=$1 AND cart IS NOT NULL
      ORDER BY id DESC LIMIT 25`, [pay.contact])).rows
    .find(r => r.cart && Math.round(Number(r.cart.total) * 100) === Math.round(Number(pay.amount) * 100));

  if (!c) { console.error('No matching checkout found (by mobile + exact amount). Cannot rebuild the line items.'); process.exit(1); }
  const isInstant = !!(c.cart && c.cart.instant);
  console.log(`checkout  : ${c.id}  ${isInstant ? 'INSTANT QUIZ' : 'subscription/other'}`);
  console.log(`child     : ${c.cart.student_name || (c.cart.student && c.cart.student.name) || '—'}`);

  if (!isInstant) {
    console.error('\nThis is NOT an instant purchase. A subscription invoice must be re-issued through');
    console.error('the normal finalize path so the subscription stays linked — not by this script.');
    process.exit(1);
  }
  if (!WRITE) { console.log('\n(dry run) re-run with --write to issue the invoice.'); process.exit(0); }

  const parent = (await db.query(
    `SELECT id, parent_name, parent_mobile_number, state_code FROM parents WHERE parent_mobile_number=$1`,
    [pay.contact])).rows[0];
  if (!parent) { console.error('No parent row for that number.'); process.exit(1); }

  const { generateInstantInvoice } = require('./../src/pdf/invoice');
  const out = await generateInstantInvoice({
    paymentDbId: pay.id,
    parent,
    student: { student_name: c.cart.student_name || (c.cart.student && c.cart.student.name) || null },
  });
  console.log(`\nISSUED    : ${out.invoiceNo}  total Rs ${out.amounts.total.toFixed(2)}`);
  console.log(`file      : ${out.filePath}`);

  if (SEND && c.whatsapp_session_id) {
    const wa = require('./../src/whatsapp/client');
    await wa.sendDocument(c.whatsapp_session_id, pay.contact, {
      filePath: out.filePath,
      filename: `QuizPe-Invoice-${out.invoiceNo}.pdf`,
      caption: `🧾 Tax invoice ${out.invoiceNo} · Total ₹${out.amounts.total.toFixed(2)} (incl. GST)`,
    });
    console.log('sent      : delivered to WhatsApp');
  }
  process.exit(0);
})().catch(e => { console.error('FAILED:'); console.error(e); process.exit(1); });
