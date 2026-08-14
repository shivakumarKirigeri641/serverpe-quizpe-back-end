/**
 * Stores the real approved HEADER + BODY + FOOTER text of each marketing
 * template in whatsapp_templates, so the admin Broadcast page can show the
 * COMPLETE template preview (with {{1}} = the parent's first name). Buttons are
 * already stored. Run once after the templates are approved; idempotent.
 * Parameterised, so apostrophes / emoji / newlines need no escaping.
 */
require('dotenv').config();
const db = require('../src/database/connectDB');

// header, body, footer exactly as submitted to (and approved by) Meta.
const T = {
  qp_promo_trial_v2: {
    header: 'Does your child forget what they studied? 📚',
    body:
`Hi {{1}}! 👋 A topic learnt on Monday is often half-forgotten by Friday — unless it's revised.

QuizPe sends your child *one 5-minute Maths quiz every evening* on WhatsApp, matched to their class and board (CBSE, ICSE or State). It gently revisits what they've already learnt so it actually sticks — and you get a simple progress report.

Start with a *free 7-day trial*. No payment, nothing to install.`,
    footer: 'QuizPe · 5 minutes a day',
  },
  qp_winback_v1: {
    header: 'Your child\'s daily practice has paused ⏸️',
    body:
`Hi {{1}}, your child's daily QuizPe revision has stopped since your plan ended. 😔

Every day away, a little more of what they mastered slips. Restart now and the evening 5-minute Maths quiz — matched to their class and board — picks up right where they left off, with their progress intact.

Plans start at just ₹99.`,
    footer: 'QuizPe · Pick up where you left off',
  },
  qp_referral_v1: {
    header: 'Share QuizPe, earn free days 🎁',
    body:
`Hi {{1}}! Know a parent whose child could use a few minutes of Maths revision each day?

Invite them to QuizPe. They start with the same regular *7-day free trial*, and for every friend who joins, *you get 7 bonus days* added to your next renewal — refer more, stack more.

Tap below for your personal invite link.`,
    footer: 'QuizPe · Learning is better together',
  },
  qp_offer_v1: {
    header: 'Launch offer — daily Maths from ₹99 🎉',
    body:
`Hi {{1}}! For our launch, QuizPe's daily 5-minute Maths revision is available at a special introductory price — from just *₹99*.

One quiz every evening on WhatsApp, matched to your child's class and board (CBSE, ICSE, State), with progress reports for you. Seats at this price are limited.

See the plans and start today 👇`,
    footer: 'QuizPe · Introductory pricing',
  },
};

(async () => {
  await db.query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS header_text text`);
  await db.query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS footer_text text`);
  let n = 0;
  for (const [name, t] of Object.entries(T)) {
    const r = await db.query(
      `UPDATE whatsapp_templates SET header_text=$2, body_text=$3, footer_text=$4 WHERE template_name=$1`,
      [name, t.header.trim(), t.body.trim(), t.footer.trim()]);
    console.log(`  ${name}: ${r.rowCount ? 'updated' : 'NOT FOUND'}`);
    n += r.rowCount;
  }
  console.log(`Done — ${n} template(s) set (header + body + footer).`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
