/**
 * src/whatsapp/demo.js
 * ---------------------------------------------------------------------------
 * On-the-spot DEMO mode for ONE number (DEMO_MOBILE), used to pitch schools.
 *
 * This number is intercepted BEFORE the normal parent flow, so it never behaves
 * like a regular parent (no evening window, no reminders, no enrolment). Instead
 * it can, at ANY time:
 *
 *   1. pick a Board, Grade and Medium on the spot,
 *   2. take a short 5-question quiz right in the chat, and
 *   3. get the SAME PDF report a real parent receives.
 *
 * Nothing is kept: the demo reuses the real quiz+report engine through
 * short-lived rows (a throwaway student, tracker and answers) and PURGES every
 * one of them the moment the report has been sent. The only durable row is a
 * single hidden demo parent shell to hang the throwaway student on.
 *
 * Turn the whole thing off by unsetting DEMO_MOBILE.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const db = require('../database/connectDB');
const wa = require('./client');
const Q = require('./quiz');
const { normaliseMobile } = require('./userContext');

// No demo number by default — demo mode is OFF unless DEMO_MOBILE is explicitly
// set. (Previously defaulted to the founder's personal number; now that number
// is a regular parent.)
const DEMO_MOBILE = process.env.DEMO_MOBILE ? normaliseMobile(process.env.DEMO_MOBILE) : '';
const SUBJECT_CODE = process.env.DEMO_SUBJECT_CODE || 'MATHS';
const N_QUESTIONS = 5;
const LETTERS = ['A', 'B', 'C', 'D'];

/** Is this the demo number? (empty DEMO_MOBILE disables demo mode entirely.) */
function isDemo(mobile) {
  return !!DEMO_MOBILE && normaliseMobile(mobile) === DEMO_MOBILE;
}

/**
 * Does THIS message belong to the demo, or should it fall through to the normal
 * flow? Only demo-specific taps and the word "demo" are owned — so everything
 * else (hi/menu, subscribe, the payment link, my subscription, support …) works
 * for this number exactly as it does for any other parent. This is what keeps
 * the regular checkout / payment link available on the demo number.
 */
function owns(text, id) {
  if (id && (id === 'demo_start' || id === 'demo_again' || id === 'demo_pay'
      || id.startsWith('dbrd_') || id.startsWith('dgrd_')
      || id.startsWith('dmed_') || id.startsWith('dans_') || id.startsWith('dpay_'))) return true;
  return /^demo$/i.test((text || '').trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Merge a patch into session.context.demo without losing earlier picks. */
async function setDemo(session, patch) {
  const demo = { ...(session.context?.demo || {}), ...patch };
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at=now() WHERE id=$1`,
    [session.id, JSON.stringify({ demo })]);
  session.context = { ...(session.context || {}), demo };
  return demo;
}

/* --------------------------------------------------------------- the router */
async function handle(session, mobile, msg, text, id) {
  try {
    if (id && id.startsWith('dans_')) return await answer(session, mobile, id);
    if (id === 'demo_start' || id === 'demo_again') return await askBoard(session, mobile);
    if (id && id.startsWith('dbrd_')) { await setDemo(session, { board: id.slice(5) }); return await askGrade(session, mobile); }
    if (id && id.startsWith('dgrd_')) { await setDemo(session, { grade: id.slice(5) }); return await askMedium(session, mobile); }
    if (id && id.startsWith('dmed_')) { await setDemo(session, { medium: id.slice(5) }); return await begin(session, mobile); }
    if (id === 'demo_pay') return await showPay(session, mobile);
    if (id && id.startsWith('dpay_')) return await fakePay(session, mobile);
    return await menu(session, mobile);
  } catch (e) {
    console.error('[demo] handle failed:', e.message);
    await wa.sendText(session.id, mobile, '😕 Demo hit a snag. Type *menu* to start again.');
  }
}

/* --------------------------------------------------------------- the screens */
async function menu(session, mobile) {
  await wa.sendList(session.id, mobile, {
    text: '🧪 *QuizPe — Demo mode*\n\nShow a school exactly how it works: pick a class, take a 5-question quiz, get the real report — and a sample ₹99 payment with invoice.',
    buttonText: 'Demo options',
    footer: 'Demo · nothing is saved',
    rows: [
      { id: 'demo_start', title: '▶️ Start demo quiz', description: 'Pick board, grade & medium — 5 questions' },
      { id: 'demo_pay', title: '💳 Payment demo', description: 'Sample ₹99 pay + invoice (no real charge)' },
    ],
  });
}

async function askBoard(session, mobile) {
  const { rows } = await db.query(
    `SELECT board_code, board_name FROM boards WHERE is_active ORDER BY board_name LIMIT 10`);
  if (!rows.length) return wa.sendText(session.id, mobile, 'No boards configured yet.');
  await wa.sendList(session.id, mobile, {
    text: '📚 *Step 1 of 3 — Board*\n\nWhich board is the child on?',
    buttonText: 'Choose board', footer: 'Demo',
    rows: rows.map(r => ({ id: `dbrd_${r.board_code}`, title: r.board_name.slice(0, 24) })),
  });
}

async function askGrade(session, mobile) {
  const { rows } = await db.query(
    `SELECT grade_code, grade_name FROM grades WHERE is_active ORDER BY display_order, id LIMIT 10`);
  if (!rows.length) return wa.sendText(session.id, mobile, 'No grades configured yet.');
  await wa.sendList(session.id, mobile, {
    text: '🎓 *Step 2 of 3 — Grade*\n\nWhich class?',
    buttonText: 'Choose grade', footer: 'Demo',
    rows: rows.map(r => ({ id: `dgrd_${r.grade_code}`, title: r.grade_name.slice(0, 24) })),
  });
}

async function askMedium(session, mobile) {
  const { rows } = await db.query(
    `SELECT medium_code, medium_name FROM mediums WHERE is_active ORDER BY medium_name LIMIT 10`);
  if (!rows.length) return wa.sendText(session.id, mobile, 'No mediums configured yet.');
  await wa.sendList(session.id, mobile, {
    text: '🗣️ *Step 3 of 3 — Medium*\n\nMedium of instruction?',
    buttonText: 'Choose medium', footer: 'Demo',
    rows: rows.map(r => ({ id: `dmed_${r.medium_code}`, title: r.medium_name.slice(0, 24) })),
  });
}

/* -------------------------------------------------------- build & run a quiz */
/** Find (or create) the single hidden demo parent shell to hang students on. */
async function demoParentId() {
  const found = (await db.query(
    `SELECT id FROM parents WHERE parent_mobile_number = $1`, [DEMO_MOBILE])).rows[0];
  if (found) return found.id;
  return (await db.query(
    `INSERT INTO parents (parent_name, parent_mobile_number, is_active)
     VALUES ('__DEMO__', $1, false)
     ON CONFLICT (parent_mobile_number) DO UPDATE SET modified_at = now()
     RETURNING id`, [DEMO_MOBILE])).rows[0].id;
}

async function begin(session, mobile) {
  const d = session.context?.demo || {};
  if (!d.board || !d.grade || !d.medium) return menu(session, mobile);

  // resolve ids + confirm there is real content for this class
  const ref = (await db.query(
    `SELECT (SELECT id FROM boards  WHERE board_code=$1 AND is_active)  AS board_id,
            (SELECT id FROM grades  WHERE grade_code=$2 AND is_active)  AS grade_id,
            (SELECT id FROM mediums WHERE medium_code=$3 AND is_active) AS medium_id,
            (SELECT id FROM subjects WHERE subject_code=$4)            AS subject_id`,
    [d.board, d.grade, d.medium, SUBJECT_CODE])).rows[0];
  if (!ref.board_id || !ref.grade_id || !ref.medium_id || !ref.subject_id) {
    return wa.sendText(session.id, mobile, '⚠️ That combination isn\'t set up. Type *menu* to try another.');
  }

  const pool = (await db.query(
    `SELECT COUNT(*)::int n FROM question_bank
      WHERE board_id=$1 AND grade_id=$2 AND medium_id=$3 AND subject_id=$4 AND is_active`,
    [ref.board_id, ref.grade_id, ref.medium_id, ref.subject_id])).rows[0].n;
  if (pool < N_QUESTIONS) {
    return wa.sendText(session.id, mobile,
      `⚠️ Only ${pool} question(s) available for that class right now — not enough for a demo. Type *menu* to pick another.`);
  }

  const parentId = await demoParentId();

  // fresh throwaway student for this demo (also clears any abandoned earlier one)
  await purgeStudentByName(parentId, 'Demo Child');
  const studentId = (await db.query(
    `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name, is_active)
     VALUES ($1,$2,$3,$4,'Demo Child', true) RETURNING id`,
    [parentId, ref.board_id, ref.grade_id, ref.medium_id])).rows[0].id;

  // throwaway tracker + 5 random questions (repeatable across demos — no history)
  const trackerId = (await db.query(
    `INSERT INTO quizpe_tracker (student_id, subject_id, status_id, question_count, quiz_type)
     VALUES ($1,$2,(SELECT id FROM quizpe_status WHERE status_code='in_progress'),$3,'daily')
     RETURNING id`, [studentId, ref.subject_id, N_QUESTIONS])).rows[0].id;

  await db.query(
    `INSERT INTO student_quizpe_histories (tracker_id, question_id, serial_number, status_id)
     SELECT $1, q.id, ROW_NUMBER() OVER (),
            (SELECT id FROM quizpe_status WHERE status_code='scheduled')
       FROM (SELECT id FROM question_bank
              WHERE board_id=$2 AND grade_id=$3 AND medium_id=$4 AND subject_id=$5 AND is_active
              ORDER BY random() LIMIT $6) q`,
    [trackerId, ref.board_id, ref.grade_id, ref.medium_id, ref.subject_id, N_QUESTIONS]);

  await setDemo(session, { tracker: trackerId, student: studentId });
  await wa.sendText(session.id, mobile,
    `🧪 *Demo quiz ready* — ${N_QUESTIONS} questions.\nAnswer each one; the full report comes right after. 🚀`);

  const q = await Q.nextQuestion(trackerId);
  if (!q) return finish(session, mobile, trackerId);
  await sendDemoQuestion(session, mobile, trackerId, q);
}

async function sendDemoQuestion(session, mobile, trackerId, q) {
  await db.query(
    `UPDATE student_quizpe_histories SET sent_at = COALESCE(sent_at, now())
      WHERE tracker_id=$1 AND serial_number=$2`, [trackerId, q.serial_number]);
  const opts = [q.option_a, q.option_b, q.option_c, q.option_d]
    .map((text, i) => ({ letter: LETTERS[i], text })).filter(o => o.text);
  await wa.sendList(session.id, mobile, {
    text: `🧪 *Demo · Question ${q.serial_number} of ${q.total}*\n_${q.chapter}_\n\n${q.question_whatsapp}`,
    buttonText: 'Choose answer', footer: 'Demo quiz · QuizPe',
    rows: opts.map(o => ({ id: `dans_${trackerId}_${q.serial_number}_${o.letter}`, title: `${o.letter}) ${o.text}`.slice(0, 24) })),
  });
}

/** Answer id: dans_<tracker>_<serial>_<letter> */
async function answer(session, mobile, id) {
  const [, trackerId, serial, letter] = id.split('_');
  await Q.submitAnswer(session.id, mobile, Number(trackerId), Number(serial), letter);
  const next = await Q.nextQuestion(Number(trackerId));
  if (next) return sendDemoQuestion(session, mobile, Number(trackerId), next);
  return finish(session, mobile, Number(trackerId));
}

/* ------------------------------------------------------------- finish + purge */
async function finish(session, mobile, trackerId) {
  const studentId = (await db.query(
    `SELECT student_id FROM quizpe_tracker WHERE id=$1`, [trackerId])).rows[0]?.student_id;

  await db.query(
    `UPDATE quizpe_tracker SET status_id=(SELECT id FROM quizpe_status WHERE status_code='completed'), modified_at=now()
      WHERE id=$1`, [trackerId]);

  const { rows: [sc] } = await db.query(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE is_correct)::int correct
       FROM student_quizpe_histories WHERE tracker_id=$1`, [trackerId]);
  const pct = sc.total ? Math.round((sc.correct * 100) / sc.total) : 0;

  await wa.sendText(session.id, mobile,
    `🎯 *Demo complete!*\n\nScore: *${sc.correct}/${sc.total}* (${pct}%)\n\n_Generating the report a parent would get…_ 📄`);

  let filePath = null;
  try {
    const { generateDailyReport } = require('../pdf/dailyReport');
    const rep = await generateDailyReport(trackerId);
    filePath = rep.filePath;
    await wa.sendDocument(session.id, mobile, {
      filePath: rep.filePath,
      filename: `QuizPe-Demo-Report.pdf`,
      caption: `📄 *Demo report* — this is exactly what a parent receives after every quiz.\n` +
               `Score ${rep.score.correct}/${rep.score.total} (${rep.score.pct}%) · *${rep.score.grade}*.`,
    });
  } catch (e) {
    console.error('[demo] report failed:', e.message);
    await wa.sendText(session.id, mobile, '😕 Could not render the demo report this time — the quiz itself worked.');
  }

  // purge EVERYTHING this demo created; leave nothing behind
  try {
    if (filePath) { try { fs.unlinkSync(filePath); } catch { /* file already gone */ } }
    if (studentId) await purgeStudent(studentId);
  } catch (e) { console.error('[demo] purge failed:', e.message); }

  await setDemo(session, { tracker: null, student: null });
  await wa.sendList(session.id, mobile, {
    text: '✅ *That\'s the full experience* — quiz + instant report.\n\nRun another class, show the payment, or you\'re done.',
    buttonText: 'Demo options', footer: 'Demo · nothing was saved',
    rows: [
      { id: 'demo_again', title: '🔁 Run another demo', description: 'Pick a different class' },
      { id: 'demo_pay', title: '💳 Payment demo', description: 'Sample ₹99 pay + invoice (no real charge)' },
    ],
  });
}

/* ------------------------------------------------------- fake ₹99 checkout */
/**
 * A SIMULATED payment, demo number only. Shows a pay screen, a short
 * "processing → success" sequence, then a SAMPLE invoice PDF. No gateway is
 * touched, no money moves, and nothing is written to invoices / GST tables —
 * see src/pdf/demoInvoice.js. The real checkout (paymentRouter) is untouched.
 */
async function showPay(session, mobile) {
  await wa.sendButtons(session.id, mobile,
    '💳 *Payment demo*\n\n*QuizPe — Monthly plan*\nAmount: *₹99* (incl. GST)\n\nThis is a safe demo — tapping *Pay ₹99* shows the success screen and a sample invoice. No real payment is taken.',
    [{ id: 'dpay_99', title: '💳 Pay ₹99' }],
    'Demo payment · nothing is charged');
}

async function fakePay(session, mobile) {
  // a little "animation" — the WhatsApp equivalent is a short staged sequence
  await wa.sendText(session.id, mobile, '🔐 Opening secure payment…');
  await sleep(700);
  await wa.sendText(session.id, mobile, '⏳ Processing your payment of *₹99*…');
  await sleep(900);
  await wa.sendText(session.id, mobile, '✅ *Payment successful!*\n₹99 received. Preparing your invoice… 🧾');
  await sleep(500);

  let filePath = null;
  try {
    const { generateDemoInvoice } = require('../pdf/demoInvoice');
    const d = session.context?.demo || {};
    const childLabel = (d.board && d.grade) ? `Class: ${d.grade} · ${d.board}` : null;
    const inv = await generateDemoInvoice({
      parentName: session.context?.parent_name || 'Demo Parent',
      mobile, childLabel, amount: 99,
    });
    filePath = inv.filePath;
    await wa.sendDocument(session.id, mobile, {
      filePath: inv.filePath, filename: 'QuizPe-Invoice.pdf',
      caption: '🧾 *Invoice* — QuizPe subscription\nAmount paid: *₹99* (incl. GST)\n\n_Demo sample — no real payment was taken and no tax invoice was issued._',
    });
  } catch (e) {
    console.error('[demo] fake invoice failed:', e.message);
    await wa.sendText(session.id, mobile, '😕 Could not generate the demo invoice this time.');
  } finally {
    if (filePath) { try { fs.unlinkSync(filePath); } catch { /* already gone */ } }
  }

  await wa.sendList(session.id, mobile, {
    text: '👍 That\'s the full parent journey — pay, instant confirmation, invoice.\n\nAnything else to show?',
    buttonText: 'Demo options', footer: 'Demo · nothing was charged',
    rows: [
      { id: 'demo_again', title: '🔁 Run a quiz demo', description: 'Pick a class — 5 questions' },
      { id: 'demo_pay', title: '💳 Show payment again', description: 'Sample ₹99 pay + invoice' },
    ],
  });
}

/** Remove every trace of one throwaway demo student (reports, answers, tracker, student). */
async function purgeStudent(studentId) {
  await db.query(`DELETE FROM quiz_reports WHERE tracker_id IN (SELECT id FROM quizpe_tracker WHERE student_id=$1)`, [studentId]);
  await db.query(`DELETE FROM student_quizpe_histories WHERE tracker_id IN (SELECT id FROM quizpe_tracker WHERE student_id=$1)`, [studentId]);
  await db.query(`DELETE FROM student_subject_progress WHERE student_id=$1`, [studentId]);
  await db.query(`DELETE FROM quizpe_tracker WHERE student_id=$1`, [studentId]);
  await db.query(`DELETE FROM students WHERE id=$1`, [studentId]);
}

/** Clear an abandoned earlier demo student of the same name before a new run. */
async function purgeStudentByName(parentId, name) {
  const { rows } = await db.query(
    `SELECT id FROM students WHERE parent_id=$1 AND student_name=$2`, [parentId, name]);
  for (const r of rows) { try { await purgeStudent(r.id); } catch (e) { console.error('[demo] stale purge:', e.message); } }
}

module.exports = { isDemo, owns, handle, DEMO_MOBILE };
