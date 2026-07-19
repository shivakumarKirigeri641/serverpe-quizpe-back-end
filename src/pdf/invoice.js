/**
 * src/pdf/invoice.js
 * ---------------------------------------------------------------------------
 * GST tax-invoice PDF for a paid subscription.
 *
 *   invoice number = <YYYYMMDD><global invoice count + 1>   e.g. 202607180001
 *   saved as       src/uploads/invoices/<invoice_number>.pdf
 *
 * Prices are treated as GST-INCLUSIVE (₹99 is what the parent pays). GST is
 * split CGST+SGST for an in-Karnataka customer, else a single IGST line.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('../database/connectDB');

const DIR = path.join(__dirname, '..', 'uploads', 'invoices');
const BUSINESS_STATE = '29';   // Karnataka — home state for intra/inter GST

const C = { brand: '#075e54', accent: '#00a884', ink: '#111b21', muted: '#667781', line: '#e2e6e9', soft: '#f6f8f9', white: '#fff' };
const money = (n) => `Rs. ${Number(n).toFixed(2)}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** Next invoice number: date + (global count + 1), zero-padded to 4. */
async function nextInvoiceNumber(exec = db) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const { rows } = await exec.query(`SELECT COUNT(*)::int n FROM invoices`);
  return `${ymd}${String(rows[0].n + 1).padStart(4, '0')}`;
}

async function generateInvoice(subscriptionId, paymentDbId = null, exec = db) {
  const head = (await exec.query(
    `SELECT s.id AS subscription_id, s.plan_start_date, s.plan_end_date,
            pl.plan_code, pl.plan_name, pl.price, pl.student_count, pl.duration,
            p.id AS parent_id, p.parent_name, p.parent_mobile_number, p.state_code,
            su.state_name,
            pay.payment_id AS rzp_payment_id, pay.order_id AS rzp_order_id, pay.method
       FROM parents_quizpe_subscriptions s
       JOIN quizpe_plans pl ON pl.id = s.plan_id
       JOIN parents p ON p.id = s.parent_id
       LEFT JOIN states_unions su ON su.state_code = p.state_code
       LEFT JOIN payments pay ON pay.id = $2
      WHERE s.id = $1`, [subscriptionId, paymentDbId])).rows[0];
  if (!head) throw new Error(`subscription ${subscriptionId} not found`);

  const biz = (await exec.query(
    `SELECT company_name, company_tagline, product_name, proprietor_name, gstin, pan,
            address, support_email, product_website, gst_state_code
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};
  const gstRow = (await exec.query(`SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  const gstPct = gstRow ? Number(gstRow.gst_value) : 18;

  // price is GST-inclusive
  const gross = Number(head.price);
  const base = +(gross * 100 / (100 + gstPct)).toFixed(2);
  const gstAmt = +(gross - base).toFixed(2);
  const intra = (head.state_code || BUSINESS_STATE) === BUSINESS_STATE;
  const cgst = intra ? +(gstAmt / 2).toFixed(2) : 0;
  const sgst = intra ? +(gstAmt - cgst).toFixed(2) : 0;
  const igst = intra ? 0 : gstAmt;

  const invoiceNo = await nextInvoiceNumber(exec);
  fs.mkdirSync(DIR, { recursive: true });
  const fileName = `${invoiceNo}.pdf`;
  const filePath = path.join(DIR, fileName);

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `Tax Invoice ${invoiceNo}`, Author: biz.company_name || 'QuizPe' } });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const M = 40, PW = doc.page.width, W = PW - M * 2;

  // header
  doc.rect(0, 0, PW, 96).fill(C.brand);
  doc.rect(0, 96, PW, 3).fill(C.accent);
  const logo = require('../assets/buildLogo').paths.white;
  if (fs.existsSync(logo)) doc.image(logo, M, 22, { height: 36 });
  else doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22).text(biz.product_name || 'QuizPe', M, 28);
  doc.fillColor('#cfe9e2').font('Helvetica').fontSize(8).text(`Powered by ${biz.company_name || 'ServerPe App Solutions'}`, M, 62);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(16).text('TAX INVOICE', M, 34, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#cfe9e2')
     .text(`No: ${invoiceNo}`, M, 58, { width: W, align: 'right' })
     .text(`Date: ${fmtDate(new Date())}`, M, 70, { width: W, align: 'right' });

  let y = 118;

  // seller / buyer
  const colW = (W - 20) / 2;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('SELLER', M, y);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(biz.company_name || 'QuizPe', M, y + 12);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
     .text(biz.address || '', M, y + 28, { width: colW })
     .text(`GSTIN: ${biz.gstin || ''}   ·   PAN: ${biz.pan || ''}`, M, doc.y + 2, { width: colW })
     .text(`${biz.support_email || ''}   ·   ${biz.product_website || ''}`, M, doc.y + 2, { width: colW });

  const bx = M + colW + 20;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('BILL TO', bx, y);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(head.parent_name || 'Customer', bx, y + 12);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
     .text(`Mobile: ${head.parent_mobile_number}`, bx, y + 28, { width: colW })
     .text(`State: ${head.state_name || '—'} (${head.state_code || '—'})`, bx, doc.y + 2, { width: colW })
     .text(`Place of supply: ${head.state_name || 'Karnataka'}`, bx, doc.y + 2, { width: colW });

  y = Math.max(doc.y, y + 70) + 16;

  // line-items table
  const cols = [
    { t: 'Description', w: W * 0.46, a: 'left' },
    { t: 'Plan', w: W * 0.14, a: 'left' },
    { t: 'Qty', w: W * 0.08, a: 'center' },
    { t: 'Taxable', w: W * 0.16, a: 'right' },
    { t: 'Amount', w: W * 0.16, a: 'right' },
  ];
  doc.rect(M, y, W, 22).fill(C.brand);
  let cx = M;
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5);
  cols.forEach(c => { doc.text(c.t.toUpperCase(), cx + 6, y + 7, { width: c.w - 12, align: c.a }); cx += c.w; });
  y += 22;

  const desc = `${head.plan_name} — daily quizzes for ${head.duration} days\n` +
               `${head.student_count} child${head.student_count > 1 ? 'ren' : ''} · ${fmtDate(head.plan_start_date)} to ${fmtDate(head.plan_end_date)}`;
  doc.rect(M, y, W, 40).fillAndStroke(C.white, C.line);
  cx = M;
  const cells = [desc, head.plan_code, '1', money(base), money(gross)];
  cols.forEach((c, i) => {
    doc.fillColor(C.ink).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 0 ? 9 : 9)
       .text(cells[i], cx + 6, y + 8, { width: c.w - 12, align: c.a });
    cx += c.w;
  });
  y += 52;

  // totals
  const tW = W * 0.42, tx = M + W - tW;
  const rowsT = [
    ['Taxable value', money(base)],
    intra ? [`CGST @ ${gstPct / 2}%`, money(cgst)] : null,
    intra ? [`SGST @ ${gstPct / 2}%`, money(sgst)] : null,
    !intra ? [`IGST @ ${gstPct}%`, money(igst)] : null,
  ].filter(Boolean);
  rowsT.forEach(r => {
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(r[0], tx, y, { width: tW * 0.55 });
    doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(r[1], tx + tW * 0.55, y, { width: tW * 0.45, align: 'right' });
    y += 16;
  });
  doc.rect(tx, y, tW, 26).fill(C.soft);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text('TOTAL PAID', tx + 6, y + 8, { width: tW * 0.55 });
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(13).text(money(gross), tx + tW * 0.55, y + 6, { width: tW * 0.45 - 6, align: 'right' });
  y += 40;

  // payment ref
  if (head.rzp_payment_id) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
       .text(`Payment ID: ${head.rzp_payment_id}   ·   Order ID: ${head.rzp_order_id || '—'}   ·   Method: ${head.method || 'online'}   ·   Status: PAID`, M, y, { width: W });
    y += 20;
  }

  // notes / footer
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.line).stroke(); y += 10;
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
     .text('This is a computer-generated tax invoice and does not require a signature.', M, y, { width: W })
     .text(`Amounts are inclusive of GST. ${intra ? 'Intra-state supply (CGST + SGST).' : 'Inter-state supply (IGST).'}`, M, doc.y + 2, { width: W });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.rect(0, doc.page.height - 24, PW, 24).fill(C.brand);
    doc.fillColor('#cfe9e2').font('Helvetica').fontSize(7.5)
       .text(`${biz.company_name || 'QuizPe'}  ·  ${biz.support_email || ''}  ·  ${biz.product_website || ''}`, M, doc.page.height - 16, { width: W, align: 'center' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });

  const base_url = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const accessToken = crypto.randomBytes(18).toString('hex');
  await exec.query(
    `INSERT INTO invoices (subscription_id, payment_id, invoice_id, invoice_path, access_token,
                           amount_base, gst_pct, cgst, sgst, igst, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [subscriptionId, paymentDbId, invoiceNo, `invoices/${fileName}`, accessToken,
     base, gstPct, cgst, sgst, igst, gross]);

  return {
    filePath, fileName, invoiceNo,
    downloadUrl: `${base_url}/reports/dl-invoice/${accessToken}`,
    amounts: { base, gstPct, cgst, sgst, igst, total: gross, intra },
    head,
  };
}

module.exports = { generateInvoice, nextInvoiceNumber };
