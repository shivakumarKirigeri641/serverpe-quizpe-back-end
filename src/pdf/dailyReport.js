/**
 * src/pdf/dailyReport.js
 * ---------------------------------------------------------------------------
 * Professional daily quiz report PDF:
 *   • branded header with merchant/business details (name, GSTIN, contact)
 *   • Parent and Student info cards
 *   • Performance summary cards — score, grade, accuracy, analytics
 *   • chapter-wise analytics with bars + strongest/weakest
 *   • full answer review with explanations
 *
 * Saved under src/uploads/reports/daily_reports/<YYYY-MM-DD>/ and reachable
 * only via an unguessable access token (served by reportsRouter).
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('../database/connectDB');
const { useFontsFor } = require('./fonts');
const { nextReportFileName } = require('./reportNumber');

const REPORTS_ROOT = path.join(__dirname, '..', 'uploads', 'reports');
const TYPES = { daily: 'daily_reports', weekly: 'weekly_reports', final: 'final_reports', certificate: 'certificates' };
const ROOT = path.join(REPORTS_ROOT, TYPES.daily);

// palette
const C = {
  brand: '#075e54', brand2: '#0a7d6e', accent: '#00a884', accentSoft: '#e7f7f2',
  ink: '#111b21', muted: '#667781', faint: '#8a97a0',
  ok: '#1a7f37', okSoft: '#e6f4ea', bad: '#c0392b', badSoft: '#fbeceb',
  warn: '#b8860b', line: '#e2e6e9', soft: '#f6f8f9', white: '#ffffff', gold: '#c99700',
};

function gradeFor(pct) {
  if (pct >= 90) return { grade: 'A+', label: 'Outstanding', color: C.ok };
  if (pct >= 75) return { grade: 'A',  label: 'Very good',   color: C.ok };
  if (pct >= 60) return { grade: 'B',  label: 'Good',        color: C.accent };
  if (pct >= 40) return { grade: 'C',  label: 'Fair',        color: C.warn };
  return { grade: 'D', label: 'Needs practice', color: C.bad };
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const maskMobile = (m) => (m ? `${'X'.repeat(Math.max(0, m.length - 4))}${m.slice(-4)}` : '');

async function fetchReportData(trackerId) {
  const head = (await db.query(
    `SELECT t.quiz_date, t.quiz_type, t.question_count,
            st.id AS student_id, st.student_name, st.school_name,
            p.parent_name, p.parent_mobile_number, su.state_name,
            b.board_code, b.board_name, g.grade_name, m.medium_name, m.medium_code, sub.subject_name,
            pl.plan_name, s.plan_start_date, s.plan_end_date,
            MIN(h.answered_at) AS started_at, MAX(h.answered_at) AS finished_at
       FROM quizpe_tracker t
       JOIN students st  ON st.id = t.student_id
       JOIN parents  p   ON p.id  = st.parent_id
       JOIN boards   b   ON b.id  = st.board_id
       JOIN grades   g   ON g.id  = st.grade_id
       JOIN mediums  m   ON m.id  = st.medium_id
       JOIN subjects sub ON sub.id = t.subject_id
       LEFT JOIN states_unions su ON su.state_code = p.state_code
       LEFT JOIN student_quizpe_histories h ON h.tracker_id = t.id
       LEFT JOIN LATERAL (SELECT * FROM parents_quizpe_subscriptions x
                           WHERE x.parent_id = p.id AND x.is_active
                           ORDER BY x.id DESC LIMIT 1) s ON true
       LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
      WHERE t.id = $1
      GROUP BY t.quiz_date, t.quiz_type, t.question_count, st.id, st.student_name, st.school_name,
               p.parent_name, p.parent_mobile_number, su.state_name,
               b.board_code, b.board_name, g.grade_name, m.medium_name, m.medium_code, sub.subject_name,
               pl.plan_name, s.plan_start_date, s.plan_end_date`, [trackerId])).rows[0];

  const items = (await db.query(
    `SELECT h.serial_number, h.answered_option, h.is_correct,
            qb.question_pdf, qb.chapter, qb.answer, qb.explanation,
            qb.option_a, qb.option_b, qb.option_c, qb.option_d
       FROM student_quizpe_histories h
       JOIN question_bank qb ON qb.id = h.question_id
      WHERE h.tracker_id = $1 ORDER BY h.serial_number`, [trackerId])).rows;

  const chapters = (await db.query(
    `SELECT qb.chapter, COUNT(*)::int asked, COUNT(*) FILTER (WHERE h.is_correct)::int correct
       FROM student_quizpe_histories h JOIN question_bank qb ON qb.id = h.question_id
      WHERE h.tracker_id = $1 GROUP BY qb.chapter ORDER BY qb.chapter`, [trackerId])).rows;

  const biz = (await db.query(
    `SELECT company_name, company_tagline, product_name, product_tagline,
            proprietor_name, gstin, pan, address, support_email, product_website, company_website
       FROM business_details WHERE is_active LIMIT 1`)).rows[0] || {};

  // adaptive learning progress + speed/streak for this child+subject
  let progress = null, speed = null, streak = 0;
  try {
    const M = require('../whatsapp/mastery');
    const t = (await db.query(`SELECT student_id, subject_id FROM quizpe_tracker WHERE id=$1`, [trackerId])).rows[0];
    if (t) {
      progress = await M.progressSummary(t.student_id, t.subject_id);
      streak = await M.currentStreak(t.student_id);
      speed = (await db.query(
        `SELECT ROUND(AVG(response_seconds))::int avg_s, MIN(response_seconds)::int fast_s,
                (SELECT MIN(h2.response_seconds)::int FROM student_quizpe_histories h2
                   JOIN quizpe_tracker t2 ON t2.id=h2.tracker_id
                  WHERE t2.student_id=$2 AND h2.response_seconds IS NOT NULL AND h2.is_correct) best_s
           FROM student_quizpe_histories WHERE tracker_id=$1 AND response_seconds IS NOT NULL`,
        [trackerId, t.student_id])).rows[0];
    }
  } catch (e) { /* optional enrichment */ }

  return { head, items, chapters, biz, progress, speed, streak };
}

/* ------------------------------------------------------------ draw helpers */

function card(doc, x, y, w, h, { fill = C.white, stroke = C.line, radius = 8 } = {}) {
  doc.roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke);
  return { x, y, w, h };
}
function label(doc, text, x, y, color = C.muted, size = 8) {
  doc.fillColor(color).font(doc._F.bold).fontSize(size)
     .text(String(text).toUpperCase(), x, y, { characterSpacing: 0.5 });
}
function kv(doc, k, v, x, y, w) {
  doc.fillColor(C.muted).font(doc._F.regular).fontSize(9).text(k, x, y);
  doc.fillColor(C.ink).font(doc._F.bold).fontSize(9)
     .text(v ?? '—', x, y, { width: w, align: 'right' });
}

/* ---- vector icons (PDF fonts can't render emoji, so we draw them) ---- */
function iconCheck(doc, x, y, s, color = '#fff') {
  doc.save().lineWidth(s * 0.16).strokeColor(color).lineCap('round').lineJoin('round')
     .moveTo(x + s * 0.22, y + s * 0.55).lineTo(x + s * 0.42, y + s * 0.72)
     .lineTo(x + s * 0.78, y + s * 0.28).stroke().restore();
}
function iconCross(doc, x, y, s, color = '#fff') {
  doc.save().lineWidth(s * 0.16).strokeColor(color).lineCap('round')
     .moveTo(x + s * 0.28, y + s * 0.28).lineTo(x + s * 0.72, y + s * 0.72)
     .moveTo(x + s * 0.72, y + s * 0.28).lineTo(x + s * 0.28, y + s * 0.72).stroke().restore();
}
function iconDash(doc, x, y, s, color = '#fff') {
  doc.save().lineWidth(s * 0.16).strokeColor(color).lineCap('round')
     .moveTo(x + s * 0.28, y + s * 0.5).lineTo(x + s * 0.72, y + s * 0.5).stroke().restore();
}

/* ---------------------------------------------------------------- generate */

async function generateDailyReport(trackerId) {
  const { head, items, chapters, biz, progress, speed, streak } = await fetchReportData(trackerId);
  if (!head || !items.length) throw new Error(`no report data for tracker ${trackerId}`);

  const total = items.length;
  const answered = items.filter(i => i.answered_option).length;
  const correct = items.filter(i => i.is_correct).length;
  const wrong = answered - correct;
  const skipped = total - answered;
  const pct = Math.round((correct * 100) / total);
  const accuracy = answered ? Math.round((correct * 100) / answered) : 0;
  const g = gradeFor(pct);

  const byPct = [...chapters].sort((a, b) => (b.correct / b.asked) - (a.correct / a.asked));
  const strongest = byPct[0], weakest = byPct[byPct.length - 1];
  const mins = head.started_at && head.finished_at
    ? Math.max(1, Math.round((new Date(head.finished_at) - new Date(head.started_at)) / 60000)) : null;

  // Sequential name (<YYYYMMDD><n>.pdf), reused if this tracker already has a
  // report — so regenerating overwrites rather than orphaning the old file.
  const fileName = await nextReportFileName({
    reportType: 'daily', trackerId, date: head.quiz_date, studentId: head.student_id,
  });
  const relPath = `${TYPES.daily}/${dateParts(head.quiz_date).folder}/${fileName}`;
  const filePath = path.join(REPORTS_ROOT, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // The child's previous daily report, so the parent can see movement rather
  // than a number in isolation. Absent for a first quiz, and the whole band is
  // simply skipped then — no "0% change" against nothing.
  const prev = (await db.query(
    `SELECT score_correct, score_total, score_pct, grade, quiz_date::text
       FROM quiz_reports
      WHERE student_id = $1 AND report_type = 'daily' AND is_active
        AND quiz_date < $2::date
      ORDER BY quiz_date DESC, id DESC LIMIT 1`,
    [head.student_id, head.quiz_date])).rows[0] || null;

  // average seconds per question last time, for the speed comparison
  const prevSpeed = prev ? (await db.query(
    `SELECT ROUND(AVG(h.response_seconds))::int avg_s
       FROM student_quizpe_histories h
       JOIN quizpe_tracker t ON t.id = h.tracker_id
      WHERE t.student_id = $1 AND t.quiz_date = $2::date
        AND h.response_seconds IS NOT NULL`,
    [head.student_id, prev.quiz_date])).rows[0] : null;

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `QuizPe Report — ${head.student_name}`, Author: biz.company_name || 'QuizPe' } });
  // Bind fonts to this document, not a module variable — reports render two
  // at a time, so a shared family would let an English and a Kannada report
  // overwrite each other's font choice mid-render.
  doc._F = useFontsFor(doc, head.medium_code);

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const M = 36;                      // page margin
  const PW = doc.page.width;
  const W = PW - M * 2;              // content width

  /* ---------- header band with business details ---------- */
  doc.rect(0, 0, PW, 108).fill(C.brand);
  doc.rect(0, 108, PW, 4).fill(C.accent);

  const logo = require('../assets/buildLogo').paths.white;
  if (fs.existsSync(logo)) {
    doc.image(logo, M, 26, { height: 44 });
  } else {
    doc.fillColor(C.white).font(doc._F.bold).fontSize(24).text(biz.product_name || 'QuizPe', M, 26);
    doc.font(doc._F.regular).fontSize(9).fillColor('#bfe3da').text(biz.product_tagline || '', M, 54);
  }
  doc.font(doc._F.bold).fontSize(11).fillColor(C.white).text('Daily Quiz Report', M, 78);

  // business block (right aligned)
  const bx = PW / 2, bw = W / 2;
  doc.font(doc._F.bold).fontSize(9).fillColor(C.white)
     .text(biz.company_name || '', bx, 24, { width: bw, align: 'right' });
  doc.font(doc._F.regular).fontSize(7.5).fillColor('#cfe9e2');
  const bizLines = [
    biz.company_tagline,
    biz.address,
    biz.gstin ? `GSTIN: ${biz.gstin}` : null,
    [biz.support_email, biz.product_website].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
  // Advance by the ACTUAL rendered height, not a fixed 11px. The address wraps
  // to two lines, so a flat step drew the GSTIN on top of the pincode line.
  let by = 38;
  bizLines.forEach(l => {
    doc.text(l, bx, by, { width: bw, align: 'right' });
    by += doc.heightOfString(l, { width: bw }) + 1.5;
  });

  let y = 128;

  /* ---------- Parent + Student cards (side by side) ---------- */
  const colW = (W - 12) / 2, cardH = 92;
  card(doc, M, y, colW, cardH);
  card(doc, M + colW + 12, y, colW, cardH);

  label(doc, 'Parent / Guardian', M + 12, y + 12, C.accent);
  doc.fillColor(C.ink).font(doc._F.bold).fontSize(13).text(head.parent_name || '—', M + 12, y + 26);
  kv(doc, 'Mobile', maskMobile(head.parent_mobile_number), M + 12, y + 50, colW - 24);
  kv(doc, 'State', head.state_name || '—', M + 12, y + 66, colW - 24);

  const sx = M + colW + 12;
  label(doc, 'Student', sx + 12, y + 12, C.accent);
  doc.fillColor(C.ink).font(doc._F.bold).fontSize(13).text(head.student_name || '—', sx + 12, y + 26);
  kv(doc, 'Board / Grade', `${head.board_code} · ${head.grade_name}`, sx + 12, y + 50, colW - 24);
  kv(doc, 'Subject / Medium', `${head.subject_name} · ${head.medium_name}`, sx + 12, y + 66, colW - 24);
  if (head.school_name) kv(doc, 'School', head.school_name, sx + 12, y + 82, colW - 24);

  y += cardH + 14;

  /* ---------- quiz meta strip ---------- */
  card(doc, M, y, W, 30, { fill: C.soft, stroke: C.soft });
  const isTest = head.quiz_type === 'test';
  doc.fillColor(C.muted).font(doc._F.regular).fontSize(9);
  const metaBits = [
    fmtDate(head.quiz_date),
    isTest ? 'TEST' : 'Daily quiz',
    `${total} questions`,
    mins ? `${mins} min` : null,
    head.plan_name ? head.plan_name : null,
  ].filter(Boolean).join('     |     ');
  doc.text(metaBits, M + 12, y + 10, { width: W - 24 });
  y += 44;

  /* ---------- performance cards: Score | Grade | Accuracy | Breakdown ---- */
  const q = (W - 36) / 4, ph = 78;
  const cards = [
    { t: 'Score', big: `${correct}/${total}`, sub: `${pct}%`, color: C.ink },
    { t: 'Grade', big: g.grade, sub: g.label, color: g.color },
    { t: 'Accuracy', big: `${accuracy}%`, sub: `of ${answered} answered`, color: C.accent },
  ];
  cards.forEach((cc, i) => {
    const cx = M + i * (q + 12);
    card(doc, cx, y, q, ph);
    label(doc, cc.t, cx + 12, y + 12);
    doc.fillColor(cc.color).font(doc._F.bold).fontSize(24).text(cc.big, cx + 12, y + 26);
    doc.fillColor(C.muted).font(doc._F.regular).fontSize(9).text(cc.sub, cx + 12, y + 56);
  });
  // 4th card: correct/wrong/skipped breakdown
  const cx = M + 3 * (q + 12);
  card(doc, cx, y, q, ph);
  label(doc, 'Breakdown', cx + 12, y + 12);
  const rows = [['Correct', correct, C.ok], ['Wrong', wrong, C.bad], ['Skipped', skipped, C.faint]];
  rows.forEach((r, i) => {
    const ry = y + 28 + i * 15;
    doc.circle(cx + 15, ry + 4, 3).fill(r[2]);
    doc.fillColor(C.muted).font(doc._F.regular).fontSize(9).text(r[0], cx + 24, ry);
    doc.fillColor(C.ink).font(doc._F.bold).fontSize(9).text(String(r[1]), cx + 12, ry, { width: q - 24, align: 'right' });
  });
  y += ph + 14;

  /* ---------- progress since the last quiz ---------- */
  if (prev && prev.score_total) {
    label(doc, `Since last quiz (${fmtDate(prev.quiz_date)})`, M, y, C.brand, 10); y += 16;

    const dPct = pct - prev.score_pct;
    const dCorrect = correct - prev.score_correct;
    const dSpeed = (speed?.avg_s != null && prevSpeed?.avg_s != null)
      ? speed.avg_s - prevSpeed.avg_s : null;

    // a lower time is better, so the arrow for speed is inverted on purpose
    const band = [
      { t: 'Score', now: `${pct}%`, was: `${prev.score_pct}%`, d: dPct, unit: '%', better: dPct > 0 },
      { t: 'Correct answers', now: `${correct}/${total}`, was: `${prev.score_correct}/${prev.score_total}`,
        d: dCorrect, unit: '', better: dCorrect > 0 },
      { t: 'Grade', now: g.grade, was: prev.grade || '—', d: null, unit: '', better: null },
    ];
    if (dSpeed != null) {
      band.push({ t: 'Avg time / question', now: `${speed.avg_s}s`, was: `${prevSpeed.avg_s}s`,
                  d: dSpeed, unit: 's', better: dSpeed < 0 });
    }

    const bw = (W - 12 * (band.length - 1)) / band.length, bh = 56;
    band.forEach((b, i) => {
      const bx = M + i * (bw + 12);
      const tone = b.better === null ? C.soft : b.better ? '#e9f8f0' : '#fdeceb';
      card(doc, bx, y, bw, bh, { fill: tone, stroke: tone });
      label(doc, b.t, bx + 10, y + 8, C.muted, 7);
      doc.fillColor(C.ink).font(doc._F.bold).fontSize(16).text(b.now, bx + 10, y + 20, { width: bw - 20 });
      let sub = `was ${b.was}`;
      if (b.d != null && b.d !== 0) {
        sub = `${b.d > 0 ? '+' : ''}${b.d}${b.unit}  (was ${b.was})`;
      } else if (b.d === 0) {
        sub = `no change (was ${b.was})`;
      }
      doc.fillColor(b.better === null ? C.faint : b.better ? C.ok : C.warn)
         .font(doc._F.bold).fontSize(7).text(sub, bx + 10, y + 42, { width: bw - 20 });
    });
    y += bh + 8;

    // one plain sentence, because most parents read this and nothing else
    const verdict = dPct > 0
      ? `${head.student_name} improved by ${dPct} percentage points since the last quiz.`
      : dPct < 0
        ? `${head.student_name} scored ${Math.abs(dPct)} points lower than last time — worth a look at the chapters below.`
        : `${head.student_name} held steady at ${pct}%.`;
    doc.fillColor(C.muted).font(doc._F.regular).fontSize(9).text(verdict, M, y, { width: W });
    y += 20;
  }

  /* ---------- speed & consistency ---------- */
  if ((speed && speed.avg_s != null) || streak > 0) {
    label(doc, 'Speed & consistency', M, y, C.brand, 10); y += 16;
    const sw = (W - 24) / 3, sh = 52;
    const isPB = speed?.fast_s != null && speed?.best_s != null && speed.fast_s <= speed.best_s;
    const tiles = [
      { t: 'Avg time / question', v: speed?.avg_s != null ? `${speed.avg_s}s` : '—', s: 'this quiz', c: C.ink },
      { t: 'Fastest answer', v: speed?.fast_s != null ? `${speed.fast_s}s` : '—', s: isPB ? 'NEW PERSONAL BEST' : (speed?.best_s != null ? `best ever ${speed.best_s}s` : ''), c: isPB ? C.ok : C.accent },
      { t: 'Daily streak', v: streak > 0 ? `${streak}` : '0', s: streak === 1 ? 'day' : 'days in a row', c: streak >= 3 ? C.warn : C.ink },
    ];
    tiles.forEach((tl, i) => {
      const tx = M + i * (sw + 12);
      card(doc, tx, y, sw, sh, { fill: C.soft, stroke: C.soft });
      label(doc, tl.t, tx + 10, y + 8, C.muted, 7);
      doc.fillColor(tl.c).font(doc._F.bold).fontSize(18).text(tl.v, tx + 10, y + 20, { width: sw - 20 });
      if (tl.s) doc.fillColor(tl.s === 'NEW PERSONAL BEST' ? C.ok : C.faint).font(tl.s === 'NEW PERSONAL BEST' ? 'Helvetica-Bold' : 'Helvetica')
                   .fontSize(7).text(tl.s, tx + 10, y + 40, { width: sw - 20 });
    });
    y += sh + 14;
  }

  /* ---------- adaptive learning progress ---------- */
  if (progress && progress.total) {
    label(doc, 'Learning progress', M, y, C.brand, 10); y += 16;
    card(doc, M, y, W, 44, { fill: C.accentSoft, stroke: C.accentSoft });
    const done = progress.status === 'completed';
    doc.fillColor(C.ink).font(doc._F.bold).fontSize(10)
       .text(done ? 'Syllabus completed — now revising all chapters'
                  : `Currently learning: ${progress.frontier_chapter}`, M + 12, y + 9, { width: W - 24 });
    // progress bar over chapters
    const barY = y + 26, barW = W - 24;
    const frac = done ? 1 : progress.mastered / progress.total;
    doc.roundedRect(M + 12, barY, barW, 8, 4).fill('#d4ede6');
    if (frac > 0) doc.roundedRect(M + 12, barY, barW * frac, 8, 4).fill(C.accent);
    doc.fillColor(C.brand).font(doc._F.regular).fontSize(8)
       .text(`${progress.mastered} of ${progress.total} chapters mastered  ·  ${done ? 100 : Math.round(frac * 100)}%`, M + 12, barY + 11);
    y += 58;
  }

  /* ---------- chapter analytics ---------- */
  if (y > doc.page.height - 130) { doc.addPage(); y = M; }
  label(doc, 'Chapter-wise analytics', M, y, C.brand, 10); y += 16;
  chapters.forEach(ch => {
    const chPct = Math.round((ch.correct * 100) / ch.asked);
    doc.fillColor(C.ink).font(doc._F.regular).fontSize(9).text(ch.chapter, M, y, { width: W - 90 });
    doc.fillColor(C.muted).font(doc._F.bold).fontSize(9)
       .text(`${ch.correct}/${ch.asked}  ·  ${chPct}%`, M, y, { width: W, align: 'right' });
    const barY = y + 13;
    doc.roundedRect(M, barY, W, 6, 3).fill('#edf1f3');
    if (chPct > 0) doc.roundedRect(M, barY, W * chPct / 100, 6, 3).fill(chPct >= 60 ? C.accent : chPct >= 40 ? C.warn : C.bad);
    y = barY + 16;
  });

  // strongest / weakest insight
  if (strongest && weakest) {
    y += 4;
    card(doc, M, y, W, 30, { fill: C.accentSoft, stroke: C.accentSoft });
    doc.font(doc._F.bold).fontSize(9).fillColor(C.ok).text('Strongest: ', M + 12, y + 10, { continued: true })
       .font(doc._F.regular).fillColor(C.brand).text(`${strongest.chapter} (${Math.round(strongest.correct * 100 / strongest.asked)}%)`);
    doc.font(doc._F.bold).fontSize(9).fillColor(C.bad).text('Focus on: ', M + W / 2, y + 10, { continued: true })
       .font(doc._F.regular).fillColor(C.brand).text(`${weakest.chapter} (${Math.round(weakest.correct * 100 / weakest.asked)}%)`);
    y += 42;
  }

  /* ---------- answer review ---------- */
  if (y > doc.page.height - 120) { doc.addPage(); y = M; }
  label(doc, 'Answer review — with explanations', M, y, C.brand, 10); y += 18;

  const optText = (it, l) => ({ A: it.option_a, B: it.option_b, C: it.option_c, D: it.option_d }[l]);
  doc.y = y;
  items.forEach(it => {
    if (doc.y > doc.page.height - 96) { doc.addPage(); doc.y = M; }
    const top = doc.y;
    const badge = it.is_correct ? C.ok : (it.answered_option ? C.bad : C.faint);

    doc.roundedRect(M, top, 18, 18, 4).fill(badge);
    if (it.is_correct) iconCheck(doc, M, top, 18);
    else if (it.answered_option) iconCross(doc, M, top, 18);
    else iconDash(doc, M, top, 18);

    doc.fillColor(C.ink).font(doc._F.bold).fontSize(9.5)
       .text(`Q${it.serial_number}. `, M + 26, top + 2, { continued: true })
       .font(doc._F.regular).text(it.question_pdf, { width: W - 26 });

    doc.fillColor(C.muted).font(doc._F.regular).fontSize(8.5)
       .text(`Your answer: ${it.answered_option ? `${it.answered_option}) ${optText(it, it.answered_option) ?? ''}` : 'not answered'}`, M + 26, doc.y + 2);
    if (!it.is_correct) {
      doc.fillColor(C.ok).font(doc._F.bold).fontSize(8.5)
         .text(`Correct: ${it.answer}) ${optText(it, it.answer) ?? ''}`, M + 26, doc.y + 1);
    }
    if (it.explanation) {
      doc.fillColor(C.warn).font(doc._F.bold).fontSize(8.5).text('Why: ', M + 26, doc.y + 1, { continued: true })
         .fillColor(C.faint).font(doc._F.oblique).text(it.explanation, { width: W - 40 });
    }
    // drawn "working" for the question, when we can build one
    try {
      const { drawVisual } = require('./visualExplain');
      const vw = W - 30;   // full content width, so long number-words never clip
      if (doc.y + 90 > doc.page.height - 40) { doc.addPage(); doc.y = M; }
      const used = drawVisual(doc, M + 26, doc.y + 6, vw, it);
      if (used) doc.y += used + 10;
    } catch (e) { /* visual is a bonus, never break the report */ }
    doc.moveTo(M, doc.y + 6).lineTo(M + W, doc.y + 6).strokeColor(C.line).lineWidth(0.5).stroke();
    doc.y += 12;
  });

  /* ---------- footer on every page ---------- */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.rect(0, doc.page.height - 26, PW, 26).fill(C.brand);
    doc.fillColor('#cfe9e2').font(doc._F.regular).fontSize(7.5)
       .text(`${biz.company_name || 'QuizPe'}  ·  ${biz.support_email || ''}  ·  Report generated ${fmtDate(new Date())}`,
             M, doc.page.height - 18, { width: W, align: 'left' });
    doc.fillColor(C.white).text(`Page ${i + 1} of ${range.count}`, M, doc.page.height - 18, { width: W, align: 'right' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });

  // ---- persist + token ----
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const accessToken = crypto.randomBytes(18).toString('hex');
  const publicUrl = `${base}/reports/dl/${accessToken}`;
  await db.query(
    `INSERT INTO quiz_reports (tracker_id, student_id, quiz_date, report_type, file_name, file_path,
                               public_url, access_token, score_correct, score_total, score_pct, grade)
     VALUES ($1,$2,$3,'daily',$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tracker_id) DO UPDATE SET
       file_name=EXCLUDED.file_name, file_path=EXCLUDED.file_path, public_url=EXCLUDED.public_url,
       access_token=EXCLUDED.access_token, score_correct=EXCLUDED.score_correct,
       score_total=EXCLUDED.score_total, score_pct=EXCLUDED.score_pct, grade=EXCLUDED.grade, modified_at=now()`,
    [trackerId, head.student_id, head.quiz_date, path.basename(filePath), relPath, publicUrl, accessToken,
     correct, total, pct, g.grade]);

  return {
    filePath, fileName: path.basename(filePath), relPath, publicUrl,
    score: { correct, total, pct, accuracy, grade: g.grade, label: g.label },
    head,
  };
}

/* filename: <YYYYMMDD>-<studentId>-<subject>.pdf, foldered by date */
function dateParts(d0) {
  const d = new Date(d0);
  const folder = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { folder, compact: folder.replace(/-/g, '') };
}


module.exports = { generateDailyReport, gradeFor, REPORTS_ROOT, TYPES };
