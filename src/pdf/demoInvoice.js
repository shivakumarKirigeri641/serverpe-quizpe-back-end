/**
 * src/pdf/demoInvoice.js
 * ---------------------------------------------------------------------------
 * A SAMPLE invoice PDF for the school demo only. Looks like the real thing so a
 * school sees exactly what a parent receives — but it is deliberately NOT a real
 * tax invoice:
 *
 *   • NO invoice-sequence number is consumed (uses a DEMO-… reference)
 *   • NOTHING is written to `invoices` or `gstr1_filing` — GST records stay clean
 *   • a clear "DEMO — not a valid tax invoice" banner marks it as a sample
 *
 * The real invoice generator (src/pdf/invoice.js) and the payment flow are left
 * entirely untouched. This is used ONLY by the demo number's fake checkout.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('../database/connectDB');

const DIR = path.join(__dirname, '..', 'uploads', 'invoices');
const BUSINESS_STATE = '29';                    // Karnataka
const C = { brand: '#075e54', accent: '#00a884', ink: '#111b21', muted: '#667781',
            line: '#e2e6e9', soft: '#f6f8f9', white: '#fff', warn: '#b26a00', warnbg: '#fff4e0' };
const money = (n) => `Rs. ${Number(n).toFixed(2)}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Build a sample invoice PDF. Read-only against the DB (business + GST %),
 * writes only a temp PDF file, returns its path. Caller deletes it after send.
 */
async function generateDemoInvoice({ parentName, mobile, stateCode = BUSINESS_STATE, childLabel = null, amount = 99 } = {}) {
  const biz = (await db.query(
    `SELECT company_name, product_name, proprietor_name, gstin, pan, address,
            support_email, product_support_email, product_website
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};
  const invoiceEmail = biz.product_support_email || biz.support_email || '';
  const gstRow = (await db.query(`SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  const gstPct = gstRow ? Number(gstRow.gst_value) : 18;
  const stateName = (await db.query(`SELECT state_name FROM states_unions WHERE state_code=$1`, [stateCode])).rows[0]?.state_name || 'Karnataka';

  const gross = Number(amount);
  const base = +(gross * 100 / (100 + gstPct)).toFixed(2);
  const gstAmt = +(gross - base).toFixed(2);
  const intra = (stateCode || BUSINESS_STATE) === BUSINESS_STATE;
  const cgst = intra ? +(gstAmt / 2).toFixed(2) : 0;
  const sgst = intra ? +(gstAmt - cgst).toFixed(2) : 0;
  const igst = intra ? 0 : gstAmt;

  // DEMO reference — NOT from the invoice sequence, and clearly prefixed.
  const d = new Date();
  const ref = `DEMO-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  fs.mkdirSync(DIR, { recursive: true });
  const fileName = `${ref}.pdf`;
  const filePath = path.join(DIR, fileName);

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `Sample Invoice ${ref}`, Author: biz.company_name || 'QuizPe' } });
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
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(16).text('SAMPLE INVOICE', M, 34, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#cfe9e2')
     .text(`Ref: ${ref}`, M, 58, { width: W, align: 'right' })
     .text(`Date: ${fmtDate(new Date())}`, M, 70, { width: W, align: 'right' });

  // DEMO banner
  let y = 112;
  doc.roundedRect(M, y, W, 26, 6).fillAndStroke(C.warnbg, '#f0c987');
  doc.fillColor(C.warn).font('Helvetica-Bold').fontSize(9.5)
     .text('DEMO / SAMPLE  —  for demonstration only. This is NOT a valid tax invoice and no payment was collected.', M + 10, y + 8, { width: W - 20 });
  y += 42;

  // seller / buyer
  const colW = (W - 20) / 2;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('SELLER', M, y);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(biz.company_name || 'ServerPe App Solutions', M, y + 12);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
     .text(biz.address || '', M, y + 28, { width: colW })
     .text(`GSTIN: ${biz.gstin || ''}   ·   PAN: ${biz.pan || ''}`, M, doc.y + 2, { width: colW })
     .text(`${invoiceEmail}   ·   ${biz.product_website || ''}`, M, doc.y + 2, { width: colW });

  const bx = M + colW + 20;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('BILL TO', bx, y);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(parentName || 'Demo Parent', bx, y + 12);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
     .text(`Mobile: ${mobile || '—'}`, bx, y + 28, { width: colW })
     .text(`State: ${stateName} (${stateCode})`, bx, doc.y + 2, { width: colW })
     .text(`Place of supply: ${stateName}`, bx, doc.y + 2, { width: colW });

  y = Math.max(doc.y, y + 70) + 16;

  // one line item
  const cols = [
    { t: 'Description', w: W * 0.54, a: 'left' },
    { t: 'Qty', w: W * 0.10, a: 'center' },
    { t: 'Taxable', w: W * 0.18, a: 'right' },
    { t: 'Amount', w: W * 0.18, a: 'right' },
  ];
  doc.rect(M, y, W, 22).fill(C.brand);
  let cx = M;
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5);
  cols.forEach(c => { doc.text(c.t.toUpperCase(), cx + 6, y + 7, { width: c.w - 12, align: c.a }); cx += c.w; });
  y += 22;

  const desc = `QuizPe subscription — Mathematics${childLabel ? `\n${childLabel}` : '\nDaily 5–10 min revision quiz on WhatsApp'}`;
  const cells = [desc, '1', money(base), money(gross)];
  doc.rect(M, y, W, 34).fillAndStroke(C.white, C.line);
  cx = M;
  cols.forEach((c, i) => {
    doc.fillColor(C.ink).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .text(cells[i], cx + 6, y + 6, { width: c.w - 12, align: c.a });
    cx += c.w;
  });
  y += 34 + 12;

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
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text('TOTAL', tx + 6, y + 8, { width: tW * 0.55 });
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(13).text(money(gross), tx + tW * 0.55, y + 6, { width: tW * 0.45 - 6, align: 'right' });
  y += 40;

  doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
     .text('Reference: DEMO — no payment gateway was used and no amount was charged.', M, y, { width: W });
  y += 18;
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.line).stroke(); y += 10;
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
     .text('This is a SAMPLE document generated for a live demonstration. Amounts shown mirror a real subscription (GST-inclusive) '
         + 'but no tax invoice has been issued and this carries no GST validity.', M, y, { width: W });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.rect(0, doc.page.height - 24, PW, 24).fill(C.brand);
    doc.fillColor('#cfe9e2').font('Helvetica').fontSize(7.5)
       .text(`${biz.company_name || 'QuizPe'}  ·  ${invoiceEmail}  ·  ${biz.product_website || ''}  ·  SAMPLE / DEMO`, M, doc.page.height - 16, { width: W, align: 'center' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
  return { filePath, fileName, ref, amounts: { base, gstPct, cgst, sgst, igst, total: gross, intra } };
}

module.exports = { generateDemoInvoice };
