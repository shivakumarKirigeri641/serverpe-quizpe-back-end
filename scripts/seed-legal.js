/**
 * scripts/seed-legal.js
 * ---------------------------------------------------------------------------
 * Seeds legal_documents + legal_sections with QuizPe's policies.
 *
 *   node scripts/seed-legal.js            # insert missing, leave edits alone
 *   node scripts/seed-legal.js --replace  # wipe and rewrite from this file
 *
 * ⚠️ NOT LEGAL ADVICE. This is a thorough, India-specific starting point
 * drafted from how QuizPe actually works. It must be reviewed by an advocate
 * before real customers, particularly:
 *   • children's data under the DPDP Act 2023 (verifiable parental consent)
 *   • the Grievance Officer appointment under IT Rules 2021
 *   • refund terms under the Consumer Protection (E-Commerce) Rules 2020
 *
 * Placeholders like {{company_name}} are substituted from business_details at
 * read time, so changing the business row updates every policy at once and the
 * text can never contradict the invoice.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const REPLACE = process.argv.includes('--replace');

const DOCS = [
  {
    doc_code: 'terms',
    title: 'Terms of Service',
    requires_consent: true,
    display_order: 10,
    summary: 'The agreement between you and {{company_name}} for using {{product_name}}.',
    sections: [
      ['1', 'Who we are',
        '{{product_name}} is operated by {{company_name}}, a sole proprietorship of {{proprietor_name}}, registered at {{address}}. GSTIN {{gstin}}. You can reach us at {{product_support_email}}.'],
      ['2', 'What the service is',
        '{{product_name}} delivers a daily set of multiple-choice practice questions to a parent\'s WhatsApp number for a school-going child, along with answer explanations and progress reports. It is a supplementary practice tool. It is not a school, not a tutoring service, and not a substitute for classroom teaching or a qualified teacher.'],
      ['3', 'Who may use it',
        'The account must be created and operated by a parent or legal guardian aged 18 or above. Children must not create accounts. By subscribing you confirm you are the parent or lawful guardian of every child you enrol and that you consent to their participation.'],
      ['4', 'Your account and mobile number',
        'Your WhatsApp mobile number identifies your account. You are responsible for keeping access to that number secure. Tell us at {{product_support_email}} if the number changes or is lost, so we can move or close the account. We may refuse to act on instructions we cannot reasonably verify came from you.'],
      ['5', 'Free trial',
        'Where a free trial is offered it is limited to one per mobile number, requires no payment details, and ends automatically. Nothing is charged during a trial and it does not convert into a paid plan by itself.'],
      ['6', 'Subscriptions and delivery',
        'Paid plans run for the duration shown at checkout and cover the number of children stated in the plan. Quizzes are delivered once per day at the scheduled time, which you can change. We may adjust the number of questions based on how your child is progressing.'],
      ['7', 'What we do not promise',
        'We do not promise any particular examination result, mark, rank or academic outcome. Practice questions are prepared to match a syllabus but may differ from what your child\'s school teaches on any given day.'],
      ['8', 'Availability',
        'We aim to deliver every day but cannot guarantee uninterrupted service. Delivery depends on WhatsApp, mobile networks and internet access that we do not control. Occasional maintenance may interrupt the service.'],
      ['9', 'Changes to these terms',
        'We may update these terms. The current version and its effective date are always available in the app and on request. Material changes will be notified on WhatsApp before they take effect. Continuing to use the service after that constitutes acceptance.'],
      ['10', 'Ending the agreement',
        'You may stop using the service at any time and may ask us to close your account. We may suspend or end an account that breaches these terms, misuses the service, or where we are required to by law.'],
      ['10a', 'We do not sell your data',
        'We do not sell, rent or trade your personal data or your child\'s data to anyone, and we never share it for advertising. The Privacy Policy names the short list of service providers who process data purely so that we can deliver {{product_name}} to you.'],
      ['11', 'Governing law',
        'These terms are governed by the laws of India. Courts at Bangalore, Karnataka have exclusive jurisdiction.'],
    ],
  },

  {
    doc_code: 'privacy',
    title: 'Privacy Policy',
    requires_consent: true,
    display_order: 20,
    summary: 'What personal data {{product_name}} collects, why, and what rights you have.',
    sections: [
      ['0', 'Our promise about your data',
        'We do not sell your personal data, or your child\'s, to anyone — at any price, ever. We do not give it to advertisers, advertising networks, data brokers, list builders or lead sellers. We do not let anyone else use it to market to you. We do not profile you or your child for advertising, and {{product_name}} carries no advertising at all. We share data only with the named service providers we genuinely need in order to deliver the service to you, and with the tax authorities where the law requires it. Nothing beyond that. If anyone else asks us for your personal data, the answer is no unless a valid legal order compels us — and where we are permitted to tell you, we will.'],
      ['1', 'Who is responsible for your data',
        '{{company_name}} ({{address}}) decides how and why your personal data is processed, and is the Data Fiduciary for the purposes of India\'s Digital Personal Data Protection Act, 2023. Contact {{product_support_email}}.'],
      ['2', 'What we collect about the parent',
        'Your name, WhatsApp mobile number, state of residence for GST purposes, the content of messages you exchange with us, your consent records, payment records received from our payment gateway, support requests, and feedback you submit.'],
      ['3', 'What we collect about the child',
        'The child\'s first name (or the name you choose to give), school name if you provide it, board, grade and medium of instruction, and their answers to practice questions along with the time taken. We do not collect a child\'s photograph, address, date of birth, contact details, location or biometric data, and you should not send these to us.'],
      ['4', 'Why we use it',
        'To deliver the daily quiz to the right child at the right level; to produce progress reports for you; to select tomorrow\'s questions based on what your child has already mastered; to send you reminders and service messages; to raise GST-compliant invoices; to answer your support requests; and to keep the service secure and working.'],
      ['5', 'Lawful basis',
        'We process personal data on the basis of the consent you give when you sign up, and where necessary to perform the contract between us, to comply with legal obligations such as tax and accounting law, and for our legitimate interest in keeping the service secure.'],
      ['6', 'Who we share it with, and nobody else',
        'Only the following, and only the minimum each one needs to do its job. '
        + 'Meta Platforms (WhatsApp Business Platform) receives your mobile number and the content of the messages we send you, because that is how the quiz is delivered. '
        + 'Razorpay Software Private Limited, our payment gateway, receives your name, mobile number, email if given, and the amount, in order to take payment and issue a receipt; Razorpay is PCI-DSS compliant and we never see or store your card number, CVV or UPI PIN. '
        + 'Our SMS provider receives your mobile number solely to deliver a one-time password. '
        + 'Our hosting and database provider stores the data on our behalf on servers in India. '
        + 'Our accountant and the GST authorities receive invoice-level details, which tax law requires us to file. '
        + 'Each of these is a processor acting on our instructions and may use the data only to provide that service to us. Nobody else receives your data. '
        + '{{product_name}} carries no advertising, so no advertiser, ad network or analytics broker receives anything about you or your child.'],
      ['7', 'Where it is stored',
        'Data is stored on servers located in India. Messages you send and receive also pass through WhatsApp\'s infrastructure, which may be outside India, under Meta\'s own terms.'],
      ['8', 'How long we keep it',
        'Account and quiz data is kept while your account is active and for a reasonable period afterwards so you can return or request records. Invoices, GST records and payment records are retained for at least eight years as required by Indian tax law and cannot be deleted on request. Message logs and operational records are archived and then removed on a rolling basis.'],
      ['9', 'Your rights',
        'You may ask us for a copy of the personal data we hold about you and your child, ask us to correct anything inaccurate, ask us to delete data that we are not legally required to keep, withdraw your consent, and nominate someone to exercise these rights if you are unable to. Write to {{product_support_email}} or to the Grievance Officer named in the Grievance Redressal policy.'],
      ['10', 'Withdrawing consent',
        'You can stop reminder messages at any time by replying STOP on WhatsApp. Withdrawing consent to the core processing means we can no longer deliver the service, and your subscription will end.'],
      ['11', 'Automated decisions',
        'We use an automated method to choose which questions your child sees next, based on how they answered previous questions. This affects the practice content only. It produces no legal or similarly significant effect, and no automated decision is made about you.'],
      ['12', 'Security',
        'We use encrypted connections, restricted database access, one-time passwords for report downloads, and unguessable links. No system is perfectly secure; we will tell you and the authorities about a personal data breach as required by law.'],
      ['13', 'Changes',
        'We will publish any change to this policy with a new version number and effective date, and notify you on WhatsApp where the change is material.'],
    ],
  },

  {
    doc_code: 'children_data',
    title: "Children's Data and Parental Consent",
    requires_consent: true,
    display_order: 30,
    summary: 'How {{product_name}} handles data about children, and what you are consenting to as a parent.',
    sections: [
      ['1', 'Why this policy exists',
        'The Digital Personal Data Protection Act, 2023 gives special protection to the personal data of anyone under 18. Because {{product_name}} exists to help school children practise, almost all of the learning data we hold relates to a child. This policy explains how we treat it.'],
      ['2', 'Consent is given by you, not the child',
        'Only a parent or legal guardian may create an account, enrol a child, and consent to our processing of that child\'s data. By completing signup you confirm that you are that parent or guardian. We record the date, time and WhatsApp message identifier of your consent as evidence.'],
      ['3', 'The child does not have an account',
        'Children do not have logins, profiles or credentials with us. The service is delivered entirely through your WhatsApp number, which you control. A child answers questions through a link you receive.'],
      ['4', 'Data minimisation',
        'We deliberately collect as little about a child as possible: a name, the board, grade and medium needed to pick the right questions, optionally the school name, and their answers. We do not ask for a photograph, address, date of birth, phone number, location or any biometric or health information.'],
      ['5', 'No advertising or tracking of children',
        'We do not use a child\'s data for advertising, do not target advertisements at children, do not sell or share it with data brokers, and do not track children across other websites or apps.'],
      ['6', 'Educational profiling only',
        'We analyse a child\'s answers to decide which questions to give them next and to produce your progress report. This is the core purpose of the service, it happens only inside {{product_name}}, and it is never used to make decisions about the child outside the service.'],
      ['7', 'Your control',
        'You can see everything we hold about your child in their reports, ask us to correct a name, board or grade, remove a child from your subscription, or ask us to delete their learning records. Write to {{product_support_email}}.'],
      ['8', 'If a child stops using the service',
        'When you remove a child or close your account, their learning records are deactivated and then removed on our normal archival cycle, except where a record forms part of an invoice or tax document we must retain.'],
    ],
  },

  {
    doc_code: 'communications',
    title: 'Consent for WhatsApp, SMS and Notifications',
    requires_consent: true,
    display_order: 40,
    summary: 'What messages we send, why, and how to stop them.',
    sections: [
      ['1', 'What you are agreeing to receive',
        'By giving us your mobile number and starting a trial or subscription, you agree that {{company_name}} may contact you on WhatsApp and by SMS in connection with the service.'],
      ['2', 'Messages we send',
        'A daily reminder before the quiz; the daily quiz itself with a link to answer; the score card and the PDF progress report; a request for feedback; one-time passwords for downloading reports or signing in; payment links, receipts and tax invoices; notices about your subscription such as renewal or expiry; and important service or policy notices.'],
      ['3', 'Frequency',
        'In normal use you receive at most one reminder and one quiz message per day per child, plus the report and any message you ask for. We do not send bulk promotional broadcasts.'],
      ['4', 'How to stop all messages',
        'Reply STOP on WhatsApp at any time and all quiz messaging stops immediately — reminders, the daily quiz link and any missed-quiz nudge. Reply START to turn everything back on. A pause does not cancel or extend a paid plan: the plan continues to run for the period you have paid for, and no quiz is delivered while it is paused. Messages we are required to send — invoices, security notices and account notices — will still reach you.'],
      ['5', 'Charges',
        'We do not charge you for messages. Your mobile operator or internet provider may charge for data.'],
      ['6', 'WhatsApp is a third party',
        'Messages are delivered through the WhatsApp Business Platform operated by Meta. Their terms and privacy policy apply to the transport of those messages, and delivery depends on their service being available.'],
      ['7', 'One-time passwords',
        'OTPs are sent to verify that it is really you before showing a report or granting access. Never share an OTP with anyone. We will never ask you for an OTP, a password, or your card details on a call or in a message.'],
    ],
  },

  {
    doc_code: 'refund',
    title: 'Cancellation and Refund Policy',
    requires_consent: false,
    display_order: 50,
    summary: 'Paid periods are not refundable. The free trial is there so you can decide before paying.',
    sections: [
      ['1', 'Try before you pay — that is the point of the trial',
        'Every new mobile number gets a free trial that costs nothing and needs no payment details. It ends '
        + 'by itself and never converts into a paid plan on its own. Please use it. It exists precisely so '
        + 'that you can see whether your child actually sits down and does the quiz, before any money changes '
        + 'hands.'],
      ['2', 'Paid periods are not refundable',
        'Once a subscription period is paid for, it is not refundable — in whole or in part — whether or not '
        + 'the quizzes are used. {{product_name}} is a daily service that is delivered from the moment you '
        + 'subscribe, and we prepare and send each day\'s quiz whether or not it is opened. This is stated '
        + 'here, and at checkout, before you pay.'],
      ['3', 'Cancelling',
        'You may stop at any time by writing to {{product_support_email}} or through Support in the app. '
        + 'Cancelling prevents any future charge. Your current plan continues to run to the end of the period '
        + 'you have already paid for — you keep what you bought.'],
      ['4', 'Where money IS returned',
        'A refund is not the same as returning money that was never owed. We will always return payment where '
        + 'you were charged twice for the same period; where a payment succeeded but the subscription was '
        + 'never activated; where a payment was taken in error; or where we were unable to deliver the service '
        + 'for a sustained period because of a fault on our side. These are corrections, not discretionary '
        + 'refunds, and nothing in this policy removes your rights under the Consumer Protection Act, 2019.'],
      ['5', 'How to raise it',
        'Write to {{product_support_email}} with your registered mobile number and the invoice number. We '
        + 'acknowledge within {{grievance_response_hours}} hours and decide within {{grievance_resolution_days}} '
        + 'days.'],
      ['6', 'How money is returned when it is due',
        'Where a correction is due, it is returned to the original payment method through our payment gateway. '
        + 'Banks typically take 5 to 10 working days. Any GST already paid to the government is adjusted '
        + 'through a credit note in accordance with tax rules.'],
      ['7', 'Changing your plan',
        'You may move to a plan covering more children at any time; the new plan starts a fresh period. '
        + 'Moving to a smaller plan takes effect at your next renewal rather than immediately, since the '
        + 'current period is already paid for.'],
    ],
  },

  {
    doc_code: 'pricing_gst',
    title: 'Pricing, Billing and GST',
    requires_consent: false,
    display_order: 60,
    summary: 'How you are charged and what your tax invoice contains.',
    sections: [
      ['1', 'Prices include GST',
        'All prices shown are in Indian Rupees and are inclusive of Goods and Services Tax at the applicable rate. The tax component is shown separately on your invoice.'],
      ['2', 'Who supplies the service',
        'The supplier is {{company_name}}, GSTIN {{gstin}}, at {{address}}. Our services are classified under SAC 998314.'],
      ['3', 'Place of supply',
        'GST is charged based on the state you give us at checkout. Within Karnataka, CGST and SGST apply. Outside Karnataka, IGST applies. Giving us the correct state is your responsibility and it cannot be changed after the invoice is issued.'],
      ['4', 'Your invoice',
        'A GST tax invoice is issued for every paid subscription and sent to you on WhatsApp. Each invoice carries a unique sequential number and can be produced again on request.'],
      ['5', 'Payments',
        'Payments are processed by our payment gateway. We never see or store your full card number, CVV, UPI PIN or net-banking credentials.'],
      ['6', 'Price changes',
        'We may change prices for future periods. A price change never affects a period you have already paid for, and we will tell you before a renewal at a new price.'],
      ['7', 'Adding a child during a running plan',
        'If you add another child while your plan is still running, you pay only for the days remaining until your current expiry. This amount is calculated on a pro-rata basis and is EXCLUSIVE of GST — GST at the applicable rate is added on top, and the total (amount + GST) is shown on the payment link and on your tax invoice. The added child\'s cover ends on the same date as your existing plan, and this mid-plan addition is offered only when more than 7 days remain on the plan.'],
      ['8', 'Renewals and carried-over days',
        'Renewing early never costs you a day. When you renew a paid plan that is still active, the days of the new plan are added on top of the days you already have — they are not reset from the renewal date. For example, if 5 days remain on your plan and you renew a 28-day plan, your cover runs for 33 days (5 + 28) and your daily quizzes continue without a break. Total active cover is capped at 84 days at any one time. Free-trial days are not carried into a paid plan — a paid plan begins its full duration when you first pay.'],
    ],
  },

  {
    doc_code: 'content_ip',
    title: 'Content, Originality and Intellectual Property',
    requires_consent: false,
    display_order: 70,
    summary: 'Where our questions come from, and what you may do with our content.',
    sections: [
      ['1', 'Our questions are written by us',
        'We study a chapter to understand what a child is expected to practise that month — place value, '
        + 'addition with regrouping, multiplication tables — and then compose entirely new questions on that '
        + 'concept ourselves. A syllabus topic is a fact, not protected expression: nobody owns the idea of '
        + 'teaching regrouping in Grade 2. What we publish is our own writing about that idea. We do not copy, '
        + 'scan, reproduce, paraphrase or redistribute questions, passages, illustrations, artwork or any '
        + 'other material from any textbook, workbook, guide or publisher, and no such material is stored in '
        + 'or served by {{product_name}}.'],
      ['2', 'No affiliation with boards or publishers',
        'References to a board such as CBSE, ICSE or a state board describe only which syllabus a set of questions is aligned to. {{product_name}} is not affiliated with, endorsed by, approved by or connected to any education board, school or textbook publisher. All trademarks belong to their respective owners.'],
      ['3', 'Our rights',
        'Questions, explanations, report designs, the {{product_name}} name and logo, and the software are owned by {{company_name}} and protected by copyright and trademark law.'],
      ['4', 'What you may do',
        'You may use the questions, explanations and reports for the personal, non-commercial learning of the children on your subscription. You may keep and print your own reports.'],
      ['5', 'What you may not do',
        'You may not copy, resell, republish, share in bulk, or use our questions to build a competing product or to teach commercially, and you may not scrape or extract our content by automated means.'],
      ['6', 'If you believe we have infringed',
        'If you believe any content on {{product_name}} infringes your rights, write to the Grievance Officer with details of the work, where it appears in our service, and proof of your rights. We investigate promptly and remove anything found to be infringing.'],
    ],
  },

  {
    doc_code: 'acceptable_use',
    title: 'Acceptable Use',
    requires_consent: false,
    display_order: 80,
    summary: 'How the service may and may not be used.',
    sections: [
      ['1', 'One household, your own children',
        'A subscription covers the children named on it, in one household. Sharing an account across families, a tuition centre or a classroom is not permitted and may result in suspension.'],
      ['2', 'Do not misuse the system',
        'Do not attempt to access another family\'s data, guess or share access links or OTPs, automate answering, overload the service, or interfere with its security.'],
      ['3', 'Send us only what is needed',
        'Do not send us photographs of children, identity documents, medical information or any sensitive personal data. We do not need it and do not want to hold it.'],
      ['4', 'Respectful contact',
        'Support requests and feedback should be free of abusive, threatening or unlawful content.'],
      ['5', 'Consequences',
        'We may warn, suspend or close an account that breaches this policy. Where a breach is also unlawful we may report it to the authorities.'],
    ],
  },

  {
    doc_code: 'liability',
    title: 'Disclaimer and Limitation of Liability',
    requires_consent: false,
    display_order: 90,
    summary: 'The limits of what we are responsible for.',
    sections: [
      ['1', 'Educational purpose only',
        '{{product_name}} provides supplementary practice. It does not replace school, a teacher or a syllabus, and no examination result or academic outcome is promised or guaranteed.'],
      ['2', 'Content accuracy',
        'We take care that questions and explanations are correct and check them before publishing. Errors can still occur. Tell us at {{product_support_email}} and we will correct or withdraw the question. We are not liable for a mark lost because of an error in a practice question.'],
      ['3', 'Delivery depends on others',
        'We are not responsible for failures caused by WhatsApp, mobile networks, internet outages, device problems, or events beyond our reasonable control.'],
      ['4', 'Adult supervision',
        'You are responsible for supervising your child\'s use of the device and internet connection through which the quiz is answered.'],
      ['5', 'Limit of our liability',
        'To the extent permitted by law, our total liability arising out of or in connection with the service is limited to the amount you actually paid us in the three months before the claim. We are not liable for indirect or consequential loss.'],
      ['6', 'Nothing excludes what cannot be excluded',
        'Nothing in these terms limits liability for fraud, or for anything that cannot be limited under Indian law, including your rights under the Consumer Protection Act, 2019.'],
    ],
  },

  {
    doc_code: 'grievance',
    title: 'Grievance Redressal',
    requires_consent: false,
    display_order: 100,
    summary: 'How to raise a complaint and who is responsible for resolving it.',
    sections: [
      ['1', 'Grievance Officer',
        'In accordance with the Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021 and the Consumer Protection (E-Commerce) Rules, 2020, the Grievance Officer for {{product_name}} is {{grievance_officer_name}}, {{grievance_officer_designation}}, {{company_name}}, {{address}}. Email {{grievance_officer_email}}.'],
      ['2', 'How to raise a complaint',
        'Write to {{grievance_officer_email}}, or use the Support option in the app which creates a ticket with a reference number. Please include your registered mobile number, what happened, and what you would like done.'],
      ['3', 'Our timelines',
        'We acknowledge every complaint within {{grievance_response_hours}} hours and aim to resolve it within {{grievance_resolution_days}} days. If a complaint needs longer we will tell you why and when to expect a resolution.'],
      ['4', 'Data protection complaints',
        'If your complaint concerns your personal data and you are not satisfied with our response, you may escalate it to the Data Protection Board of India under the Digital Personal Data Protection Act, 2023.'],
      ['5', 'Consumer complaints',
        'You may also approach the National Consumer Helpline or the consumer forum with jurisdiction over your location.'],
    ],
  },

  {
    doc_code: 'data_retention',
    title: 'Data Retention and Deletion',
    requires_consent: false,
    display_order: 110,
    summary: 'How long each kind of record is kept, and what we cannot delete.',
    sections: [
      ['1', 'Principle',
        'We keep personal data only as long as it serves the purpose it was collected for, or as long as the law requires — whichever is longer.'],
      ['2', 'Learning records',
        'Quiz answers, scores and progress records are kept while the subscription is active so that reports and adaptive learning work, then archived and removed on a rolling basis.'],
      ['3', 'Reports',
        'PDF reports remain available for you to download while your account is active.'],
      ['4', 'Messages and logs',
        'WhatsApp message history and operational logs are archived after about 90 days and removed thereafter, except where needed for an open dispute.'],
      ['5', 'Records we must keep',
        'Invoices, GST filings and payment records are retained for at least eight years under Indian tax law. These cannot be deleted at your request, and invoice numbers are never reused.'],
      ['6', 'Asking for deletion',
        'Write to {{product_support_email}}. We will delete what we are not required to keep, tell you plainly what we must retain and why, and confirm when it is done.'],
    ],
  },

  {
    doc_code: 'security',
    title: 'Information Security',
    requires_consent: false,
    display_order: 120,
    summary: 'The measures we take to protect your data.',
    sections: [
      ['1', 'In transit and at rest',
        'All connections use encrypted HTTPS. Database access is restricted to the application and to authorised administrators.'],
      ['2', 'Access to reports',
        'Progress reports are never publicly listed. They are reachable only through an unguessable link sent to your WhatsApp, or through a one-time password sent to your registered number.'],
      ['3', 'Payments',
        'Card and UPI details are handled entirely by our PCI-compliant payment gateway. We never receive or store them.'],
      ['4', 'Administrative access',
        'Access to the administration panel is restricted to authorised numbers, is protected by authentication, and administrative actions are logged.'],
      ['5', 'If something goes wrong',
        'If a personal data breach occurs we will investigate immediately, take steps to contain it, and notify affected users and the Data Protection Board of India as the law requires.'],
      ['6', 'Your part',
        'Keep access to your WhatsApp number secure, never share an OTP or a report link, and tell us at once at {{product_support_email}} if you think someone else has access to your account.'],
    ],
  },
];

(async () => {
  if (REPLACE) {
    await db.query('DELETE FROM legal_sections');
    await db.query('DELETE FROM legal_documents');
    console.log('cleared existing legal content');
  }

  let docs = 0, secs = 0;
  for (const d of DOCS) {
    const { rows } = await db.query(
      `INSERT INTO legal_documents (doc_code, title, version, summary, requires_consent, display_order)
       VALUES ($1,$2,'v1',$3,$4,$5)
       ON CONFLICT (doc_code) DO UPDATE
         SET title=EXCLUDED.title, summary=EXCLUDED.summary,
             requires_consent=EXCLUDED.requires_consent,
             display_order=EXCLUDED.display_order, modified_at=now()
       RETURNING id`,
      [d.doc_code, d.title, d.summary, d.requires_consent, d.display_order]);
    const id = rows[0].id;
    docs++;

    for (let i = 0; i < d.sections.length; i++) {
      const [no, title, description] = d.sections[i];
      await db.query(
        `INSERT INTO legal_sections (document_id, section_no, title, description, display_order)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (document_id, section_no) WHERE section_no IS NOT NULL DO UPDATE
           SET title=EXCLUDED.title, description=EXCLUDED.description,
               display_order=EXCLUDED.display_order, modified_at=now()`,
        [id, no, title, description, (i + 1) * 10]);
      secs++;
    }
  }

  console.log(`\n✅ ${docs} documents, ${secs} sections seeded.\n`);
  const { rows } = await db.query(
    `SELECT d.doc_code, d.title, d.requires_consent, COUNT(s.id)::int sections
       FROM legal_documents d LEFT JOIN legal_sections s ON s.document_id = d.id
      GROUP BY d.id ORDER BY d.display_order`);
  console.table(rows);
  console.log('⚠️  Have an advocate review these before taking real customers.\n');
  await db.close();
})();
