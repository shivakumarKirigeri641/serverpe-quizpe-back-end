/**
 * src/mail/digest.js
 * ---------------------------------------------------------------------------
 * The founder's nightly "everything that happened today" email.
 *
 * Fires once a day just after the day-cutoff has settled (see scheduler
 * runDailyDigest), gathers every number the admin dashboard shows from the one
 * metrics module, and lays it out as a single scannable email to the operator
 * inbox. No new SQL lives here — it reuses src/admin/metrics.js so the email and
 * the dashboard can never disagree.
 *
 * MOBILE-FIRST by construction. Email clients (Gmail on Android/iOS especially)
 * ignore overflow-x, CSS media queries and horizontal scroll, so a wide
 * multi-column table just clips off-screen. Everything here is therefore laid
 * out as STACKED two-column label/value rows and a 2-up KPI grid — content that
 * WRAPS on a narrow screen rather than scrolls. Nothing is `white-space:nowrap`
 * except short numeric chips.
 *
 * Built to survive a partial failure: each block is gathered independently, so
 * one slow or broken query degrades to a "—" rather than losing the whole
 * report. It carries customer data (mobiles to nudge), so it goes to exactly one
 * recipient, the same as every other operator alert.
 * ---------------------------------------------------------------------------
 */

const metrics = require('../admin/metrics');

const C = { brand: '#075e54', accent: '#00a884', ink: '#111b21', muted: '#667781',
            line: '#e2e6e9', soft: '#f6f8f9', up: '#2e7d32', down: '#c62828', warn: '#ef6c00' };

const esc = (s) => String(s == null || s === '' ? '—' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const pctStr = (n) => `${Math.round(Number(n || 0))}%`;
/** Join the non-empty parts of a value into one wrapping string. */
const parts = (arr) => arr.filter((x) => x != null && x !== '').join(' &middot; ');

/** A coloured ▲/▼ delta chip from a metrics delta number. */
function chip(d, { paren = false } = {}) {
  const v = Number(d || 0);
  if (!v) return paren ? '' : `<span style="color:${C.muted};font-size:12px;">– flat</span>`;
  const up = v > 0;
  const body = `${up ? '▲' : '▼'} ${Math.abs(v)}%`;
  return `<span style="color:${up ? C.up : C.down};font-size:12px;font-weight:700;white-space:nowrap;">${paren ? `(${body})` : body}</span>`;
}

/* -------------------------------------------------------------- primitives */
/** Stacked label/value rows. Label wraps (no nowrap) so nothing clips on mobile. */
const rowsHtml = (pairs) => pairs.filter(Boolean).map(([k, v]) => `
  <tr>
    <td style="padding:7px 10px;background:${C.soft};border:1px solid ${C.line};font-size:12px;color:${C.muted};vertical-align:top;width:40%;">${esc(k)}</td>
    <td style="padding:7px 10px;border:1px solid ${C.line};font-size:13px;color:${C.ink};vertical-align:top;">${v == null ? '—' : v}</td>
  </tr>`).join('');

/** A stacked two-column table, or a muted line when there is nothing to show. */
function stack(pairs, empty = 'Nothing to show') {
  const clean = (pairs || []).filter(Boolean);
  if (!clean.length) return `<p style="margin:6px 0 0;font-size:13px;color:${C.muted};">${esc(empty)}</p>`;
  return `<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;margin-top:6px;table-layout:fixed;">${rowsHtml(clean)}</table>`;
}

const section = (title, inner) =>
  `<h3 style="margin:24px 0 0;font-size:14px;color:${C.brand};text-transform:uppercase;letter-spacing:.4px;">${esc(title)}</h3>${inner}`;

/** Headline KPI tiles, laid out 2 per row so they never overflow a phone. */
function kpiGrid(tilesIn) {
  const tiles = tilesIn.filter(Boolean);
  let out = '';
  for (let i = 0; i < tiles.length; i += 2) {
    const pair = tiles.slice(i, i + 2);
    const cells = pair.map((t) => `
      <td width="50%" style="padding:5px;vertical-align:top;">
        <div style="border:1px solid ${C.line};border-radius:10px;padding:11px 12px;background:#fff;">
          <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.3px;">${esc(t.label)}</div>
          <div style="font-size:20px;font-weight:800;color:${t.color || C.ink};margin-top:3px;line-height:1.1;">${t.value}</div>
          ${t.sub ? `<div style="margin-top:3px;font-size:12px;">${t.sub}</div>` : ''}
        </div>
      </td>`).join('');
    const filler = pair.length < 2 ? '<td width="50%"></td>' : '';
    out += `<tr>${cells}${filler}</tr>`;
  }
  return `<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;width:100%;margin-top:8px;table-layout:fixed;">${out}</table>`;
}

function shell({ title, lead, body }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef2f1;">
  <div style="max-width:600px;margin:0 auto;padding:14px 10px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid ${C.line};">
      <div style="background:${C.brand};padding:16px 18px;">
        <span style="display:inline-block;background:${C.accent};color:#fff;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 10px;border-radius:20px;">Daily report</span>
        <h1 style="margin:10px 0 0;color:#fff;font-size:18px;line-height:1.3;">${esc(title)}</h1>
        ${lead ? `<p style="margin:6px 0 0;color:#cfe9e2;font-size:13px;">${esc(lead)}</p>` : ''}
      </div>
      <div style="padding:2px 16px 22px;">${body}</div>
      <div style="padding:14px 16px;border-top:1px solid ${C.line};background:${C.soft};color:${C.muted};font-size:11px;">
        Automated nightly report from QuizPe · ServerPe App Solutions.<br>
        Sent to the operator inbox only — contains customer data, please do not forward.
      </div>
    </div>
  </div></body></html>`;
}

/** Run a metrics call, never let it throw the whole report. */
async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.error('[digest] block failed:', e.message); return fallback; }
}

const istDate = () => new Date().toLocaleDateString('en-IN',
  { timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

const fmtDay = (d) => {
  try {
    return new Date(String(d) + 'T00:00:00').toLocaleDateString('en-IN',
      { day: '2-digit', month: 'short', weekday: 'short' });
  } catch { return String(d); }
};

/**
 * Build the full nightly digest. Returns { subject, html, text } ready for
 * sendAdminMail. All figures are today (IST) unless a block says otherwise.
 */
async function buildDigest() {
  const [ov, cmp, coh, split, part, funnel, ret, boards, brief, celeb] = await Promise.all([
    safe(() => metrics.overview(), {}),
    safe(() => metrics.comparisons(), {}),
    safe(() => metrics.cohort(), {}),
    safe(() => metrics.planSplit(), { plans: [], conversion: {} }),
    safe(() => metrics.participationDaily(7), []),
    safe(() => metrics.funnel(), []),
    safe(() => metrics.retention(), []),
    safe(() => metrics.boardTotals(), []),
    safe(() => metrics.briefing(), { stats: {}, trials_ending: [], missed: [] }),
    safe(() => metrics.celebrations(), { perfect: [], streaks: [], latest_payment: null }),
  ]);

  const q = cmp.quizzes || {}, sg = cmp.signups || {}, rv = cmp.revenue || {};
  const bs = brief.stats || {};
  const p = coh.participation || {}, sc = coh.scoring || {}, tr = coh.trend || {};
  const conv = split.conversion || {};

  /* ---- tonight at a glance (2×2 KPI grid) ---- */
  const glance = kpiGrid([
    { label: 'Quizzes today', value: num(q.today?.now ?? 0), sub: chip(q.today?.delta), color: C.brand },
    { label: 'Completed', value: num(p.completed ?? 0), sub: `<span style="color:${C.muted};">of ${num(p.expected ?? 0)} due</span>` },
    { label: 'Avg score', value: pctStr(sc.avg_pct), color: C.accent },
    { label: 'Revenue today', value: money(rv.today?.now), sub: chip(rv.today?.delta), color: C.up },
  ]);

  /* ---- today's cohort ---- */
  const cohortBlock = section("Today's participation", stack([
    ['Expected (due a quiz)', num(p.expected)],
    ['Delivered', `${num(p.delivered)} (${pctStr(p.delivered_pct)})`],
    ['Started', `${num(p.started)} (${pctStr(p.started_pct)})`],
    ['Completed', `${num(p.completed)} (${pctStr(p.completed_pct)})`],
    ['Missed / skipped', num(p.missed)],
    ['Finish rate (of openers)', pctStr(p.finish_rate_pct)],
  ])) + section("Today's scoring", stack([
    ['Scored quizzes', num(sc.scored)],
    ['Average score', pctStr(sc.avg_pct)],
    ['Excellent (≥80%)', `${num(sc.excellent)} (${pctStr(sc.excellent_pct)})`],
    ['Fair (60–79%)', `${num(sc.fair)} (${pctStr(sc.fair_pct)})`],
    ['Needs help (<60%)', `${num(sc.needs_help)} (${pctStr(sc.needs_help_pct)})`],
    ['Improved vs last quiz', `${num(tr.improved)} of ${num(tr.comparable)} (${pctStr(tr.improved_pct)})`],
    ['Declined', `${num(tr.declined)} (${pctStr(tr.declined_pct)})`],
    ['Avg change / child', `${Number(tr.avg_change) > 0 ? '+' : ''}${num(tr.avg_change)}%`],
  ]));

  /* ---- growth & base ---- */
  const growthBlock = section('Customers & growth', stack([
    ['Parents (total)', num(ov.parents_total)],
    ['Children (total)', num(ov.students_total)],
    ['Active trials', num(ov.trial_active)],
    ['Active paid', num(ov.paid_active)],
    ['Expired (not renewed)', num(ov.expired)],
    ['Signups — today', parts([num(sg.today?.now ?? 0), chip(sg.today?.delta, { paren: true })])],
    ['Signups — this week', parts([num(sg.week?.now ?? 0), chip(sg.week?.delta, { paren: true })])],
    ['Trial → paid conversion', `${num(conv.converted)} of ${num(conv.tried)} (${pctStr(conv.pct)})`],
  ]));

  /* ---- revenue ---- */
  const revenueBlock = section('Revenue', stack([
    ['Today', parts([money(rv.today?.now), chip(rv.today?.delta, { paren: true })])],
    ['This month', parts([money(rv.month?.now), chip(rv.month?.delta, { paren: true })])],
    ['All-time (invoiced)', money(ov.revenue_total)],
    ['Quizzes this week', parts([num(q.week?.now ?? 0), chip(q.week?.delta, { paren: true })])],
    ['Quizzes this month', parts([num(q.month?.now ?? 0), chip(q.month?.delta, { paren: true })])],
  ]));

  /* ---- last 7 days attendance (one row per day) ---- */
  const partBlock = section('Last 7 days — attendance', stack(
    (part || []).slice().reverse().map((d) => [
      fmtDay(d.date),
      parts([`${num(d.attended)}/${num(d.enrolled)} attended`, pctStr(d.attendance_pct),
        d.missed ? `${num(d.missed)} missed` : null]),
    ]), 'No activity yet'));

  /* ---- funnel (one row per stage) ---- */
  const funnelBlock = section('Conversion funnel (since launch)', stack(
    (funnel || []).map((s) => [
      s.label,
      parts([num(s.count), `${pctStr(s.pct_of_top)} of top`,
        s.drop_from_prev == null ? null : chip(s.drop_from_prev)]),
    ]), 'No funnel data yet'));

  /* ---- retention (one row per cohort; blank days not yet reached) ---- */
  const dcell = (val, need, age) => (Number(age) >= need ? pctStr(val) : '—');
  const retBlock = section('Retention by signup week', stack(
    (ret || []).map((r) => [
      `${fmtDay(r.cohort_start)} (${num(r.size)})`,
      parts([`D1 ${dcell(r.d1, 1, r.age_days)}`, `D3 ${dcell(r.d3, 3, r.age_days)}`,
        `D7 ${dcell(r.d7, 7, r.age_days)}`, `D14 ${dcell(r.d14, 14, r.age_days)}`]),
    ]), 'No cohorts yet'));

  /* ---- by board (one row per board) ---- */
  const boardBlock = section('By board', stack(
    (boards || []).filter((b) => b.students > 0).map((b) => [
      b.board_code,
      parts([`${num(b.students)} children`, `${num(b.paid)} paid`,
        `${num(b.attempted)} attempted today`, `${pctStr(b.attendance_pct)} att.`, `avg ${pctStr(b.avg_pct)}`]),
    ]), 'No enrolled students yet'));

  /* ---- action list ---- */
  const actionBlock =
    section('⚠️ Trials ending, not paid — nudge', stack(
      (brief.trials_ending || []).map((t) => [
        t.parent_name,
        parts([t.parent_mobile_number, t.days_left <= 0 ? 'ends today' : `${t.days_left}d left`]),
      ]), 'None ending in the next 2 days 🎉')) +
    section('Missed last night — a reminder may help', stack(
      (brief.missed || []).map((m) => [m.student_name, parts([m.parent_name, m.parent_mobile_number])]),
      'Everyone attended last night 🎉'));

  /* ---- celebrations ---- */
  const pay = celeb.latest_payment;
  const celebBlock =
    section('🎉 Good news', stack([
      pay ? ['Latest payment', `${money(pay.amount)} — ${esc(pay.parent_name)} · ${esc(pay.at_ist)}`] : null,
      ['Perfect scores last night', num((celeb.perfect || []).length)],
      ['Children on a 3+ day streak', num((celeb.streaks || []).length)],
    ])) +
    ((celeb.perfect || []).length ? section('Perfect last night', stack(
      celeb.perfect.map((r) => [r.student_name, parts([r.parent_name, `${num(r.score_total)} correct`])]))) : '') +
    ((celeb.streaks || []).length ? section('On a streak', stack(
      celeb.streaks.map((r) => [r.student_name, parts([r.parent_name, `${num(r.len)} days`])]))) : '');

  /* ---- operations / to-clear ---- */
  const opsBlock = section('To clear', stack([
    ['Open support tickets', num(ov.open_tickets)],
    ['Open website enquiries', num(bs.open_enquiries)],
    ['Testimonials awaiting approval', num(bs.testimonials_pending)],
    ['WhatsApp taps today', parts([num(bs.wa_today), chip(bs.wa_delta, { paren: true })])],
    ['Question bank size', num(ov.questions_total)],
  ]));

  const body =
    glance + cohortBlock + growthBlock + revenueBlock + partBlock +
    funnelBlock + retBlock + boardBlock + actionBlock + celebBlock + opsBlock +
    `<p style="margin:22px 0 0;font-size:12px;color:${C.muted};">Full drill-downs and per-child reports are in the admin panel.</p>`;

  const subject = `QuizPe · Daily report · ${istDate()} · ${num(p.completed ?? 0)} quizzes · ${money(rv.today?.now)}`;
  return {
    subject,
    html: shell({
      title: `Daily report — ${istDate()}`,
      lead: `${num(p.completed ?? 0)} of ${num(p.expected ?? 0)} quizzes done · avg ${pctStr(sc.avg_pct)} · ${money(rv.today?.now)} today`,
      body,
    }),
  };
}

module.exports = { buildDigest };
