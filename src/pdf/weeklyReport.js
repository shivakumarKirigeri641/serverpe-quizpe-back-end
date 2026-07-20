/**
 * src/pdf/weeklyReport.js
 * ---------------------------------------------------------------------------
 * Weekly performance report: combines the last 7 daily quizzes for a student
 * + subject into one PDF with:
 *   • business/merchant header, parent + student cards
 *   • week summary cards (quizzes, avg score, accuracy, best day, improvement,
 *     consistency)
 *   • a daily score bar+trend chart across the 7 days
 *   • an accuracy trend line
 *   • chapter-mastery analytics (aggregated across the week)
 *   • strongest/weakest, improvement insight and recommendations
 *
 * Stored under src/uploads/reports/weekly_reports/<weekEnd>/ and reachable
 * only via an unguessable access token (served by reportsRouter).
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('../database/connectDB');
const { nextReportFileName } = require('./reportNumber');
const { REPORTS_ROOT, TYPES, gradeFor } = require('./dailyReport');

const ROOT = path.join(REPORTS_ROOT, TYPES.weekly);

const C = {
  brand: '#075e54', accent: '#00a884', accentSoft: '#e7f7f2',
  ink: '#111b21', muted: '#667781', faint: '#8a97a0',
  ok: '#1a7f37', bad: '#c0392b', warn: '#b8860b', up: '#1a7f37', down: '#c0392b',
  line: '#e2e6e9', soft: '#f6f8f9', white: '#ffffff', grid: '#eef2f4',
};
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
const fmtDateY = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const dayName = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short' });
const maskMobile = (m) => (m ? `${'X'.repeat(Math.max(0, m.length - 4))}${m.slice(-4)}` : '');

async function fetchWeekData(studentId, subjectCode, days) {
  const head = (await db.query(
    `SELECT st.id AS student_id, st.student_name,
            p.parent_name, p.parent_mobile_number, su.state_name,
            b.board_code, g.grade_name, m.medium_name,
            sub.id AS subject_id, sub.subject_name,
            pl.plan_name
       FROM students st
       JOIN parents  p   ON p.id  = st.parent_id
       JOIN boards   b   ON b.id  = st.board_id
       JOIN grades   g   ON g.id  = st.grade_id
       JOIN mediums  m   ON m.id  = st.medium_id
       JOIN subjects sub ON sub.subject_code = $2
       LEFT JOIN states_unions su ON su.state_code = p.state_code
       LEFT JOIN LATERAL (SELECT * FROM parents_quizpe_subscriptions x
                           WHERE x.parent_id = p.id AND x.is_active ORDER BY x.id DESC LIMIT 1) s ON true
       LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE st.id = $1`, [studentId, subjectCode])).rows[0];
  if (!head) throw new Error(`student ${studentId} not found`);

  const daily = (await db.query(
    `SELECT t.quiz_date,
            COUNT(h.*)::int total,
            COUNT(*) FILTER (WHERE h.is_correct)::int correct,
            COUNT(*) FILTER (WHERE h.answered_option IS NOT NULL)::int answered
       FROM quizpe_tracker t
       JOIN student_quizpe_histories h ON h.tracker_id = t.id
      WHERE t.student_id = $1 AND t.subject_id = $2
        AND t.quiz_date > CURRENT_DATE - ($3::int)
      GROUP BY t.quiz_date ORDER BY t.quiz_date`, [studentId, head.subject_id, days])).rows;

  const chapters = (await db.query(
    `SELECT qb.chapter, COUNT(*)::int asked, COUNT(*) FILTER (WHERE h.is_correct)::int correct
       FROM student_quizpe_histories h
       JOIN quizpe_tracker t ON t.id = h.tracker_id
       JOIN question_bank qb ON qb.id = h.question_id
      WHERE t.student_id = $1 AND t.subject_id = $2
        AND t.quiz_date > CURRENT_DATE - ($3::int)
      GROUP BY qb.chapter ORDER BY qb.chapter`, [studentId, head.subject_id, days])).rows;

  // every question asked in the week, for the day-by-day answer appendix
  const items = (await db.query(
    `SELECT t.quiz_date, h.serial_number, h.answered_option, h.is_correct,
            qb.question_pdf, qb.chapter, qb.answer, qb.explanation,
            qb.option_a, qb.option_b, qb.option_c, qb.option_d
       FROM student_quizpe_histories h
       JOIN quizpe_tracker t ON t.id = h.tracker_id
       JOIN question_bank qb ON qb.id = h.question_id
      WHERE t.student_id = $1 AND t.subject_id = $2
        AND t.quiz_date > CURRENT_DATE - ($3::int)
      ORDER BY t.quiz_date, h.serial_number`, [studentId, head.subject_id, days])).rows;

  const biz = (await db.query(
    `SELECT company_name, company_tagline, product_name, product_tagline,
            gstin, address, support_email, product_website
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};

  return { head, daily, chapters, items, biz };
}

/* ---- small draw helpers ---- */
function card(doc, x, y, w, h, { fill = C.white, stroke = C.line, r = 8 } = {}) {
  doc.roundedRect(x, y, w, h, r).fillAndStroke(fill, stroke);
}
function label(doc, t, x, y, color = C.muted, size = 8) {
  doc.fillColor(color).font('Helvetica-Bold').fontSize(size).text(String(t).toUpperCase(), x, y, { characterSpacing: 0.5 });
}
function kv(doc, k, v, x, y, w) {
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(k, x, y);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text(v ?? '—', x, y, { width: w, align: 'right' });
}

/** Bar chart of daily score % with a trend line overlay. */
function scoreChart(doc, x, y, w, h, daily) {
  const pad = { l: 26, b: 18, t: 6 };
  const plotW = w - pad.l, plotH = h - pad.b - pad.t;
  const x0 = x + pad.l, y0 = y + pad.t;

  // gridlines at 0/50/100
  [0, 50, 100].forEach(v => {
    const gy = y0 + plotH - (v / 100) * plotH;
    doc.moveTo(x0, gy).lineTo(x + w, gy).strokeColor(C.grid).lineWidth(0.5).stroke();
    doc.fillColor(C.faint).font('Helvetica').fontSize(7).text(String(v), x, gy - 3, { width: pad.l - 4, align: 'right' });
  });

  const n = daily.length;
  const slot = plotW / Math.max(n, 1);
  const bw = Math.min(24, slot * 0.5);
  const pts = [];
  daily.forEach((d, i) => {
    const pct = d.total ? Math.round(d.correct * 100 / d.total) : 0;
    const cx = x0 + slot * i + slot / 2;
    const bh = (pct / 100) * plotH;
    const by = y0 + plotH - bh;
    const col = pct >= 60 ? C.accent : pct >= 40 ? C.warn : C.bad;
    doc.roundedRect(cx - bw / 2, by, bw, Math.max(bh, 1), 2).fill(col);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(7).text(`${pct}%`, cx - 12, by - 10, { width: 24, align: 'center' });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7)
       .text(`${dayName(d.quiz_date)}\n${fmtDate(d.quiz_date)}`, cx - slot / 2, y0 + plotH + 3, { width: slot, align: 'center' });
    pts.push({ x: cx, y: by });
  });

  // trend line connecting the bar tops
  if (pts.length > 1) {
    doc.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => doc.lineTo(p.x, p.y));
    doc.strokeColor(C.brand).lineWidth(1.4).stroke();
    pts.forEach(p => doc.circle(p.x, p.y, 2).fill(C.brand));
  }
}

/** Simple accuracy trend line (correct / answered per day). */
function accuracyLine(doc, x, y, w, h, daily) {
  const pad = { l: 26, b: 16, t: 6 };
  const plotW = w - pad.l, plotH = h - pad.b - pad.t;
  const x0 = x + pad.l, y0 = y + pad.t;
  [0, 100].forEach(v => {
    const gy = y0 + plotH - (v / 100) * plotH;
    doc.moveTo(x0, gy).lineTo(x + w, gy).strokeColor(C.grid).lineWidth(0.5).stroke();
    doc.fillColor(C.faint).font('Helvetica').fontSize(7).text(String(v), x, gy - 3, { width: pad.l - 4, align: 'right' });
  });
  const n = daily.length, slot = plotW / Math.max(n - 1, 1);
  const pts = daily.map((d, i) => {
    const acc = d.answered ? Math.round(d.correct * 100 / d.answered) : 0;
    return { x: x0 + slot * i, y: y0 + plotH - (acc / 100) * plotH, acc, d };
  });
  if (pts.length > 1) {
    doc.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => doc.lineTo(p.x, p.y));
    doc.strokeColor(C.accent).lineWidth(1.4).stroke();
  }
  pts.forEach(p => {
    doc.circle(p.x, p.y, 2.5).fill(C.accent);
    doc.fillColor(C.muted).font('Helvetica').fontSize(6.5).text(`${p.acc}%`, p.x - 10, p.y - 11, { width: 20, align: 'center' });
    doc.fillColor(C.faint).fontSize(6.5).text(fmtDate(p.d.quiz_date), p.x - slot / 2, y0 + plotH + 3, { width: slot, align: 'center' });
  });
}

async function generateWeeklyReport(studentId, { subjectCode = 'MATHS', days = 7 } = {}) {
  const { head, daily, chapters, items, biz } = await fetchWeekData(studentId, subjectCode, days);
  if (!daily.length) throw new Error(`no quizzes in the last ${days} days for student ${studentId}`);

  // ---- aggregates ----
  const totalQ = daily.reduce((s, d) => s + d.total, 0);
  const totalC = daily.reduce((s, d) => s + d.correct, 0);
  const totalA = daily.reduce((s, d) => s + d.answered, 0);
  const overallPct = Math.round(totalC * 100 / totalQ);
  const overallAcc = totalA ? Math.round(totalC * 100 / totalA) : 0;
  const dayPcts = daily.map(d => (d.total ? Math.round(d.correct * 100 / d.total) : 0));
  const avgPct = Math.round(dayPcts.reduce((a, b) => a + b, 0) / dayPcts.length);
  const bestIdx = dayPcts.indexOf(Math.max(...dayPcts));
  const improvement = dayPcts.length > 1 ? dayPcts[dayPcts.length - 1] - dayPcts[0] : 0;
  const consistency = daily.length;                 // days attempted
  const g = gradeFor(overallPct);
  const weekEnd = daily[daily.length - 1].quiz_date;
  const weekStart = daily[0].quiz_date;

  const chByPct = [...chapters].sort((a, b) => (b.correct / b.asked) - (a.correct / a.asked));
  const strongest = chByPct[0], weakest = chByPct[chByPct.length - 1];

  // ---- file ----
  const { folder, compact } = (() => {
    const d = new Date(weekEnd);
    const f = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { folder: f, compact: f.replace(/-/g, '') };
  })();
  const dir = path.join(ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  // same sequential scheme as the daily report, on its own 'weekly' series
  const fileName = await nextReportFileName({
    reportType: 'weekly', trackerId: null, date: weekEnd, studentId: head.student_id,
  });
  const filePath = path.join(dir, fileName);
  const relPath = `${TYPES.weekly}/${folder}/${fileName}`;

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `QuizPe Weekly Report — ${head.student_name}`, Author: biz.company_name || 'QuizPe' } });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const Mg = 36, PW = doc.page.width, W = PW - Mg * 2;

  /* header */
  doc.rect(0, 0, PW, 108).fill(C.brand);
  doc.rect(0, 108, PW, 4).fill(C.accent);
  const logo = require('../assets/buildLogo').paths.white;
  if (fs.existsSync(logo)) {
    doc.image(logo, Mg, 22, { height: 42 });
  } else {
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(24).text(biz.product_name || 'QuizPe', Mg, 24);
    doc.font('Helvetica').fontSize(9).fillColor('#bfe3da').text(biz.product_tagline || '', Mg, 52);
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.white).text('Weekly Performance Report', Mg, 70);
  doc.font('Helvetica').fontSize(8).fillColor('#bfe3da')
     .text(`${fmtDateY(weekStart)} – ${fmtDateY(weekEnd)}`, Mg, 88);

  const bx = PW / 2, bw = W / 2;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white).text(biz.company_name || '', bx, 24, { width: bw, align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor('#cfe9e2');
  let by = 38;
  [biz.address, biz.gstin ? `GSTIN: ${biz.gstin}` : null, [biz.support_email, biz.product_website].filter(Boolean).join('  ·  ')]
    .filter(Boolean).forEach(l => { doc.text(l, bx, by, { width: bw, align: 'right' }); by += 11; });

  let y = 126;

  /* parent + student cards */
  const colW = (W - 12) / 2, ch = 82;
  card(doc, Mg, y, colW, ch); card(doc, Mg + colW + 12, y, colW, ch);
  label(doc, 'Parent / Guardian', Mg + 12, y + 11, C.accent);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12).text(head.parent_name || '—', Mg + 12, y + 24);
  kv(doc, 'Mobile', maskMobile(head.parent_mobile_number), Mg + 12, y + 44, colW - 24);
  kv(doc, 'State', head.state_name || '—', Mg + 12, y + 60, colW - 24);
  const sx = Mg + colW + 12;
  label(doc, 'Student', sx + 12, y + 11, C.accent);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12).text(head.student_name || '—', sx + 12, y + 24);
  kv(doc, 'Board / Grade', `${head.board_code} · ${head.grade_name}`, sx + 12, y + 44, colW - 24);
  kv(doc, 'Subject', head.subject_name, sx + 12, y + 60, colW - 24);
  y += ch + 14;

  /* summary cards row (6 tiles) */
  const tiles = [
    { t: 'Quizzes', v: `${consistency}/${days}`, s: 'days active', c: C.ink },
    { t: 'Avg Score', v: `${avgPct}%`, s: `overall ${g.grade}`, c: g.color },
    { t: 'Accuracy', v: `${overallAcc}%`, s: `${totalC}/${totalA} answered`, c: C.accent },
    { t: 'Best Day', v: `${dayPcts[bestIdx]}%`, s: fmtDate(daily[bestIdx].quiz_date), c: C.ok },
    { t: 'Improvement', v: `${improvement >= 0 ? '+' : ''}${improvement}%`, s: 'first → last', c: improvement >= 0 ? C.up : C.down },
    { t: 'Questions', v: String(totalQ), s: `${totalC} correct`, c: C.ink },
  ];
  const tw = (W - 5 * 8) / 6, th = 62;
  tiles.forEach((tl, i) => {
    const tx = Mg + i * (tw + 8);
    card(doc, tx, y, tw, th, { fill: C.soft, stroke: C.soft });
    label(doc, tl.t, tx + 8, y + 8, C.muted, 6.5);
    doc.fillColor(tl.c).font('Helvetica-Bold').fontSize(16).text(tl.v, tx + 8, y + 20, { width: tw - 16 });
    doc.fillColor(C.faint).font('Helvetica').fontSize(6.5).text(tl.s, tx + 8, y + 44, { width: tw - 16 });
  });
  y += th + 16;

  /* daily score chart */
  label(doc, 'Daily score & trend', Mg, y, C.brand, 10); y += 14;
  card(doc, Mg, y, W, 132, { fill: C.white });
  scoreChart(doc, Mg + 8, y + 8, W - 16, 116, daily);
  y += 132 + 14;

  /* accuracy trend + improvement insight side by side */
  const halfW = (W - 12) / 2;
  label(doc, 'Accuracy trend', Mg, y, C.brand, 10);
  label(doc, 'This week at a glance', Mg + halfW + 12, y, C.brand, 10);
  y += 14;
  card(doc, Mg, y, halfW, 108);
  accuracyLine(doc, Mg + 6, y + 6, halfW - 12, 96, daily);

  card(doc, Mg + halfW + 12, y, halfW, 108, { fill: C.accentSoft, stroke: C.accentSoft });
  const ix = Mg + halfW + 24; let iy = y + 12;
  const trendMsg = improvement > 5 ? `📈 Great progress — up ${improvement}% since the start of the week!`
    : improvement < -5 ? `📉 Scores dipped ${Math.abs(improvement)}% — a little revision will help.`
    : `➖ Steady performance through the week.`;
  const insights = [
    trendMsg,
    strongest ? `💪 Strongest: ${strongest.chapter} (${Math.round(strongest.correct * 100 / strongest.asked)}%)` : null,
    weakest && weakest !== strongest ? `🎯 Needs work: ${weakest.chapter} (${Math.round(weakest.correct * 100 / weakest.asked)}%)` : null,
    consistency === days ? `🔥 Perfect attendance — all ${days} days!` : `📅 Attended ${consistency} of ${days} days.`,
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(9).fillColor(C.brand);
  insights.forEach(t => { doc.text(t, ix, iy, { width: halfW - 24 }); iy = doc.y + 6; });
  y += 108 + 16;

  /* chapter mastery */
  if (y > doc.page.height - 140) { doc.addPage(); y = Mg; }
  label(doc, 'Chapter mastery (whole week)', Mg, y, C.brand, 10); y += 16;
  chapters.forEach(cch => {
    const p = Math.round(cch.correct * 100 / cch.asked);
    doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(cch.chapter, Mg, y, { width: W - 100 });
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(9).text(`${cch.correct}/${cch.asked} · ${p}%`, Mg, y, { width: W, align: 'right' });
    const barY = y + 13;
    doc.roundedRect(Mg, barY, W, 6, 3).fill('#edf1f3');
    if (p > 0) doc.roundedRect(Mg, barY, W * p / 100, 6, 3).fill(p >= 60 ? C.accent : p >= 40 ? C.warn : C.bad);
    y = barY + 16;
  });

  /* recommendation footer box */
  y += 4;
  if (y > doc.page.height - 90) { doc.addPage(); y = Mg; }
  card(doc, Mg, y, W, 54, { fill: C.soft, stroke: C.line });
  label(doc, "Parent's takeaway", Mg + 12, y + 10, C.brand, 9);
  const rec = overallPct >= 75 ? `${head.student_name} is doing very well — keep the daily habit going and consider adding a subject.`
    : overallPct >= 50 ? `${head.student_name} is making steady progress. A little daily revision of ${weakest ? weakest.chapter : 'weak areas'} will lift scores.`
    : `${head.student_name} needs some support this week — sit together for a few quizzes and revisit ${weakest ? weakest.chapter : 'the basics'}.`;
  doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(rec, Mg + 12, y + 24, { width: W - 24 });

  /* ---------- day-by-day answer appendix (all 7 days' questions) ---------- */
  doc.addPage(); y = Mg;
  label(doc, 'Full answer review — all 7 days', Mg, y, C.brand, 11); y += 8;
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
     .text('Every question asked this week, your answer, the correct answer and why.', Mg, y + 6); y += 24;

  const optText = (it, l) => ({ A: it.option_a, B: it.option_b, C: it.option_c, D: it.option_d }[l]);
  const byDay = {};
  items.forEach(it => { const k = new Date(it.quiz_date).toISOString().slice(0, 10); (byDay[k] ||= []).push(it); });

  doc.y = y;
  Object.keys(byDay).sort().forEach((k, di) => {
    const list = byDay[k];
    const dc = list.filter(x => x.is_correct).length;
    if (doc.y > doc.page.height - 80) { doc.addPage(); doc.y = Mg; }

    // day header band
    doc.roundedRect(Mg, doc.y, W, 22, 4).fill(C.brand);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9.5)
       .text(`Day ${di + 1} — ${fmtDateY(k)}`, Mg + 10, doc.y + 6, { continued: false });
    doc.fillColor('#cfe9e2').font('Helvetica').fontSize(9)
       .text(`${dc}/${list.length} correct`, Mg, doc.y - 13, { width: W - 10, align: 'right' });
    doc.y += 30;

    list.forEach(it => {
      if (doc.y > doc.page.height - 70) { doc.addPage(); doc.y = Mg; }
      const badge = it.is_correct ? C.ok : (it.answered_option ? C.bad : C.faint);
      const mark = it.is_correct ? '✓' : (it.answered_option ? '✗' : '—');
      const top = doc.y;
      doc.roundedRect(Mg, top, 15, 15, 3).fill(badge);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5).text(mark, Mg, top + 3, { width: 15, align: 'center' });

      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.5)
         .text(`Q${it.serial_number}. `, Mg + 22, top + 1, { continued: true })
         .font('Helvetica').text(it.question_pdf, { width: W - 22 });
      doc.fillColor(C.muted).font('Helvetica').fontSize(8)
         .text(`Your answer: ${it.answered_option ? `${it.answered_option}) ${optText(it, it.answered_option) ?? ''}` : 'not answered'}`, Mg + 22, doc.y + 1);
      if (!it.is_correct) {
        doc.fillColor(C.ok).font('Helvetica-Bold').fontSize(8)
           .text(`Correct: ${it.answer}) ${optText(it, it.answer) ?? ''}`, Mg + 22, doc.y + 1);
      }
      if (it.explanation) {
        doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(8)
           .text(`💡 ${it.explanation}`, Mg + 22, doc.y + 1, { width: W - 34 });
      }
      doc.moveTo(Mg, doc.y + 5).lineTo(Mg + W, doc.y + 5).strokeColor(C.line).lineWidth(0.4).stroke();
      doc.y += 10;
    });
    doc.y += 6;
  });

  /* footer each page */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.rect(0, doc.page.height - 26, PW, 26).fill(C.brand);
    doc.fillColor('#cfe9e2').font('Helvetica').fontSize(7.5)
       .text(`${biz.company_name || 'QuizPe'}  ·  ${biz.support_email || ''}  ·  Generated ${fmtDateY(new Date())}`, Mg, doc.page.height - 18, { width: W, align: 'left' });
    doc.fillColor(C.white).text(`Page ${i + 1} of ${range.count}`, Mg, doc.page.height - 18, { width: W, align: 'right' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });

  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const accessToken = crypto.randomBytes(18).toString('hex');
  const publicUrl = `${base}/reports/dl/${accessToken}`;
  // weekly reports have no single tracker; de-dup on (student, weekEnd, type)
  await db.query(
    `DELETE FROM quiz_reports WHERE student_id=$1 AND quiz_date=$2 AND report_type='weekly'`, [head.student_id, weekEnd]);
  await db.query(
    `INSERT INTO quiz_reports (tracker_id, student_id, quiz_date, report_type, file_name, file_path,
                               public_url, access_token, score_correct, score_total, score_pct, grade)
     VALUES (NULL,$1,$2,'weekly',$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (student_id, quiz_date, report_type) WHERE tracker_id IS NULL DO UPDATE SET
       file_name=EXCLUDED.file_name, file_path=EXCLUDED.file_path, public_url=EXCLUDED.public_url,
       access_token=EXCLUDED.access_token, score_correct=EXCLUDED.score_correct,
       score_total=EXCLUDED.score_total, score_pct=EXCLUDED.score_pct, grade=EXCLUDED.grade, modified_at=now()`,
    [head.student_id, weekEnd, fileName, relPath, publicUrl, accessToken, totalC, totalQ, overallPct, g.grade]);

  return {
    filePath, fileName, relPath, publicUrl,
    summary: { days: consistency, totalQ, totalC, overallPct, overallAcc, avgPct, improvement, grade: g.grade },
    head,
  };
}

module.exports = { generateWeeklyReport };
