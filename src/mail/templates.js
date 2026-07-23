/**
 * src/mail/templates.js
 * ---------------------------------------------------------------------------
 * Operator alert emails. Four events, one house style.
 *
 * These go to the founder's inbox, so they are built to be *scanned on a
 * phone*: the headline fact first, then the detail as a plain label/value
 * table. No marketing language, no images, no tracking — just what happened,
 * who it was, and enough context to act without opening the admin panel.
 *
 * Every value is HTML-escaped: a parent's name or feedback comment is
 * untrusted input, and it must never be able to inject markup into the mail.
 * ---------------------------------------------------------------------------
 */

const esc = (s) => String(s == null || s === '' ? '—' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const C = { brand: '#075e54', accent: '#00a884', ink: '#111b21', muted: '#667781', line: '#e2e6e9', soft: '#f6f8f9' };

const ist = (d = new Date()) =>
  new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** label/value rows; falsy values render as an em dash rather than vanishing. */
const rows = (pairs) => pairs.filter(Boolean).map(([k, v]) => `
  <tr>
    <td style="padding:7px 12px;background:${C.soft};border:1px solid ${C.line};font-size:13px;color:${C.muted};white-space:nowrap;vertical-align:top;">${esc(k)}</td>
    <td style="padding:7px 12px;border:1px solid ${C.line};font-size:13px;color:${C.ink};">${esc(v)}</td>
  </tr>`).join('');

const table = (pairs) =>
  `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-top:6px;">${rows(pairs)}</table>`;

const section = (title, pairs) =>
  `<h3 style="margin:22px 0 0;font-size:14px;color:${C.brand};text-transform:uppercase;letter-spacing:.4px;">${esc(title)}</h3>${table(pairs)}`;

/**
 * Everything we can honestly say about where an action came from.
 *
 * Only facts actually present on the request are shown — nothing is guessed or
 * enriched from a third-party lookup. A field we do not have is simply absent,
 * which is more useful than a confident-looking blank.
 */
function deviceRows(ctx = {}) {
  const ua = ctx.userAgent || '';

  const os = !ua ? null
    : /Android[ /]?([\d.]+)?/i.test(ua) ? `Android ${(ua.match(/Android[ /]?([\d.]+)/i) || [])[1] || ''}`.trim()
    : /iPhone OS ([\d_]+)/i.test(ua) ? `iOS ${((ua.match(/iPhone OS ([\d_]+)/i) || [])[1] || '').replace(/_/g, '.')}`
    : /iPad|iPhone/i.test(ua) ? 'iOS'
    : /Windows NT ([\d.]+)/i.test(ua) ? `Windows ${({ '10.0': '10/11', '6.3': '8.1', '6.1': '7' })[(ua.match(/Windows NT ([\d.]+)/i) || [])[1]] || ''}`.trim()
    : /Mac OS X ([\d_]+)/i.test(ua) ? `macOS ${((ua.match(/Mac OS X ([\d_]+)/i) || [])[1] || '').replace(/_/g, '.')}`
    : /Linux/i.test(ua) ? 'Linux' : 'Unknown OS';

  const browser = !ua ? null
    : /WhatsApp/i.test(ua) ? 'WhatsApp in-app browser'
    : /Edg\/([\d.]+)/i.test(ua) ? `Edge ${(ua.match(/Edg\/([\d.]+)/i) || [])[1]}`
    : /OPR\/([\d.]+)/i.test(ua) ? `Opera ${(ua.match(/OPR\/([\d.]+)/i) || [])[1]}`
    : /Chrome\/([\d.]+)/i.test(ua) ? `Chrome ${(ua.match(/Chrome\/([\d.]+)/i) || [])[1]}`
    : /Firefox\/([\d.]+)/i.test(ua) ? `Firefox ${(ua.match(/Firefox\/([\d.]+)/i) || [])[1]}`
    : /Version\/([\d.]+).*Safari/i.test(ua) ? `Safari ${(ua.match(/Version\/([\d.]+)/i) || [])[1]}`
    : 'Unknown browser';

  const kind = !ua ? null
    : /iPad|Tablet/i.test(ua) ? '📱 Tablet'
    : /Mobi|Android|iPhone/i.test(ua) ? '📱 Mobile'
    : '💻 Desktop';

  const when = ctx.at ? new Date(ctx.at) : new Date();
  const hour = Number(when.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
  const partOfDay = hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon'
    : hour < 21 ? 'evening' : 'night';

  return [
    ['Channel', ctx.channel],
    ['When (IST)', `${ist(when)}  ·  ${partOfDay}`],
    ['Day', when.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' })],
    kind ? ['Device type', kind] : null,
    os ? ['Operating system', os] : null,
    browser ? ['Browser', browser] : null,
    ctx.language ? ['Browser language', ctx.language] : null,
    ctx.ip ? ['IP address', ctx.ip] : null,
    ctx.referer ? ['Came from', ctx.referer] : null,
    ctx.pageUrl ? ['Page', ctx.pageUrl] : null,
    ctx.sessionId ? ['WhatsApp session', `#${ctx.sessionId}`] : null,
    ctx.deviceId ? ['Device fingerprint', String(ctx.deviceId).slice(0, 12) + '…'] : null,
    ua ? ['Full user agent', ua.slice(0, 200)] : null,
  ];
}

function shell({ badge, badgeColor, title, lead, body }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef2f1;">
  <div style="max-width:640px;margin:0 auto;padding:18px 14px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid ${C.line};">
      <div style="background:${C.brand};padding:18px 20px;">
        <span style="display:inline-block;background:${badgeColor || C.accent};color:#fff;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 10px;border-radius:20px;">${esc(badge)}</span>
        <h1 style="margin:10px 0 0;color:#fff;font-size:19px;line-height:1.3;">${esc(title)}</h1>
        ${lead ? `<p style="margin:6px 0 0;color:#cfe9e2;font-size:13px;">${esc(lead)}</p>` : ''}
      </div>
      <div style="padding:4px 20px 22px;">${body}</div>
      <div style="padding:14px 20px;border-top:1px solid ${C.line};background:${C.soft};color:${C.muted};font-size:11px;">
        Automated notification from QuizPe · ServerPe App Solutions.<br>
        Sent to the operator inbox only — contains customer data, please do not forward.
      </div>
    </div>
  </div></body></html>`;
}

const childRows = (children = []) => children.length
  ? children.map((c, i) => [`Child ${i + 1}`,
      [c.name, c.board, c.grade, c.medium, c.school ? `School: ${c.school}` : null]
        .filter(Boolean).join(' · ')])
  : [['Children', 'none recorded']];

/* --------------------------------------------------------- 1. free trial */
function trialStarted({ parent, children, plan, ctx }) {
  return {
    // Subject must be readable at a glance in a notification: what plan, who,
    // how many children — in that order.
    subject: `QuizPe - Trial plan · ${parent?.name || parent?.mobile || 'New parent'} · ${children?.length || 0} child${(children?.length || 0) === 1 ? '' : 'ren'}`,
    html: shell({
      badge: 'Free trial', badgeColor: '#00a884',
      title: `${parent?.name || 'A parent'} started the free trial`,
      lead: `${children?.length || 0} child enrolled · ${plan?.name || 'Trial'}`,
      body:
        section('Parent', [
          ['Name', parent?.name], ['Mobile', parent?.mobile], ['State', parent?.state],
        ]) +
        section('Children', childRows(children)) +
        section('Plan', [
          ['Plan', plan?.name], ['Duration', plan?.duration ? `${plan.duration} days` : null],
          ['Starts', plan?.start], ['Ends', plan?.end],
          ['Quiz time', plan?.quizTime], ['Reminder', plan?.reminderTime],
        ]) +
        section('Where it came from', deviceRows(ctx)),
    }),
  };
}

/* -------------------------------------------------------- 2. paid enrol */
function paymentReceived({ parent, children, plan, payment, invoice, ctx }) {
  return {
    subject: `QuizPe - ${payment?.amount != null ? Math.round(Number(payment.amount)) + '/-' : 'Paid'} plan · ${parent?.name || parent?.mobile || 'New parent'} · ${children?.length || 0} child${(children?.length || 0) === 1 ? '' : 'ren'}`,
    html: shell({
      badge: 'Paid enrolment', badgeColor: '#2e7d32',
      title: `₹${payment?.amount ?? '—'} received from ${parent?.name || 'a parent'}`,
      lead: `${plan?.name || 'Paid plan'} · ${children?.length || 0} child(ren) · invoice ${invoice?.number || '—'}`,
      body:
        section('Parent', [
          ['Name', parent?.name], ['Mobile', parent?.mobile], ['State', parent?.state],
        ]) +
        section('Children', childRows(children)) +
        section('Plan', [
          ['Plan', plan?.name], ['Duration', plan?.duration ? `${plan.duration} days` : null],
          ['Starts', plan?.start], ['Ends', plan?.end],
          ['Quiz time', plan?.quizTime], ['Reminder', plan?.reminderTime],
        ]) +
        section('Payment', [
          ['Amount', payment?.amount != null ? `₹${payment.amount}` : null],
          ['Mode', payment?.method], ['Status', payment?.status],
          ['Payment ID', payment?.paymentId], ['Order ID', payment?.orderId],
          ['Razorpay mode', payment?.mode],
        ]) +
        section('Invoice & GST', [
          ['Invoice no.', invoice?.number], ['Taxable', invoice?.base != null ? `₹${invoice.base}` : null],
          ['CGST', invoice?.cgst != null ? `₹${invoice.cgst}` : null],
          ['SGST', invoice?.sgst != null ? `₹${invoice.sgst}` : null],
          ['IGST', invoice?.igst != null ? `₹${invoice.igst}` : null],
          ['Total', invoice?.total != null ? `₹${invoice.total}` : null],
        ]) +
        section('Where it came from', deviceRows(ctx)),
    }),
  };
}

/* --------------------------------------------------------- 3. feedback */
function feedbackReceived({ parent, student, rating, tags, comment, quiz, ctx }) {
  const stars = rating ? '★'.repeat(Math.max(0, Math.min(5, rating))) + '☆'.repeat(5 - Math.max(0, Math.min(5, rating))) : '—';
  const low = rating && rating <= 2;
  return {
    subject: `QuizPe - Feedback ${rating ? rating + '/5' : ''}${low ? ' ⚠️ LOW' : ''} · ${parent?.name || parent?.mobile || 'parent'}`,
    html: shell({
      badge: low ? 'Low rating — look' : 'Feedback', badgeColor: low ? '#c62828' : '#0277bd',
      title: `${stars}  ${rating ? `${rating} out of 5` : 'Feedback received'}`,
      lead: `${student?.name ? `About ${student.name}'s quiz` : ''}`,
      body:
        (comment ? `<div style="margin-top:16px;padding:12px 14px;background:${C.soft};border-left:4px solid ${C.accent};border-radius:6px;font-size:14px;color:${C.ink};white-space:pre-wrap;">${esc(comment)}</div>` : '') +
        section('Rating', [
          ['Stars', rating ? `${rating} / 5` : null],
          ['Tags', Array.isArray(tags) && tags.length ? tags.join(', ') : null],
        ]) +
        section('Parent & child', [
          ['Parent', parent?.name], ['Mobile', parent?.mobile],
          ['Child', student?.name], ['Board / grade', [student?.board, student?.grade].filter(Boolean).join(' · ')],
        ]) +
        (quiz ? section('The quiz it refers to', [
          ['Date', quiz.date], ['Score', quiz.score], ['Subject', quiz.subject],
        ]) : '') +
        section('Where it came from', deviceRows(ctx)),
    }),
  };
}

/* ------------------------------------------------- 4. support / enquiry */
function supportRaised({ ticket, parent, subjectLine, message, category, ctx }) {
  return {
    subject: `QuizPe - Support${ticket ? ' #' + ticket : ''} · ${category || 'request'} · ${parent?.name || parent?.mobile || 'a parent'}`,
    html: shell({
      badge: 'Support request', badgeColor: '#ef6c00',
      title: subjectLine || `New support request${ticket ? ` — ticket ${ticket}` : ''}`,
      lead: category ? `Category: ${category}` : '',
      body:
        (message ? `<div style="margin-top:16px;padding:12px 14px;background:${C.soft};border-left:4px solid #ef6c00;border-radius:6px;font-size:14px;color:${C.ink};white-space:pre-wrap;">${esc(message)}</div>` : '') +
        section('Who', [
          ['Name', parent?.name], ['Mobile', parent?.mobile], ['Email', parent?.email],
          ['Existing customer', parent?.isCustomer == null ? null : (parent.isCustomer ? 'Yes' : 'No')],
        ]) +
        section('Request', [
          ['Ticket', ticket], ['Category', category],
          ['Reply within', 'as per support hours 9 AM – 6 PM, 24–48 hours'],
        ]) +
        section('Where it came from', deviceRows(ctx)),
    }),
  };
}

module.exports = { trialStarted, paymentReceived, feedbackReceived, supportRaised, ist };
