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
// ServerPe is an IT/software platform, so the supply is an IT service, not
// coaching. 998314 = Information Technology (IT) design & development services.
// (Alternative for pure SaaS licensing: 997331. Set QUIZPE_SAC_CODE to override.)
const SAC_CODE = process.env.QUIZPE_SAC_CODE || '998314';

const C = { brand: '#075e54', accent: '#00a884', ink: '#111b21', muted: '#667781', line: '#e2e6e9', soft: '#f6f8f9', white: '#fff' };
const SUBJECT_LABEL = {
  SCIENCE: 'Science', ENGLISH: 'English', HINDI: 'Hindi', SOCIAL: 'Social Science',
  EVS: 'Environmental Studies', KANNADA: 'Kannada', SANSKRIT: 'Sanskrit',
  COMPUTER: 'Computer Science', GENERAL_KNOWLEDGE: 'General Knowledge',
};
const money = (n) => `Rs. ${Number(n).toFixed(2)}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Next invoice number: <YYYYMMDD><nnnn>, from a Postgres SEQUENCE.
 *
 * NOT COUNT(*)+1. Two payments finalising at the same moment both read the
 * same count and build the same number; invoice_id is UNIQUE, so one of them
 * throws and a customer who has PAID gets no invoice — and a GST invoice
 * series must never have a hole or a repeat. nextval() is atomic, so every
 * caller gets its own number even under load.
 *
 * The sequence is created and seeded past any existing invoices by
 * ensureInvoiceSequence() at startup.
 */
async function nextInvoiceNumber(exec = db) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const { rows } = await exec.query(`SELECT nextval('invoice_seq')::bigint AS n`);
  return `${ymd}${String(rows[0].n).padStart(4, '0')}`;
}

/** Create the sequence once, seeded past invoices that already exist. */
async function ensureInvoiceSequence(exec = db) {
  await exec.query(`CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1`);
  const { rows: [r] } = await exec.query(`SELECT COUNT(*)::int n FROM invoices`);
  await exec.query(
    `SELECT setval('invoice_seq', GREATEST($1::bigint, last_value), true) FROM invoice_seq`, [r.n]);
}

async function generateInvoice(subscriptionId, paymentDbId = null, exec = db, cart = null) {
  // A subscription must have exactly ONE tax invoice. finalize() is idempotent
  // and can re-run (retry, webhook replay, a parent reloading the success
  // page), so hand back the invoice that already exists rather than issuing a
  // second number for money that was only charged once.
  const already = (await exec.query(
    `SELECT invoice_id, invoice_path FROM invoices
      WHERE subscription_id = $1 AND ($2::bigint IS NULL OR payment_id = $2::bigint)
      ORDER BY id LIMIT 1`, [subscriptionId, paymentDbId])).rows[0];
  if (already) {
    console.log(`[invoice] reusing ${already.invoice_id} for subscription ${subscriptionId}`);
    return {
      reused: true,
      invoiceNo: already.invoice_id,
      fileName: path.basename(already.invoice_path),
      filePath: path.join(DIR, path.basename(already.invoice_path)),
    };
  }

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
            address, support_email, product_support_email, product_website, gst_state_code
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};
  // A QuizPe invoice goes to a parent, so show the PRODUCT support address
  // (support@quizpe.in), not the company/grievance one (support@serverpe.in).
  const invoiceEmail = biz.product_support_email || biz.support_email || '';
  const gstRow = (await exec.query(`SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  const gstPct = gstRow ? Number(gstRow.gst_value) : 18;

  // Line items: base plan (Maths) + any subject add-ons chosen in the cart.
  // All prices are GST-inclusive; taxable value is derived per line.
  const taxableOf = (g) => +(g * 100 / (100 + gstPct)).toFixed(2);
  const lineItems = [{ desc: `${head.plan_name} — Mathematics (${head.duration} days)`, plan: head.plan_code, qty: head.student_count, gross: Number(head.price) }];
  if (cart && Array.isArray(cart.students)) {
    const addonAgg = {};   // subject_code -> { count, price }
    cart.students.forEach(st => (st.addons || []).forEach(a => {
      addonAgg[a.subject_code] ||= { count: 0, price: Number(a.price) };
      addonAgg[a.subject_code].count += 1;
    }));
    for (const [code, v] of Object.entries(addonAgg)) {
      lineItems.push({ desc: `${SUBJECT_LABEL[code] || code} — add-on`, plan: 'ADDON', qty: v.count, gross: +(v.price * v.count).toFixed(2) });
    }
  }

  const gross = cart ? Number(cart.total) : Number(head.price);
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
     .text(`${invoiceEmail}   ·   ${biz.product_website || ''}`, M, doc.y + 2, { width: colW });

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

  // one row per line item (base plan + each add-on subject)
  lineItems.forEach((li, idx) => {
    const rowH = idx === 0 ? 34 : 22;
    doc.rect(M, y, W, rowH).fillAndStroke(C.white, C.line);
    const sub = idx === 0 ? `\n${head.student_count} child${head.student_count > 1 ? 'ren' : ''} · ${fmtDate(head.plan_start_date)} to ${fmtDate(head.plan_end_date)}` : '';
    const cells = [li.desc + sub, li.plan, String(li.qty), money(taxableOf(li.gross)), money(li.gross)];
    cx = M;
    cols.forEach((c, i) => {
      doc.fillColor(C.ink).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
         .text(cells[i], cx + 6, y + (idx === 0 ? 6 : 6), { width: c.w - 12, align: c.a });
      cx += c.w;
    });
    y += rowH;
  });
  y += 12;

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
       .text(`${biz.company_name || 'QuizPe'}  ·  ${invoiceEmail}  ·  ${biz.product_website || ''}`, M, doc.page.height - 16, { width: W, align: 'center' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });

  const base_url = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const accessToken = crypto.randomBytes(18).toString('hex');
  const invoiceDbId = (await exec.query(
    `INSERT INTO invoices (subscription_id, payment_id, invoice_id, invoice_path, access_token,
                           amount_base, gst_pct, cgst, sgst, igst, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [subscriptionId, paymentDbId, invoiceNo, `invoices/${fileName}`, accessToken,
     base, gstPct, cgst, sgst, igst, gross])).rows[0].id;

  // ---- GSTR-1 monthly filing record (B2CS — sale to an unregistered parent) ----
  const invDate = new Date();
  const filingPeriod = `${invDate.getFullYear()}-${String(invDate.getMonth() + 1).padStart(2, '0')}`;
  const posCode = head.state_code || BUSINESS_STATE;
  const placeOfSupply = `${posCode}-${head.state_name || 'Karnataka'}`;
  await exec.query(
    `INSERT INTO gstr1_filing
       (invoice_id, payment_id, invoice_number, invoice_date, filing_period,
        seller_gstin, seller_state_code, customer_name, customer_mobile, customer_state_code,
        place_of_supply, supply_type, gstr1_table, sac_code, description,
        taxable_value, gst_rate, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, invoice_value, payment_reference)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9,$10,$11,'B2CS',$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (invoice_id) DO NOTHING`,
    [invoiceDbId, paymentDbId, invoiceNo, filingPeriod,
     biz.gstin || '', biz.gst_state_code || BUSINESS_STATE,
     head.parent_name || 'Customer', head.parent_mobile_number, posCode,
     placeOfSupply, intra ? 'INTRA' : 'INTER', SAC_CODE, `${head.plan_name} (${head.duration} days)`,
     base, gstPct, intra ? gstPct / 2 : 0, cgst, intra ? gstPct / 2 : 0, sgst,
     intra ? 0 : gstPct, igst, gross, head.rzp_payment_id || null]);

  return {
    filePath, fileName, invoiceNo,
    downloadUrl: `${base_url}/reports/dl-invoice/${accessToken}`,
    amounts: { base, gstPct, cgst, sgst, igst, total: gross, intra },
    head,
  };
}

module.exports = { generateInvoice, nextInvoiceNumber, ensureInvoiceSequence };
