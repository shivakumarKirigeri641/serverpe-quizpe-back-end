/**
 * src/pdf/visualExplain.js
 * ---------------------------------------------------------------------------
 * Turns a question + its explanation into a DRAWN diagram for the PDF report,
 * so a parent/child sees *why* rather than just a sentence.
 *
 * Patterns covered (chosen by how common they are in question_bank):
 *   • place value / number name  -> H|T|O boxes + expanded form + words
 *   • addition / subtraction     -> column arithmetic with carry/borrow
 *   • multiplication             -> repeated addition + dot array
 *   • greatest / smallest / order-> number line with the values marked
 *
 * Every visual is vector-drawn (no fonts/emoji issues) and returns the height
 * it consumed so the caller can advance. Returns null when nothing matches —
 * the report then just shows the text explanation.
 * ---------------------------------------------------------------------------
 */

const C = {
  ink: '#111b21', muted: '#667781', faint: '#8a97a0', line: '#cfd8dc',
  brand: '#075e54', accent: '#00a884', soft: '#f2f7f6', warn: '#b8860b', bad: '#c0392b',
};

/* --------------------------------------------------------------- helpers */
const digits = (n) => String(n).split('');
const num = (s) => Number(String(s).replace(/[,\s]/g, ''));

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Indian-system number to words (handles up to crores). */
function toWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const two = (x) => x < 20 ? ONES[x] : `${TENS[Math.floor(x / 10)]}${x % 10 ? '-' + ONES[x % 10] : ''}`;
  const three = (x) => {
    const h = Math.floor(x / 100), r = x % 100;
    return [h ? `${ONES[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' ');
  };
  const parts = [];
  const cr = Math.floor(n / 10000000); n %= 10000000;
  const lk = Math.floor(n / 100000);   n %= 100000;
  const th = Math.floor(n / 1000);     n %= 1000;
  if (cr) parts.push(`${three(cr)} Crore`);
  if (lk) parts.push(`${three(lk)} Lakh`);
  if (th) parts.push(`${three(th)} Thousand`);
  if (n)  parts.push(three(n));
  return parts.join(' ');
}

const PLACE_LABELS = ['Ones', 'Tens', 'Hundreds', 'Thousands', 'Ten Th.', 'Lakhs', 'Ten L.', 'Crores'];

/* ------------------------------------------------------------- detection */
/**
 * Work out what this question is really doing. The explanation usually holds
 * the arithmetic (even for word problems), so we parse that first.
 */
/**
 * Parse "a op b [op c …] = r" (chained operands allowed) and VERIFY the maths.
 * Verification matters: a naive regex on "6 + 4 + 6 = 16" happily matches
 * "4 + 6 = 16", which is false — drawing that would teach the child wrongly.
 */
function parseChain(src) {
  const m = String(src).match(/(\d[\d,]*(?:\s*[+\-−]\s*\d[\d,]*)+)\s*=\s*(\d[\d,]*)/);
  if (!m) return null;
  const r = num(m[2]);
  const ops = (m[1].match(/[+\-−]/g) || []).map(o => (o === '+' ? '+' : '-'));
  const nums = (m[1].match(/\d[\d,]*/g) || []).map(num);
  if (nums.length < 2 || !ops.length) return null;
  if (!ops.every(o => o === ops[0])) return null;           // mixed +/- — skip
  const kind = ops[0] === '+' ? 'add' : 'sub';
  const calc = kind === 'add'
    ? nums.reduce((a, b) => a + b, 0)
    : nums.slice(1).reduce((a, b) => a - b, nums[0]);
  if (calc !== r) return null;                              // doesn't compute — don't draw it
  return { kind, nums, r };
}

function detect({ question = '', explanation = '', correctText = '' }) {
  const q = String(question), e = String(explanation);

  // number name / in words / place value — take the VALUE, not the first digit
  const isNumberName = /number name|in words|write .*words/i.test(q);
  if (isNumberName || /hundreds?\s*\+|tens?\s*\+.*ones?/i.test(q)) {
    // "number name of 546" / "546 in words" -> the number is in the QUESTION
    const asked = isNumberName
      ? (q.match(/(?:number name|name)\s*(?:of|for)?\s*[:\-]?\s*(\d[\d,]*)/i)
         || q.match(/(\d[\d,]*)\s*(?:in words)/i))
      : null;
    // "600 + 60 + 2 = 662" -> the value is the RESULT
    const fromExpl = e.match(/=\s*(\d[\d,]*)/);
    const fromAns = String(correctText).match(/\d[\d,]*/);
    const n = num(asked?.[1] ?? fromExpl?.[1] ?? fromAns?.[0] ?? NaN);
    if (Number.isFinite(n) && n > 0) return { kind: 'place', n };
  }

  // a × b = c (verified)
  for (const src of [e, q]) {
    const m = src.match(/(\d[\d,]*)\s*[x×*]\s*(\d[\d,]*)\s*=\s*(\d[\d,]*)/i);
    if (m) {
      const a = num(m[1]), b = num(m[2]), r = num(m[3]);
      if (a * b === r) return { kind: 'mul', a, b, r };
    }
  }

  // addition / subtraction chains (verified), explanation first
  for (const src of [e, q]) {
    const c = parseChain(src);
    if (c) return c;
  }

  // "what comes just after/before N" -> neighbours on a number line
  const ba = q.match(/comes?\s+(?:just\s+)?(after|before)\s+(\d[\d,]*)/i);
  if (ba) {
    const n = num(ba[2]);
    const ansRaw = e.match(/is\s+(\d[\d,]*)/i)?.[1] ?? String(correctText).match(/\d[\d,]*/)?.[0];
    const ans = num(ansRaw);
    const expected = ba[1].toLowerCase() === 'after' ? n + 1 : n - 1;
    if (Number.isFinite(ans) && ans === expected) {
      return { kind: 'seq', values: [n - 1, n, n + 1], highlight: ans, caption: `just ${ba[1].toLowerCase()} ${n}` };
    }
  }

  // skip counting / next in sequence
  if (/skip count|next/i.test(q)) {
    const list = (q.match(/\d[\d,]*/g) || []).map(num).filter(Number.isFinite);
    const ansRaw = e.match(/next is\s*(\d[\d,]*)/i)?.[1] ?? String(correctText).match(/\d[\d,]*/)?.[0];
    const ans = num(ansRaw);
    if (list.length >= 3 && Number.isFinite(ans)) {
      const t = list.slice(-3);
      const d1 = t[1] - t[0], d2 = t[2] - t[1];
      if (d1 === d2 && d1 > 0 && ans - t[2] === d1) {
        return { kind: 'seq', values: [...t, ans], highlight: ans, caption: `counting in ${d1}s` };
      }
    }
  }

  // "A has 8 ducks and B has 9 ducks. Who has more?"
  const two = q.match(/(\w+)\s+has\s+(\d[\d,]*)[\s\S]*?(\w+)\s+has\s+(\d[\d,]*)/i);
  if (two && /who has (more|fewer|less)/i.test(q)) {
    const a = { name: two[1], v: num(two[2]) }, b = { name: two[3], v: num(two[4]) };
    const wantMore = /more/i.test(q.match(/who has (more|fewer|less)/i)[1]);
    if (Number.isFinite(a.v) && Number.isFinite(b.v) && a.v !== b.v) {
      const win = (wantMore ? (a.v > b.v) : (a.v < b.v)) ? a.name : b.name;
      return { kind: 'bars', a, b, winner: win };
    }
  }

  // fractions — use the SIMPLEST form at the end of the explanation
  if (/\d\s*\/\s*\d/.test(q) || /\d\s*\/\s*\d/.test(e)) {
    const all = [...e.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
    if (all.length) {
      const last = all[all.length - 1];
      const nmr = Number(last[1]), den = Number(last[2]);
      if (den > 0 && den <= 24 && nmr <= den) return { kind: 'fraction', n: nmr, d: den };
    }
  }

  // clock — "one hour before 11 o'clock is 10 o'clock"
  const ck = e.match(/is\s+(\d{1,2})\s*o'?\s*clock/i) || String(correctText).match(/^(\d{1,2})\s*o'?\s*clock/i);
  if (ck && /o'?\s*clock/i.test(q)) {
    const h = Number(ck[1]);
    if (h >= 1 && h <= 12) return { kind: 'clock', hour: h };
  }

  // greatest / smallest / ordering over a list of numbers
  if (/greatest|smallest|largest|ascending|descending|between/i.test(q)) {
    const list = (q.match(/\d[\d,]*/g) || []).map(num).filter(Number.isFinite);
    if (list.length >= 3) return { kind: 'compare', list, answer: num(correctText) };
  }
  return null;
}

/* ---------------------------------------------------------------- visuals */

/** Text width available inside the panel (keeps long words inside the box). */
const innerW = (w) => w - 16;

/** How tall this place-value visual will be — the words line can wrap. */
function placeHeight(doc, w, n) {
  const words = `In words: ${toWords(n)}`;
  const expanded = digits(n).map((d, i) => Number(d) * Math.pow(10, digits(n).length - 1 - i)).filter(v => v > 0);
  doc.font('Helvetica-Bold').fontSize(9);
  const hExp = doc.heightOfString(`${n} = ${expanded.join(' + ')}`, { width: innerW(w) });
  const hWords = doc.heightOfString(words, { width: innerW(w) });
  return 42 + hExp + 2 + hWords + 8;
}

/** Place-value boxes + expanded form + number in words. */
function drawPlace(doc, x, y, w, { n }) {
  const ds = digits(n);
  const cw = Math.min(34, Math.floor((w - 20) / Math.max(ds.length, 3)));
  const bx = x + 8, tw = innerW(w);
  ds.forEach((d, i) => {
    const place = ds.length - 1 - i;                    // 0 = ones
    const cx = bx + i * (cw + 4);
    doc.roundedRect(cx, y + 10, cw, 26, 3).fillAndStroke('#fff', C.line);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(14).text(d, cx, y + 16, { width: cw, align: 'center' });
    doc.fillColor(C.muted).font('Helvetica').fontSize(6)
       .text(PLACE_LABELS[place] || '', cx - 4, y + 2, { width: cw + 8, align: 'center' });
  });

  const expanded = ds.map((d, i) => Number(d) * Math.pow(10, ds.length - 1 - i)).filter(v => v > 0);
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(9);
  const expTxt = `${n} = ${expanded.join(' + ')}`;
  doc.text(expTxt, bx, y + 42, { width: tw });
  const afterExp = y + 42 + doc.heightOfString(expTxt, { width: tw }) + 2;

  // wrap the words line inside the panel instead of running past its edge
  doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(9)
     .text(`In words: ${toWords(n)}`, bx, afterExp, { width: tw, lineBreak: true });

  return placeHeight(doc, w, n);
}

/** Column arithmetic (supports chained operands) with a carry row. */
function drawColumn(doc, x, y, w, { kind, nums, r }) {
  const cols = Math.max(...nums.map(n => String(n).length), String(r).length);
  const pad = (v) => String(v).padStart(cols, ' ');
  const cw = 16, bx = x + 20;
  const rowY = (i) => y + 16 + i * 14;

  // place-value headers
  for (let i = 0; i < cols; i++) {
    doc.fillColor(C.faint).font('Helvetica').fontSize(6)
       .text((PLACE_LABELS[cols - 1 - i] || '').slice(0, 4), bx + i * cw, y + 2, { width: cw, align: 'center' });
  }

  // carry row (two-operand addition only — that's where it's taught)
  if (kind === 'add' && nums.length === 2) {
    const A = pad(nums[0]).split(''), B = pad(nums[1]).split('');
    const carries = new Array(cols).fill('');
    let carry = 0;
    for (let i = cols - 1; i >= 0; i--) {
      const s = (Number(A[i]) || 0) + (Number(B[i]) || 0) + carry;
      carry = s >= 10 ? 1 : 0;
      if (carry && i > 0) carries[i - 1] = '1';
    }
    doc.fillColor(C.warn).font('Helvetica-Bold').fontSize(7);
    carries.forEach((c, i) => { if (c) doc.text(c, bx + i * cw, y + 9, { width: cw, align: 'center' }); });
  }

  // operand rows
  nums.forEach((val, idx) => {
    const yy = rowY(idx + 0.4);
    if (idx > 0) doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11)
                    .text(kind === 'add' ? '+' : '-', x + 4, yy + 1);
    pad(val).split('').forEach((d, j) => {
      if (d.trim()) doc.fillColor(C.ink).font('Helvetica').fontSize(11)
                       .text(d, bx + j * cw, yy, { width: cw, align: 'center' });
    });
  });

  const lineY = rowY(nums.length + 0.3) + 2;
  doc.moveTo(x + 2, lineY).lineTo(bx + cols * cw, lineY).strokeColor(C.ink).lineWidth(0.8).stroke();
  pad(r).split('').forEach((d, j) => {
    if (d.trim()) doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(12)
                     .text(d, bx + j * cw, lineY + 4, { width: cw, align: 'center' });
  });
  return columnHeight(nums.length);
}
const columnHeight = (n) => 16 + (n + 0.3) * 14 + 22;

/** Multiplication as repeated addition + a dot array (when small enough). */
function drawMul(doc, x, y, w, { a, b, r }) {
  const rows = Math.min(a, b), cols = Math.max(a, b);
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(9)
     .text(`${a} × ${b} = ${r}`, x + 6, y + 4);
  // repeated addition (only when it stays readable)
  if (rows <= 10 && cols <= 12) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(8)
       .text(`${Array(rows).fill(cols).join(' + ')} = ${r}`, x + 6, y + 17, { width: w - 12 });
  }
  // dot array
  if (rows <= 10 && cols <= 12) {
    const d = 6, gap = 4, ox = x + 8, oy = y + 30;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        doc.circle(ox + j * (d + gap) + d / 2, oy + i * (d + gap) + d / 2, d / 2).fill(C.accent);
      }
    }
    doc.fillColor(C.faint).font('Helvetica').fontSize(7)
       .text(`${rows} rows of ${cols}`, ox + cols * (d + gap) + 8, oy + 2);
    return 36 + rows * (d + gap);
  }
  return 32;
}

/** Number line with the compared values marked, answer highlighted. */
function drawCompare(doc, x, y, w, { list, answer }) {
  const vals = [...new Set(list)].sort((p, q) => p - q);
  const min = vals[0], max = vals[vals.length - 1];
  const span = Math.max(1, max - min);
  const lx = x + 16, lw = w - 40, ly = y + 26;
  doc.moveTo(lx, ly).lineTo(lx + lw, ly).strokeColor(C.line).lineWidth(1).stroke();
  // arrow head
  doc.moveTo(lx + lw, ly).lineTo(lx + lw - 5, ly - 3).moveTo(lx + lw, ly).lineTo(lx + lw - 5, ly + 3)
     .strokeColor(C.line).stroke();
  vals.forEach(v => {
    const px = lx + ((v - min) / span) * lw;
    const isAns = answer != null && v === answer;
    doc.moveTo(px, ly - 4).lineTo(px, ly + 4).strokeColor(isAns ? C.accent : C.faint).lineWidth(isAns ? 1.6 : 0.8).stroke();
    doc.circle(px, ly, isAns ? 3.4 : 2).fill(isAns ? C.accent : C.faint);
    doc.fillColor(isAns ? C.accent : C.muted).font(isAns ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
       .text(String(v), px - 16, ly + 8, { width: 32, align: 'center' });
  });
  doc.fillColor(C.faint).font('Helvetica').fontSize(7).text('smaller', lx - 2, ly - 16);
  doc.fillColor(C.faint).text('greater', lx + lw - 30, ly - 16, { width: 32, align: 'right' });
  return 50;
}

/** Sequence / neighbours on a number line, with the step arrows. */
function drawSeq(doc, x, y, w, { values, highlight, caption }) {
  const n = values.length;
  const lx = x + 18, lw = w - 46, ly = y + 24;
  doc.moveTo(lx, ly).lineTo(lx + lw, ly).strokeColor(C.line).lineWidth(1).stroke();
  doc.moveTo(lx + lw, ly).lineTo(lx + lw - 5, ly - 3).moveTo(lx + lw, ly).lineTo(lx + lw - 5, ly + 3).strokeColor(C.line).stroke();
  const step = n > 1 ? lw / (n - 1 + 0.35) : lw;
  values.forEach((v, i) => {
    const px = lx + i * step;
    const on = v === highlight;
    doc.moveTo(px, ly - 5).lineTo(px, ly + 5).strokeColor(on ? C.accent : C.faint).lineWidth(on ? 1.6 : 0.8).stroke();
    doc.circle(px, ly, on ? 3.6 : 2.2).fill(on ? C.accent : C.faint);
    doc.fillColor(on ? C.accent : C.muted).font(on ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .text(String(v), px - 18, ly + 9, { width: 36, align: 'center' });
    // step arrow between points
    if (i > 0) {
      const mx = px - step / 2, d = v - values[i - 1];
      doc.fillColor(C.faint).font('Helvetica').fontSize(6.5).text(`+${d}`, mx - 12, ly - 15, { width: 24, align: 'center' });
    }
  });
  if (caption) doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(8).text(caption, x + 6, y + 4);
  return 48;
}

/** Two-bar comparison for "who has more / fewer". */
function drawBars(doc, x, y, w, { a, b, winner }) {
  const max = Math.max(a.v, b.v) || 1;
  const bw = w - 110, bx = x + 76;
  [a, b].forEach((p, i) => {
    const by = y + 8 + i * 22;
    const won = p.name === winner;
    doc.fillColor(won ? C.accent : C.muted).font(won ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
       .text(String(p.name).slice(0, 10), x + 6, by + 2, { width: 64, align: 'right' });
    doc.roundedRect(bx, by, bw, 13, 3).fill('#e6eeec');
    doc.roundedRect(bx, by, Math.max(6, bw * (p.v / max)), 13, 3).fill(won ? C.accent : C.faint);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.5).text(String(p.v), bx + bw + 6, by + 2);
  });
  return 56;
}

/** Fraction as a divided bar with the numerator shaded. */
function drawFraction(doc, x, y, w, { n, d }) {
  const bw = Math.min(w - 20, 240), bx = x + 8, by = y + 18, bh = 18;
  const cw = bw / d;
  for (let i = 0; i < d; i++) {
    doc.rect(bx + i * cw, by, cw, bh).fillAndStroke(i < n ? C.accent : '#fff', C.line);
  }
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(10).text(`${n}/${d}`, x + 8, y + 2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(7.5)
     .text(`${n} of ${d} equal parts`, bx + bw + 8, by + 5);
  return 48;
}

/** Simple clock face showing the answer hour. */
function drawClock(doc, x, y, w, { hour }) {
  const r = 24, cx = x + 32, cy = y + 30;
  doc.circle(cx, cy, r).fillAndStroke('#fff', C.line);
  for (let h = 1; h <= 12; h++) {
    const ang = (h / 12) * Math.PI * 2 - Math.PI / 2;
    const tx = cx + Math.cos(ang) * (r - 7), ty = cy + Math.sin(ang) * (r - 7);
    doc.fillColor(h === hour ? C.accent : C.faint).font(h === hour ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5)
       .text(String(h), tx - 5, ty - 3.5, { width: 10, align: 'center' });
  }
  const ha = (hour / 12) * Math.PI * 2 - Math.PI / 2;
  doc.moveTo(cx, cy).lineTo(cx + Math.cos(ha) * (r - 12), cy + Math.sin(ha) * (r - 12))
     .strokeColor(C.accent).lineWidth(2.2).stroke();                       // hour hand
  doc.moveTo(cx, cy).lineTo(cx, cy - (r - 6)).strokeColor(C.ink).lineWidth(1.2).stroke();  // minute hand at 12
  doc.circle(cx, cy, 2).fill(C.ink);
  doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(10)
     .text(`${hour} o'clock`, cx + r + 12, cy - 5);
  return 64;
}

/**
 * Public API — draw a visual for this question if we can.
 * @returns height consumed, or 0 when no visual applies.
 */
function drawVisual(doc, x, y, w, item) {
  let spec;
  try {
    spec = detect({
      question: item.question_pdf, explanation: item.explanation, correctText: item.correct_text,
    });
  } catch { return 0; }
  if (!spec) return 0;

  // light panel behind every visual so it reads as "the working"
  const render = () => {
    switch (spec.kind) {
      case 'place':    return drawPlace(doc, x, y, w, spec);
      case 'add':
      case 'sub':      return drawColumn(doc, x, y, w, spec);
      case 'mul':      return drawMul(doc, x, y, w, spec);
      case 'compare':  return drawCompare(doc, x, y, w, spec);
      case 'seq':      return drawSeq(doc, x, y, w, spec);
      case 'bars':     return drawBars(doc, x, y, w, spec);
      case 'fraction': return drawFraction(doc, x, y, w, spec);
      case 'clock':    return drawClock(doc, x, y, w, spec);
      default:         return 0;
    }
  };
  // heights are deterministic, so we can draw the panel before the content
  const est =
    spec.kind === 'place'    ? placeHeight(doc, w, spec.n) :
    spec.kind === 'compare'  ? 50 :
    spec.kind === 'seq'      ? 48 :
    spec.kind === 'bars'     ? 56 :
    spec.kind === 'fraction' ? 48 :
    spec.kind === 'clock'    ? 64 :
    spec.kind === 'mul'
      ? (Math.min(spec.a, spec.b) <= 10 && Math.max(spec.a, spec.b) <= 12 ? 36 + Math.min(spec.a, spec.b) * 10 : 32)
      : columnHeight(spec.nums.length);
  doc.roundedRect(x, y - 2, w, est + 4, 4).fillAndStroke(C.soft, C.soft);
  return render();
}

module.exports = { drawVisual, detect, toWords };
