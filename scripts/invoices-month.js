#!/usr/bin/env node
/**
 * scripts/invoices-month.js — ONE MONTH'S TAX INVOICES, FOR THE ACCOUNTANT (2026-10-12).
 *
 *   node scripts/invoices-month.js 2026-09            -> ~/invoices-2026-09/quizpe/
 *   node scripts/invoices-month.js 2026-09 /some/dir  -> /some/dir/
 *
 * Copies every QuizPe tax invoice issued in that month (IST) into one folder, with
 * invoices.csv (number, date, buyer, place of supply, taxable, CGST, SGST, IGST, total,
 * and whether it is active). The owner's TEST- invoices are left out — they are not in
 * the statutory series and never reach GSTR-1. READ-ONLY: nothing is written to the
 * database, and a missing PDF is reported, not remade.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/database/connectDB');

const UPLOADS = path.join(__dirname, '..', 'src', 'uploads');
const month = String(process.argv[2] || '');
if (!/^\d{4}-\d{2}$/.test(month)) { console.error('Usage: node scripts/invoices-month.js YYYY-MM [folder]'); process.exit(1); }
const out = process.argv[3] || path.join(os.homedir(), `invoices-${month}`, 'quizpe');
const money = (v) => Number(v || 0).toFixed(2);
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const { rows } = await db.query(
    `SELECT i.*, to_char(i.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS inv_day,
            g.customer_name, g.place_of_supply
       FROM invoices i
       LEFT JOIN gstr1_filing g ON g.invoice_id = i.id
      WHERE to_char(i.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1
        AND i.invoice_id NOT LIKE 'TEST-%'
      ORDER BY i.created_at, i.invoice_id`, [month]);
  fs.mkdirSync(out, { recursive: true });
  const lines = ['invoice_number,invoice_date,buyer,place_of_supply,taxable,cgst,sgst,igst,total,active,pdf'];
  let copied = 0; let missing = 0;
  for (const r of rows) {
    const src = r.invoice_path ? path.join(UPLOADS, r.invoice_path) : null;
    let how = 'copied';
    if (src && fs.existsSync(src)) { fs.copyFileSync(src, path.join(out, `${r.invoice_id}.pdf`)); copied++; }
    else { missing++; how = 'MISSING on disk'; }
    lines.push([r.invoice_id, r.inv_day, r.customer_name, r.place_of_supply, money(r.amount_base), money(r.cgst), money(r.sgst),
      money(r.igst), money(r.total), r.is_active ? 'yes' : 'no', how].map(csv).join(','));
  }
  fs.writeFileSync(path.join(out, 'invoices.csv'), `${lines.join('\n')}\n`);
  /* Every captured Razorpay payment should have its invoice — one without is listed, so
     nothing paid is missed in GST (2026-10-12: "don't we have QuizPe payments?"). */
  const { rows: pays } = await db.query(
    `SELECT p.id, p.payment_id, p.amount, p.description, to_char(p.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
            EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = p.id) AS invoiced
       FROM payments p
      WHERE p.status = 'captured' AND to_char(p.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1
        AND (p.order_id IS NULL OR p.order_id NOT IN (SELECT razorpay_order_id FROM checkout_sessions WHERE razorpay_mode = 'test' AND razorpay_order_id IS NOT NULL))
      ORDER BY p.created_at`, [month]);
  const noInvoice = pays.filter((p) => !p.invoiced);
  // payments.amount is in rupees here (only the fee is in paise — hq/pnl.js).
  console.log(`Razorpay payments captured in ${month}: ${pays.length} · ₹${pays.reduce((a, p) => a + Number(p.amount || 0), 0).toFixed(2)}${noInvoice.length ? ` · ${noInvoice.length} WITHOUT an invoice:` : ' · every one has its invoice'}`);
  for (const p of noInvoice) console.log(`  ${p.day} · ${p.payment_id} · ₹${Number(p.amount).toFixed(2)} · ${p.description || ''}`);
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0).toFixed(2);
  console.log(`QuizPe ${month}: ${rows.length} invoice(s) · copied ${copied} · missing ${missing}${rows.some((r) => !r.is_active) ? ` · ${rows.filter((r) => !r.is_active).length} marked inactive` : ''}`);
  console.log(`Taxable ₹${sum('amount_base')} · CGST ₹${sum('cgst')} · SGST ₹${sum('sgst')} · IGST ₹${sum('igst')} · Total ₹${sum('total')}`);
  console.log(`Folder: ${out}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
