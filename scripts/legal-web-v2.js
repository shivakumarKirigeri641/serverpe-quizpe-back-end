#!/usr/bin/env node
/**
 * scripts/legal-web-v2.js — QuizPe's policies, rewritten for the web
 * (user, 2026-10-08: "update legal policies" — WhatsApp is retired; parents now
 * use quizpe.in/app, signed in by an SMS code, reminded by phone notification
 * and email).
 *
 *   node scripts/legal-web-v2.js          show what would change (changes nothing)
 *   node scripts/legal-web-v2.js --yes    apply
 *
 * Rewrites ONLY the sections below, matched by document code and section
 * number, and moves each changed document to version v2 effective today.
 * Everything else in the policies is left exactly as it is. Running it again
 * changes nothing (a section already holding the new text is skipped).
 *
 * These are edits to legal text: they should be read by an advocate, as the
 * header of seed-legal.js already says of the originals.
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const APPLY = process.argv.includes('--yes');

const DOC_TITLES = {
  communications: 'Consent for SMS, Notifications and Email',
};
const DOC_SUMMARIES = {};

// [doc_code, section_no, title, text]
const SECTIONS = [
  ['terms', '2', 'What the service is',
    '{{product_name}} provides a daily set of multiple-choice practice questions for a school-going child, taken in a web browser through the parent\'s {{product_name}} account at quizpe.in/app, along with answer explanations and progress reports. It is a supplementary practice tool. It is not a school, not a tutoring service, and not a substitute for classroom teaching or a qualified teacher.'],
  ['terms', '4', 'Your account and mobile number',
    'Your mobile number identifies your account. You sign in with it and a one-time code we send by SMS, after accepting these terms and the Privacy Policy. You are responsible for keeping access to that number, and to any device you stay signed in on, secure. Tell us at {{product_support_email}} if the number changes or is lost, so we can move or close the account. We may refuse to act on instructions we cannot reasonably verify came from you.'],
  ['terms', '8', 'Availability',
    'We aim to make a quiz available every day but cannot guarantee uninterrupted service. Access depends on mobile networks, SMS delivery, internet access and browsers that we do not control. Occasional maintenance may interrupt the service.'],
  ['terms', '9', 'Changes to these terms',
    'We may update these terms. The current version and its effective date are always available at quizpe.in and on request. Material changes will be shown in your {{product_name}} account, and sent to your registered email address, before they take effect. Continuing to use the service after that constitutes acceptance.'],

  ['privacy', '2', 'What we collect about the parent',
    'Your name, mobile number, email address (required, so that reminders, reports and notices reach you), state of residence for GST purposes, your consent records (including when you accepted these policies at each sign-in), sign-in records (date and time, IP address and browser or device type), phone notification subscriptions if you turn reminders on, payment records received from our payment gateway, support requests, and feedback you submit. If you used {{product_name}} on WhatsApp before 8 October 2026, the messages exchanged with us then are also held, as described under Data Retention.'],
  ['privacy', '6', 'Who we share it with, and nobody else',
    'Only the following, and only the minimum each one needs to do its job. Our SMS provider receives your mobile number solely to deliver the one-time sign-in code. Razorpay Software Private Limited, our payment gateway, receives your name, mobile number, email if given, and the amount, in order to take payment and issue a receipt; Razorpay is PCI-DSS compliant and we never see or store your card number, CVV or UPI PIN. If you turn on reminders, the push service of your browser (for example Google, Apple or Mozilla) carries the reminder text to your device; it does not receive your name or mobile number. Our email provider delivers the messages we send to your email address. Our hosting and database provider stores the data on our behalf on servers in India. Our accountant and the GST authorities receive invoice-level details, which tax law requires us to file. Each of these is a processor acting on our instructions and may use the data only to provide that service to us. Nobody else receives your data. {{product_name}} carries no advertising, so no advertiser, ad network or analytics broker receives anything about you or your child. Until 8 October 2026 the service was also delivered on WhatsApp, through Meta Platforms; nothing is sent to WhatsApp any longer.'],
  ['privacy', '7', 'Where it is stored',
    'Data is stored on servers located in India. A reminder passes through your browser\'s push service, which may be outside India, only on its way to your device.'],
  ['privacy', '10', 'Withdrawing consent',
    'You can turn phone reminders off at any time in your {{product_name}} account, change your email there, or sign out of any device. Withdrawing consent to the core processing means we can no longer provide the service, and your subscription will end.'],
  ['privacy', '13', 'Changes',
    'We will publish any change to this policy with a new version number and effective date, and show it in your {{product_name}} account, and send it to your registered email address, where the change is material.'],

  ['children_data', '2', 'Consent is given by you, not the child',
    'Only a parent or legal guardian may create an account, enrol a child, and consent to our processing of that child\'s data. By signing in and completing signup you confirm that you are that parent or guardian. We record the date and time of your consent, and of each sign-in at which you accept these policies, as evidence.'],
  ['children_data', '3', 'The child does not have an account',
    'Children do not have logins, profiles or credentials with us. The service runs entirely through your {{product_name}} account, which is tied to your mobile number and which you control. A child answers questions on a quiz page that you open from your account.'],

  ['communications', '1', 'What you are agreeing to receive',
    'By signing in with your mobile number and starting a trial or subscription, you agree that {{company_name}} may send you one-time sign-in codes by SMS and, if you turn them on, reminders as phone notifications, and messages to the email address you give us, which is required — all in connection with the service.'],
  ['communications', '2', 'Messages we send',
    'A one-time code by SMS each time you sign in; if you turn reminders on, a notification when the day\'s quiz is ready and a later reminder if it has not been taken; a notification when a report is ready; notices about your subscription such as renewal or expiry; and important service or policy notices. Quiz links, reports, receipts and tax invoices are in your {{product_name}} account.'],
  ['communications', '3', 'Frequency',
    'In normal use you receive at most one quiz-ready reminder a day, and up to two later reminders on a day the quiz has not been taken, plus a note when a report is ready. We do not send bulk promotional broadcasts.'],
  ['communications', '4', 'How to stop messages',
    'Turn reminders off at any time in your {{product_name}} account, or block notifications for quizpe.in in your browser settings. To stop reminder emails, write to {{product_support_email}}; notices about your account, plan and payments will still be emailed. A paid plan continues to run for the period you have paid for whether or not reminders are on. Sign-in codes are sent only when you ask for one.'],
  ['communications', '5', 'Charges',
    'We do not charge you for messages. Your mobile operator or internet provider may charge for data.'],
  ['communications', '6', 'Delivery depends on others',
    'Sign-in codes are delivered by SMS through a registered provider and mobile operators; reminders are delivered by your browser\'s push service. Delivery depends on those services being available. Until 8 October 2026 messages were delivered on WhatsApp; nothing is sent there any longer.'],

  ['pricing_gst', '4', 'Your invoice',
    'A GST tax invoice is issued for every paid subscription and is available to download in your {{product_name}} account. Each invoice carries a unique sequential number and can be produced again on request.'],

  ['liability', '3', 'Delivery depends on others',
    'We are not responsible for failures caused by SMS providers, mobile networks, browser push services, internet outages, device problems, or events beyond our reasonable control.'],

  ['data_retention', '4', 'Messages and logs',
    'Operational logs, sign-in records and the history of WhatsApp messages from before 8 October 2026 are archived after about 90 days and removed thereafter, except where needed for an open dispute or required by law.'],

  ['security', '2', 'Access to reports',
    'Progress reports are never publicly listed. They are reachable only from your {{product_name}} account, signed in with a one-time code sent to your registered number, or through the unguessable link shown there.'],
  ['security', '6', 'Your part',
    'Keep access to your mobile number and your signed-in devices secure, never share a sign-in code or a report link, sign out on shared devices, and tell us at once at {{product_support_email}} if you think someone else has access to your account.'],

  ['promote_terms', '1', 'What this is',
    '{{product_name}} provides a short daily revision quiz for school children, taken in the browser at quizpe.in. The purpose of this scheme is simply to tell parents that the platform exists, so that more children get into the habit of revising a little every day. That is its only purpose.\n\nYou tell parents about {{product_name}}. When a parent joins through your personal promotion link and pays for a plan, you earn a commission as a thank-you.\n\nPROMOTERS ARE NOT EMPLOYEES of {{product_name}} or {{company_name}}. You are not staff, not an agent and not a representative. This is a voluntary referral arrangement, not a job, and it carries no guarantee of income.'],
  ['promote_terms', '3', 'Joining and your link',
    'You join through the registration form we share with you, give your name and UPI ID, and accept these terms. You will then receive your personal promotion link.\n\nYour link is personal. Do not sell, share or transfer it to anyone else to use as their own.\n\nA purchase earns commission only when the customer arrives through your link. We cannot credit a purchase made without it, however it came about. Please share the link rather than telling people a code.\n\nMESSAGES FROM US. By joining, you agree to receive messages about your own account — by SMS or at the email address you give — including your link when you register, every payment we make to you, and any change to these terms or to the scheme. These are how we tell you what you are owed, so they continue for as long as you are in the scheme.\n\nIf you tick the box on the registration form, we will also tell you each time a parent joins through your link, and send you occasional news about {{product_name}} that you may wish to pass on to parents. You can ask us to stop those at any time at {{product_support_email}} — messages about payments made to you will still reach you.'],
  ['promote_terms', '9', 'How you may promote {{product_name}}',
    'Speak about {{product_name}} honestly and accurately. Do not promise marks, ranks, results or admissions.\n\nDo not describe yourself as an employee, agent, partner or representative of {{product_name}} or {{company_name}}.\n\nDo not send unsolicited messages in bulk on any channel, and do not add people to groups without their consent. Respect the terms of every platform you use — a breach can get your account restricted.\n\nDo not collect money from anyone. All payments are made directly to {{product_name}}.\n\nDo not pass any part of your commission back to a customer as a discount, cashback or gift.\n\nDo not run paid advertisements, create social media accounts or pages, or register domains using the {{product_name}} or {{company_name}} name or logo.\n\nDo not involve children in promoting {{product_name}}, and do not approach children directly.\n\nDo not make claims about other education providers.'],
  ['promote_terms', '13', 'The scheme itself',
    'THIS SCHEME ENDS ON 28 DECEMBER 2026. Purchases made on or before that date earn commission. The final payment is 28 January 2027. Links shared after 28 December 2026 do not earn commission.\n\nWe may change, pause or withdraw the scheme before that date. Commission already earned will be paid.\n\nWe may change these terms. Material changes will be sent to your registered mobile number or email, and continuing to promote {{product_name}} after that means you accept them.'],
  ['promote_terms', '14', 'General',
    'Our total liability to you under this scheme is limited to the commission properly due and unpaid.\n\nWe keep your name, mobile number, UPI ID and, where required, your PAN, solely to operate this scheme and to meet our legal obligations.\n\nMessages sent to your registered mobile number or email address are valid notice under these terms.\n\nIf any clause is found unenforceable, the rest continue to apply.\n\nThese terms are governed by Indian law, and the courts at Bengaluru, Karnataka have exclusive jurisdiction.\n\nQuestions: {{product_support_email}}'],
];

(async () => {
  const docs = (await db.query(`SELECT id, doc_code, title, version FROM legal_documents`)).rows;
  const byCode = Object.fromEntries(docs.map((d) => [d.doc_code, d]));
  const changedDocs = new Set();
  const plan = [];
  for (const [code, no, title, text] of SECTIONS) {
    const d = byCode[code];
    if (!d) { console.log(`  skip    ${code} §${no} — no such document here`); continue; }
    const s = (await db.query(`SELECT id, title, description FROM legal_sections WHERE document_id = $1 AND section_no = $2`, [d.id, no])).rows[0];
    if (!s) { console.log(`  skip    ${code} §${no} — no such section here`); continue; }
    if (s.description === text && s.title === title) { console.log(`  same    ${code} §${no}`); continue; }
    plan.push({ id: s.id, code, no, title, text });
    changedDocs.add(code);
    console.log(`  change  ${code} §${no} ${title}`);
  }
  for (const [code, title] of Object.entries(DOC_TITLES)) {
    if (byCode[code] && byCode[code].title !== title) { changedDocs.add(code); console.log(`  title   ${code}: "${byCode[code].title}" -> "${title}"`); }
  }
  // The free-trial consent summary (policies table, shown on the trial form).
  const TRIAL_SUMMARY = "Terms of Service, Privacy Policy, Children's Data & Parental Consent, and consent for SMS sign-in codes, reminders and email.";
  const trialRows = (await db.query(
    `SELECT id FROM policies WHERE policy_code = 'trial_conditions' AND summary ILIKE '%whatsapp%'`)).rows;
  if (trialRows.length) console.log(`  summary trial_conditions (${trialRows.length} row(s))`);

  if (!changedDocs.size && !trialRows.length) { console.log('\nNothing to change — the policies are already up to date.'); process.exit(0); }
  if (!APPLY) { console.log(`\n${plan.length} section(s) in ${changedDocs.size} document(s) would change. Run again with --yes to apply.`); process.exit(0); }

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    for (const p of plan) {
      await c.query(`UPDATE legal_sections SET title = $2, description = $3, modified_at = now() WHERE id = $1`, [p.id, p.title, p.text]);
    }
    for (const code of changedDocs) {
      await c.query(
        `UPDATE legal_documents
            SET version = 'v2', effective_from = CURRENT_DATE, modified_at = now(),
                title = COALESCE($2, title), summary = COALESCE($3, summary)
          WHERE doc_code = $1`, [code, DOC_TITLES[code] || null, DOC_SUMMARIES[code] || null]);
    }
    if (trialRows.length) {
      await c.query(`UPDATE policies SET summary = $2, modified_at = now() WHERE id = ANY($1::bigint[])`,
        [trialRows.map((r) => r.id), TRIAL_SUMMARY]);
    }
    await c.query('COMMIT');
    console.log(`\nApplied: ${plan.length} section(s); ${changedDocs.size} document(s) now v2, effective today.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
