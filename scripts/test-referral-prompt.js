/**
 * Exercises the invite prompt against the LOCAL database with the WhatsApp
 * client stubbed out — nothing is ever sent to Meta. Cleans up after itself.
 */
require('dotenv').config();
const path = require('path');

// Stub the WhatsApp client BEFORE prompt.js can require it.
const sent = [];
const waPath = require.resolve('../src/whatsapp/client');
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    sendButtons: async (sessionId, mobile, body, buttons) => {
      sent.push({ mobile, body, buttons });
      return { ok: true };
    },
  },
};

const db = require('../src/database/connectDB');

/* The feature is opt-in, so the first thing to prove is that it does NOTHING
   when the flag is unset — deploying the code must not start messaging real
   parents on its own. Then the flag goes on for the rest of the run. */
delete process.env.REFERRAL_PROMPT;
const promptOff = require('../src/referrals/prompt');

process.env.REFERRAL_PROMPT = '1';
delete require.cache[require.resolve('../src/referrals/prompt')];
const prompt = require('../src/referrals/prompt');

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

(async () => {
  console.log('\nReferral invite prompt\n');

  // A real student who has a parent — read-only, we only borrow the ids.
  const { rows: [who] } = await db.query(
    `SELECT st.id AS student_id, st.student_name, pa.id AS parent_id, pa.parent_mobile_number AS mobile
       FROM students st JOIN parents pa ON pa.id = st.parent_id
      ORDER BY st.id LIMIT 1`);
  if (!who) { console.log('  no student in the local copy — nothing to test against\n'); process.exit(0); }

  await db.query(`DELETE FROM notification_log WHERE parent_id = $1 AND kind = $2`,
    [who.parent_id, prompt.KIND]);

  try {
    // 0. switched off by default — nothing may go out at all
    sent.length = 0;
    const offAsked = await promptOff.maybeAsk({
      sessionId: null, mobile: who.mobile, studentId: who.student_id,
      childName: who.student_name, pct: 100 });
    check(offAsked === false && sent.length === 0,
      'silent unless REFERRAL_PROMPT=1 — a deploy alone messages nobody');
    check((await promptOff.inviteLine(who.parent_id)) === '',
      'and the weekly-report line is empty too');

    // 1. a weak score is never an invitation to recommend us
    sent.length = 0;
    let asked = await prompt.maybeAsk({
      sessionId: null, mobile: who.mobile, studentId: who.student_id,
      childName: who.student_name, pct: 40 });
    check(asked === false && sent.length === 0, 'a poor score does not trigger an ask');

    // 2. a good score does — unless this family already refers people
    sent.length = 0;
    asked = await prompt.maybeAsk({
      sessionId: null, mobile: who.mobile, studentId: who.student_id,
      childName: who.student_name, pct: 90 });

    const { rows: [s] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='rewarded')::int rewarded,
              COUNT(*) FILTER (WHERE status='pending')::int  joined
         FROM referrals WHERE referrer_parent_id = $1`, [who.parent_id]).catch(() => ({ rows: [{}] }));
    const alreadyRefers = (s?.joined || 0) > 0 || (s?.rewarded || 0) > 0;

    if (alreadyRefers) {
      check(asked === false, 'a parent who already refers is left alone');
      console.log('  (this family already refers — skipping the send checks)\n');
    } else {
      check(asked === true && sent.length === 1, 'a good score asks once');
      console.log(['', '--- the message ---', sent[0]?.body || '',
        `[button] ${sent[0]?.buttons?.[0]?.title || ''}`, ''].join('\n'));
      check(/free days/.test(sent[0]?.body || ''), `the ask names the reward`);
      check(sent[0]?.buttons?.[0]?.id === 'refer_friend',
        'and the button is the menu row, so the existing flow answers it');

      // 3. the cooldown holds
      sent.length = 0;
      asked = await prompt.maybeAsk({
        sessionId: null, mobile: who.mobile, studentId: who.student_id,
        childName: who.student_name, pct: 100 });
      check(asked === false && sent.length === 0,
        'a second good score inside the cooldown stays quiet');

      // 4. a sibling must not produce a second ask at the same parent
      const { rows: [sib] } = await db.query(
        `SELECT id, student_name FROM students WHERE parent_id = $1 AND id <> $2 LIMIT 1`,
        [who.parent_id, who.student_id]);
      if (sib) {
        sent.length = 0;
        asked = await prompt.maybeAsk({
          sessionId: null, mobile: who.mobile, studentId: sib.id,
          childName: sib.student_name, pct: 95 });
        check(asked === false, 'a sibling does not earn the same parent a second ask');
      }
    }

    // 5. the weekly-report line
    const line = await prompt.inviteLine(who.parent_id);
    check(line === '' || /wa\.me|JOIN/.test(line),
      `the report line carries a joinable link${line ? '' : ' (empty — no business number set locally)'}`);
  } finally {
    await db.query(`DELETE FROM notification_log WHERE parent_id = $1 AND kind = $2`,
      [who.parent_id, prompt.KIND]);
    console.log('\n  cleaned up.');
  }

  console.log(fails ? `\n  ${fails} FAILURE(S)\n` : '\n  all checks passed\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('\n  ERROR', e.message, '\n'); process.exit(1); });
