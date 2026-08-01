/**
 * src/pdf/gstr1.js
 * ---------------------------------------------------------------------------
 * A working-summary PDF to assist GSTR-1 filing for a period (YYYY-MM).
 *
 * QuizPe sells to unregistered parents, so every sale is B2CS (B2C Small). The
 * portal wants B2CS reported per Place of Supply + rate, an HSN/SAC summary,
 * and a document (invoice) summary. This PDF lays out exactly those figures so
 * they can be keyed into gst.gov.in (or handed to an accountant). It is a
 * SUMMARY to help file — not the return itself.
 * ---------------------------------------------------------------------------
 */
const PDFDocument = require('pdfkit');
const db = require('../database/connectDB');

const C = { brand: '#075e54', accent: '#00a884', ink: '#111b21', muted: '#667781', line: '#e2e6e9', soft: '#f6f8f9', white: '#fff' };
const money = (n) => `Rs. ${Number(n || 0).toFixed(2)}`;
const monthName = (p) => { const [y, m] = p.split('-'); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };

async function streamGstr1(period, stream) {
  const biz = (await db.query(
    `SELECT company_name, proprietor_name, gstin, pan, address, gst_state_code, product_name
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};

  // B2CS: grouped by place of supply + rate (intra vs inter kept separate)
  const b2cs = (await db.query(
    `SELECT place_of_supply, customer_state_code, supply_type, gst_rate::numeric AS rate,
            COUNT(*)::int n,
            COALESCE(SUM(taxable_value),0)::numeric taxable,
            COALESCE(SUM(cgst_amount),0)::numeric cgst,
            COALESCE(SUM(sgst_amount),0)::numeric sgst,
            COALESCE(SUM(igst_amount),0)::numeric igst,
            COALESCE(SUM(invoice_value),0)::numeric total
       FROM gstr1_filing WHERE filing_period=$1 AND is_active
      GROUP BY place_of_supply, customer_state_code, supply_type, gst_rate
      ORDER BY place_of_supply, gst_rate`, [period])).rows;

  const sac = (await db.query(
    `SELECT sac_code, gst_rate::numeric AS rate, COUNT(*)::int n,
            COALESCE(SUM(taxable_value),0)::numeric taxable,
            COALESCE(SUM(cgst_amount+sgst_amount+igst_amount),0)::numeric tax,
            COALESCE(SUM(invoice_value),0)::numeric total
       FROM gstr1_filing WHERE filing_period=$1 AND is_active
      GROUP BY sac_code, gst_rate ORDER BY sac_code`, [period])).rows;

  const { rows: [docs] } = await db.query(
    `SELECT COUNT(*)::int n, MIN(invoice_number) from_no, MAX(invoice_number) to_no
       FROM gstr1_filing WHERE filing_period=$1 AND is_active`, [period]);
  const { rows: [tot] } = await db.query(
    `SELECT COUNT(*)::int invoices,
            COALESCE(SUM(taxable_value),0)::numeric taxable,
            COALESCE(SUM(cgst_amount),0)::numeric cgst,
            COALESCE(SUM(sgst_amount),0)::numeric sgst,
            COALESCE(SUM(igst_amount),0)::numeric igst,
            COALESCE(SUM(invoice_value),0)::numeric total
       FROM gstr1_filing WHERE filing_period=$1 AND is_active`, [period]);

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `GSTR-1 Summary ${period}`, Author: biz.company_name || 'QuizPe' } });
  doc.pipe(stream);
  const M = 40, PW = doc.page.width, W = PW - M * 2;

  // header
  doc.rect(0, 0, PW, 92).fill(C.brand);
  doc.rect(0, 92, PW, 3).fill(C.accent);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(20).text('GSTR-1 Filing Summary', M, 26);
  doc.font('Helvetica').fontSize(10).fillColor('#cfe9e2').text(`Return period: ${monthName(period)}  (${period})`, M, 54);
  doc.font('Helvetica').fontSize(9).fillColor('#cfe9e2')
     .text(biz.company_name || '', M, 34, { width: W, align: 'right' })
     .text(`GSTIN: ${biz.gstin || '—'}`, M, 50, { width: W, align: 'right' })
     .text(`State code: ${biz.gst_state_code || '29'}`, M, 64, { width: W, align: 'right' });

  let y = 120;
  const heading = (t) => { doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(12).text(t, M, y); y += 20; };
  const totalsRow = (label, cells, bold, bg) => {
    if (bg) doc.rect(M, y, W, 20).fill(bg);
    let cx = M;
    const widths = [W * 0.30, W * 0.10, W * 0.15, W * 0.15, W * 0.15, W * 0.15];
    const vals = [label, ...cells];
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(C.ink);
    vals.forEach((v, i) => { doc.text(String(v), cx + 5, y + 6, { width: widths[i] - 8, align: i === 0 ? 'left' : 'right' }); cx += widths[i]; });
    y += 20;
  };

  // 1. B2CS
  heading('1.  B2C (Small) — sales to unregistered customers  [Table 7]');
  totalsRow('Place of supply', ['Rate %', 'Taxable', 'IGST', 'CGST', 'SGST'], true, C.soft);
  if (b2cs.length) {
    b2cs.forEach((r) => totalsRow(
      `${r.place_of_supply}`, [Number(r.rate).toFixed(0), money(r.taxable), money(r.igst), money(r.cgst), money(r.sgst)]));
  } else {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted).text('No B2CS sales in this period.', M + 5, y); y += 18;
  }
  totalsRow('TOTAL', ['', money(tot.taxable), money(tot.igst), money(tot.cgst), money(tot.sgst)], true, C.soft);
  y += 14;

  // 2. HSN/SAC summary
  heading('2.  HSN / SAC summary  [Table 12]');
  totalsRow('SAC', ['Rate %', 'Qty', 'Taxable', 'Total tax', 'Invoice value'], true, C.soft);
  if (sac.length) {
    sac.forEach((r) => totalsRow(r.sac_code || '998314',
      [Number(r.rate).toFixed(0), r.n, money(r.taxable), money(r.tax), money(r.total)]));
  } else {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted).text('No entries.', M + 5, y); y += 18;
  }
  y += 14;

  // 3. Documents issued
  heading('3.  Documents issued  [Table 13]');
  doc.font('Helvetica').fontSize(9.5).fillColor(C.ink)
     .text(`Tax invoices issued: ${docs.n || 0}`, M + 5, y); y += 16;
  if (docs.n) { doc.text(`Invoice number range: ${docs.from_no}  to  ${docs.to_no}`, M + 5, y); y += 16; }
  y += 10;

  // grand total box
  doc.rect(M, y, W, 46).fill(C.soft);
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(11).text('Period totals', M + 12, y + 8);
  doc.fillColor(C.ink).font('Helvetica').fontSize(9.5)
     .text(`Invoices: ${tot.invoices}   ·   Taxable: ${money(tot.taxable)}   ·   Tax: ${money(Number(tot.cgst) + Number(tot.sgst) + Number(tot.igst))}`, M + 12, y + 26)
     .text(`Total invoice value (incl. GST): ${money(tot.total)}`, M + 12, y + 26, { width: W - 24, align: 'right' });
  y += 60;

  // footer note
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.line).stroke(); y += 10;
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
     .text('This is a working summary generated from issued tax invoices to assist GSTR-1 preparation. '
       + 'File the return on the GST portal (gst.gov.in). All figures are GST-inclusive prices with tax derived per invoice. '
       + 'CGST + SGST apply to Karnataka (intra-state) supplies; IGST applies to other states.', M, y, { width: W });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.rect(0, doc.page.height - 22, PW, 22).fill(C.brand);
    doc.fillColor('#cfe9e2').font('Helvetica').fontSize(7.5)
       .text(`${biz.company_name || 'QuizPe'}  ·  GSTIN ${biz.gstin || ''}  ·  GSTR-1 ${period}`, M, doc.page.height - 15, { width: W, align: 'center' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); doc.on('error', rej); });
}

module.exports = { streamGstr1 };
