/**
 * src/whatsapp/messages.js
 * ---------------------------------------------------------------------------
 * All user-facing copy in one place, so wording can change without touching
 * flow logic. Everything is data-driven from the DB (plans, benefits, business
 * details), so price/tagline changes never need a code edit.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN',
  { day: '2-digit', month: 'short', year: 'numeric' });
const fmtTime = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
};

async function business() {
  const { rows } = await db.query(`SELECT * FROM business_details WHERE is_active LIMIT 1`);
  return rows[0];
}

async function welcome() {
  const b = await business();
  const terms = (await db.query(
    `SELECT * FROM policies WHERE policy_code='terms' AND is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  return {
    text:
`👋 Welcome to *${b.product_name}* — _${b.product_tagline}_

India's simplest daily learning habit for school kids, right here on WhatsApp. No app to download.

📚 A fresh *10-question quiz* every day
✅ Instant answers with kid-friendly explanations
📊 Weekly progress reports for parents

By continuing you agree to our *Terms of Service* and *Privacy Policy*.
${terms.url}

_${terms.summary}_`,
    footer: `${b.company_name}`,
    policyId: terms.id,
  };
}

async function trialTerms() {
  const plan = (await db.query(`SELECT * FROM quizpe_plans WHERE plan_code='TRY0'`)).rows[0];
  const pol = (await db.query(
    `SELECT * FROM policies WHERE policy_code='trial_conditions' AND is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  const benefits = (await db.query(
    `SELECT benefit_title, benefit_description FROM quizpe_benefits
      WHERE is_active ORDER BY sort_order LIMIT 5`)).rows;

  const b = await business();
  // Kept under the 1024-char interactive limit: headline benefits only, with
  // the full terms behind a link rather than pasted into the chat.
  return {
    text:
`🎁 *${plan.duration}-DAY FREE TRIAL*

*${b.product_name}* — _${b.product_tagline}_

✅ Daily 10-question quiz, ${plan.duration} days
✅ Answers & explanations after each quiz
✅ Daily summary & weekly progress PDFs
✅ 1 child · Mathematics · CBSE/ICSE/KSEAB

💯 *No payment details needed.* The trial ends automatically — nothing is ever charged.

📄 *Terms & disclaimer:*
${pol.url}

_By tapping *Agree & Proceed* you confirm you are the parent/guardian and accept the terms._`,
    footer: `${b.company_name} · GSTIN ${b.gstin}`,
    policyId: pol.id,
    plan,
  };
}

async function plansList() {
  const plans = (await db.query(
    `SELECT * FROM quizpe_plans WHERE is_active AND price > 0 ORDER BY price`)).rows;
  const offer = (await db.query(
    `SELECT * FROM quizpe_offers WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  return {
    text:
`💎 *QuizPe Premium Plans*
${offer ? `\n🔥 *${offer.title}* — limited time!\n` : ''}
${plans.map(p =>
`*${p.plan_name}* — ₹${Number(p.price)} _(was ₹${Number(p.comparable_price)})_
   ${p.student_count} child${p.student_count > 1 ? 'ren' : ''} · ${p.duration} days`).join('\n\n')}

_All plans include daily quizzes, explanations, spiral revision and PDF report cards._`,
    plans,
  };
}

async function subscriptionDetails(ctx, students) {
  const b = await business();
  if (!ctx.isSubscribed) {
    return `📄 *Your Subscription*

You don't have an active subscription right now.${ctx.trialUsed ? '' : '\n\nGood news — your *7-day free trial* is still available! 🎁'}

Type *menu* to see your options.`;
  }
  return `📄 *Your Subscription*

*Plan:* ${ctx.planName}${ctx.isTrial ? ' _(free trial)_' : ''}
*Valid till:* ${fmtDate(ctx.endDate)}
*Days remaining:* ${ctx.daysLeft}
*Quiz time:* ${fmtTime(ctx.quizTime)} daily

*Children enrolled* (${students.length}/${ctx.seatLimit}):
${students.map(s => `👦 *${s.student_name}* — ${s.board_code} · ${s.grade_name}`).join('\n')}

_${b.product_name} · ${b.product_tagline}_`;
}

function quizSchedule(ctx, students) {
  if (!ctx.isSubscribed) return `📅 No active subscription — no quizzes scheduled.\n\nType *menu* to get started.`;
  return `📅 *Upcoming Quiz Schedule*

⏰ *Every day at ${fmtTime(ctx.quizTime)}*
📆 Until *${fmtDate(ctx.endDate)}* (${ctx.daysLeft} days left)

${students.map(s => `👦 *${s.student_name}* — Mathematics · ${s.board_code} ${s.grade_name}`).join('\n')}

You'll get a message with a *Start Quiz* button each evening. 10 questions, about 5 minutes. 🚀`;
}

/**
 * Past reports with their PDF links, so a parent can re-download any earlier
 * day's report straight from the chat.
 */
async function quizReport(students) {
  if (!students.length) return `📊 No quiz history yet.`;
  const ids = students.map(s => s.id);

  const { rows } = await db.query(
    `SELECT st.student_name, r.quiz_date, sub.subject_name,
            r.score_correct, r.score_total, r.score_pct, r.grade, r.public_url
       FROM quiz_reports r
       JOIN students st      ON st.id = r.student_id
       LEFT JOIN quizpe_tracker t ON t.id = r.tracker_id
       LEFT JOIN subjects sub     ON sub.id = t.subject_id
      WHERE r.student_id = ANY($1::bigint[]) AND r.is_active
      ORDER BY r.quiz_date DESC, r.id DESC
      LIMIT 7`, [ids]);

  if (!rows.length) {
    return `📊 *Quiz Report*

No quizzes completed yet. Your first quiz arrives this evening — see you then! 🌱`;
  }

  // Show the scores in chat, but gate the actual PDFs behind an OTP portal so
  // reports can't be opened by anyone who happens to see a link.
  return `📊 *Recent Quiz Reports*

${rows.map(r => {
    const emoji = r.score_pct >= 80 ? '🌟' : r.score_pct >= 50 ? '👍' : '💪';
    return `${emoji} *${fmtDate(r.quiz_date)}* — ${r.subject_name || 'Quiz'}\n` +
           `   ${r.student_name}: *${r.score_correct}/${r.score_total}* (${r.score_pct}%) · Grade *${r.grade}*`;
  }).join('\n\n')}

📥 Tap below to download the full reports — you'll get a one-time code on WhatsApp to open them.`;
}

/** The OTP-gated report portal. */
function reportsPortalUrl() {
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  return `${base}/reports.html`;
}

async function support() {
  const b = await business();
  return `💬 *Support*

We're here to help!

📧 ${b.support_email}
🌐 ${b.product_website}

*${b.company_name}*
${b.address}
GSTIN: ${b.gstin}

_Reply with your question and we'll get back to you within 24 hours._`;
}

function trialActivated({ parentName, studentName, boardCode, gradeName, endDate, quizTime }) {
  return `🎉 *Your 7-day FREE trial is ACTIVE!*

👦 *Student:* ${studentName}
📚 *Board / Grade:* ${boardCode} · ${gradeName}
📖 *Subject:* Mathematics
📅 *Valid till:* ${fmtDate(endDate)}
⏰ *Quiz time:* ${fmtTime(quizTime)}, every single day

━━━━━━━━━━━━━━━━━━━━━━━━━━
*What happens now?*

Tonight at ${fmtTime(quizTime)}, ${studentName} gets 10 fun questions right here on WhatsApp — matched to the ${boardCode} ${gradeName} syllabus for this month. Every answer comes with a simple explanation, so learning happens even from mistakes. 💡

We quietly mix in questions from earlier chapters too, so what ${studentName} learnt in June is still sharp in December. 🔄

Just 5 minutes a day. That's how a learning habit is built. 🌱

_See you at ${fmtTime(quizTime)}!_ 🚀`;
}

module.exports = {
  welcome, trialTerms, plansList, subscriptionDetails,
  quizSchedule, quizReport, reportsPortalUrl, support, trialActivated, business, fmtDate, fmtTime,
};
