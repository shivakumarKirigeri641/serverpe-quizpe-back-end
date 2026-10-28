/**
 * src/whatsapp/chatQuiz.js — THE QUIZ INSIDE THE CHAT (user, 2026-10-28, with pay as you answer).
 * ---------------------------------------------------------------------------
 *   question   the question and 3 options in full — the correct one and 2 of the 3
 *              wrong ones, picked at random — as 3 reply buttons (the option text,
 *              or A / B / C when any option is longer than 20 characters). The answer
 *              is NEVER revealed during the quiz; every tap brings the next question.
 *              Footer: "Reply END to stop & get your report now".
 *   every 10   "Do you still want to continue?" [Yes sure] [No, next day] [👦 Next student]
 *              — with one student: [Yes sure] [End quiz 📄]
 *   end        END / "No, next day" / "End quiz" / the daily limit: unanswered questions
 *              are dropped, the score card + PDF report follow (quiz.finishQuiz).
 *              0 answered: nothing used, no report.
 *   paying     a plan (₹99/169/249) first — its slots, as before; then the MCQ balance
 *              (prepaid/wallet.js): one MCQ per ANSWERED question, never more.
 *
 * Button ids: qc_yes_<studentId> · qc_end_<studentId> · qc_next · qc_done · mcq_<rupees>
 * Answers keep the old id ans_<tracker>_<serial>_<letter> with the ORIGINAL letter
 * (A-D), so Q.submitAnswer scores them unchanged.
 * ---------------------------------------------------------------------------
 */
const db = require('../database/connectDB');
const wa = require('./client');
const Q = require('./quiz');
const W = require('../prepaid/wallet');

const FOOTER = 'Reply END to stop & get your report now';
const LABELS = ['A', 'B', 'C'];

/* ── state on the session (the same table flow.js uses) ── */
async function setState(sessionId, state, patch = null) {
  await db.query(
    `UPDATE whatsapp_sessions SET state = $2, context = context || $3::jsonb, modified_at = now() WHERE id = $1`,
    [sessionId, state, JSON.stringify(patch || {})]);
}

/* ── which 3 options, in which order: fixed per question (seeded by its history row), so a re-sent
      question looks the same and a typed "B" means the same option ── */
function rng(seed) {
  let a = Number(seed) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function threeOptions(q) {
  const all = ['A', 'B', 'C', 'D'].map((l) => ({ letter: l, text: String(q[`option_${l.toLowerCase()}`] || '').trim() }))
    .filter((o) => o.text);
  const rand = rng(q.id);
  const right = all.find((o) => o.letter === String(q.answer || '').toUpperCase());
  const wrong = shuffle(all.filter((o) => o !== right), rand).slice(0, right ? 2 : 3);
  return shuffle(right ? [right, ...wrong] : wrong, rand);
}
/** A typed "b" maps to the ORIGINAL letter of the option shown as B. */
function originalLetter(q, typed) {
  const i = LABELS.indexOf(String(typed || '').trim().toUpperCase());
  return i < 0 ? null : threeOptions(q)[i]?.letter || null;
}

/** The next unanswered question of a quiz, with what is needed to show it. */
async function nextQ(trackerId) {
  return (await db.query(
    `SELECT h.id, h.serial_number, qb.question_whatsapp, qb.chapter, qb.answer,
            qb.option_a, qb.option_b, qb.option_c, qb.option_d, s.subject_name,
            (SELECT count(*)::int FROM student_quizpe_histories x WHERE x.tracker_id = h.tracker_id) AS total
       FROM student_quizpe_histories h
       JOIN question_bank qb ON qb.id = h.question_id
       JOIN quizpe_tracker t ON t.id = h.tracker_id
       JOIN subjects s ON s.id = t.subject_id
      WHERE h.tracker_id = $1 AND h.answered_option IS NULL
      ORDER BY h.serial_number LIMIT 1`, [trackerId])).rows[0] || null;
}

/** Show one question: full text with A) B) C), and 3 answer buttons. */
async function sendQ(sessionId, mobile, trackerId, q) {
  await db.query(`UPDATE student_quizpe_histories SET sent_at = COALESCE(sent_at, now()) WHERE id = $1`, [q.id]);
  const opts = threeOptions(q);
  const fits = opts.every((o) => [...o.text].length <= 20) && new Set(opts.map((o) => o.text)).size === opts.length;
  const body = `📘 *Question ${q.serial_number} of ${q.total}* · ${q.subject_name || 'Maths'}\n_${q.chapter}_\n\n`
    + `${q.question_whatsapp}\n\n${opts.map((o, i) => `*${LABELS[i]})* ${o.text}`).join('\n')}`;
  const buttons = opts.map((o, i) => ({ id: `ans_${trackerId}_${q.serial_number}_${o.letter}`, title: fits ? o.text : LABELS[i] }));
  if ([...body].length <= 1024) {
    await wa.sendButtons(sessionId, mobile, body, buttons, FOOTER);
  } else {
    // A long question: the text first, then the buttons.
    await wa.sendText(sessionId, mobile, body);
    await wa.sendButtons(sessionId, mobile, 'Choose your answer 👇', buttons, FOOTER);
  }
}

const studentOf = async (studentId) => (await db.query(
  `SELECT st.id, st.student_name, st.parent_id, st.difficulty_level, st.daily_mcq_limit,
          (SELECT count(*)::int FROM students x WHERE x.parent_id = st.parent_id AND x.is_active) AS siblings
     FROM students st WHERE st.id = $1`, [studentId])).rows[0] || null;

const trackerOf = async (trackerId) => (await db.query(
  `SELECT t.id, t.student_id, t.subject_id, t.paid_by, t.question_count, t.difficulty_level, qs.status_code
     FROM quizpe_tracker t JOIN quizpe_status qs ON qs.id = t.status_id WHERE t.id = $1`, [trackerId])).rows[0] || null;

const answeredIn = async (trackerId) => (await db.query(
  `SELECT count(*) FILTER (WHERE answered_option IS NOT NULL)::int AS done, count(*)::int AS total
     FROM student_quizpe_histories WHERE tracker_id = $1`, [trackerId])).rows[0];

/* ── the recharge offer ── */
async function rechargeOffer(sessionId, mobile, text) {
  await wa.sendButtons(sessionId, mobile, text, await W.packButtons(), '20 paise per MCQ + GST · valid till 31 Mar');
}

/** Why the balance cannot pay for more today, said plainly; returns true when a message went out. */
async function sayNoAllowance(sessionId, mobile, st, a, inRound = null) {
  if (a.reason === 'daily_limit') {
    await wa.sendButtons(sessionId, mobile,
      `✅ *${st.student_name}* has reached today's limit of *${a.limit} MCQs*. Well done! 🌟\n\n`
      + `More tomorrow — or change the daily limit in the menu.`,
      [{ id: 'qc_next', title: '👦 Next student' }, { id: 'qc_done', title: '✔️ Done' }]);
    return true;
  }
  if (a.reason === 'free_daily') {
    await rechargeOffer(sessionId, mobile,
      `🎁 That's today's *20 free MCQs* done for ${st.student_name}. The rest of your free MCQs carry on tomorrow.\n\n`
      + `Want to practise more today? Recharge — it's used straight away.`);
    return true;
  }
  await rechargeOffer(sessionId, mobile,
    (inRound ? `Your MCQ balance is used up (${st.student_name} answered ${inRound.done} so far).\n\n` : `Your MCQ balance is *0*.\n\n`)
    + `Recharge to continue — ${st.student_name} will carry on from the next question.`);
  return true;
}

/**
 * Start (or continue) a quiz paid from the balance: one quiz per sitting, filled 10 questions at a time, so
 * END gives ONE report for everything answered. Grants the free 50 to an eligible family first.
 */
async function startWallet(sessionId, mobile, st) {
  if ((await W.balance(st.parent_id)).left <= 0) {
    const lot = await W.grantFree(st.parent_id);
    if (lot) {
      const cfg = await W.config();
      await wa.sendText(sessionId, mobile,
        `🎁 *${cfg.free_mcqs} free MCQs* added for your family — valid ${cfg.free_days} days, up to ${cfg.free_per_day} a day. Let's begin! 🚀`);
    }
  }
  const a = await W.allowance(st.parent_id, st.id);
  if (!a.allowed) return sayNoAllowance(sessionId, mobile, st, a);

  const cfg = await W.config();
  const want = Math.min(cfg.round, a.allowed);
  // Today's open balance quiz for this student, if any: add the next round to it.
  let t = (await db.query(
    `SELECT t.id, t.question_count FROM quizpe_tracker t JOIN quizpe_status qs ON qs.id = t.status_id
      WHERE t.student_id = $1 AND t.quiz_date = CURRENT_DATE AND t.paid_by = 'wallet'
        AND qs.status_code IN ('scheduled','in_progress') ORDER BY t.id DESC LIMIT 1`, [st.id])).rows[0];
  if (t && (await nextQ(t.id))) return carryOn(sessionId, mobile, t.id, st);
  if (t && Number(t.question_count) + want > 50) {           // the tracker holds 50 at most
    await Q.finishQuiz(sessionId, mobile, t.id, { noOffer: true });
    t = null;
  }
  if (t) {
    const added = await appendRound(t.id, want);
    if (!added) return noQuestions(sessionId, mobile, st);
    return carryOn(sessionId, mobile, t.id, st);
  }
  const subject = (await Q.subjectsForStudent(st.id))[0];
  if (!subject) return noQuestions(sessionId, mobile, st);
  const slot = (await db.query(
    `SELECT greatest(coalesce(max(quiz_slot), 99), 99) + 1 AS n FROM quizpe_tracker
      WHERE student_id = $1 AND subject_id = $2 AND quiz_date = CURRENT_DATE AND quiz_slot >= 100`, [st.id, subject.id])).rows[0].n;
  const tid = (await db.query(
    `INSERT INTO quizpe_tracker (student_id, subject_id, status_id, question_count, quiz_type, quiz_slot, paid_by)
     VALUES ($1, $2, (SELECT id FROM quizpe_status WHERE status_code = 'scheduled'), $3, 'practice', $4, 'wallet')
     RETURNING id`, [st.id, subject.id, Math.max(want, 1), slot])).rows[0].id;
  const r = await Q.startQuiz(tid, st.difficulty_level || null);
  if (r.error) return noQuestions(sessionId, mobile, st);
  // startQuiz never builds fewer than 8; keep only what the balance allows.
  await trimTo(tid, want);
  return carryOn(sessionId, mobile, tid, st);
}

/** Add `n` unseen questions to a balance quiz (the next round of 10). */
async function appendRound(trackerId, n) {
  const mastery = require('./mastery');
  const t = await trackerOf(trackerId);
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const { ids } = await mastery.selectQuestions(t.student_id, t.subject_id, n, c, t.difficulty_level || null);
    const take = (ids || []).slice(0, n);
    if (!take.length) { await c.query('ROLLBACK'); return 0; }
    const start = (await c.query(`SELECT coalesce(max(serial_number), 0)::int AS m FROM student_quizpe_histories WHERE tracker_id = $1`, [trackerId])).rows[0].m;
    await c.query(
      `INSERT INTO student_quizpe_histories (tracker_id, question_id, serial_number, status_id)
       SELECT $1, q.id, $3 + ROW_NUMBER() OVER (ORDER BY ord), (SELECT id FROM quizpe_status WHERE status_code = 'scheduled')
         FROM unnest($2::bigint[]) WITH ORDINALITY AS q(id, ord)`, [trackerId, take, start]);
    await c.query(`UPDATE quizpe_tracker SET question_count = question_count + $2, modified_at = now() WHERE id = $1`, [trackerId, take.length]);
    await c.query('COMMIT');
    return take.length;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** Drop never-answered questions beyond `keep` (startQuiz builds at least 8). */
async function trimTo(trackerId, keep) {
  await db.query(
    `DELETE FROM student_quizpe_histories WHERE tracker_id = $1 AND answered_option IS NULL AND serial_number > $2`, [trackerId, keep]);
  await db.query(
    `UPDATE quizpe_tracker SET question_count = (SELECT count(*) FROM student_quizpe_histories WHERE tracker_id = $1) WHERE id = $1`, [trackerId]);
}

async function noQuestions(sessionId, mobile, st) {
  await wa.sendText(sessionId, mobile, `😕 No new questions are left for ${st.student_name} right now. We're adding more soon!`);
}

/** Send the next question of this quiz (in_quiz), or end it when none are left. */
async function carryOn(sessionId, mobile, trackerId, st) {
  const q = await nextQ(trackerId);
  if (!q) return endQuiz(sessionId, mobile, trackerId, 'finished');
  await setState(sessionId, 'in_quiz', { tracker_id: trackerId, student_id: st.id });
  await sendQ(sessionId, mobile, trackerId, q);
}

/**
 * After an answer was saved: charge the balance (balance quizzes), then the next question, the "continue?"
 * question every 10, or the end.
 */
async function afterAnswer(sessionId, mobile, trackerId, serial) {
  const t = await trackerOf(trackerId);
  if (!t) return;
  const st = await studentOf(t.student_id);
  if (t.paid_by === 'wallet') {
    const h = (await db.query(`SELECT id FROM student_quizpe_histories WHERE tracker_id = $1 AND serial_number = $2`, [trackerId, serial])).rows[0];
    if (h) await W.debit({ parentId: st.parent_id, studentId: st.id, trackerId, historyId: h.id })
      .catch((e) => console.error('[chatQuiz] debit failed:', e.message));
  }
  const p = await answeredIn(trackerId);
  const cfg = await W.config();
  const more = p.done < p.total;
  const roundDone = p.done % cfg.round === 0;

  if (t.paid_by === 'wallet') {
    // The balance quiz stays open across rounds, so END gives one report for the whole sitting.
    const a = await W.allowance(st.parent_id, st.id);
    if (!a.allowed) {                       // limit or balance reached: report what was answered, say why
      await endQuiz(sessionId, mobile, trackerId, 'stopped', { quiet: true });
      return sayNoAllowance(sessionId, mobile, st, a, p);
    }
    if (roundDone || !more) return askContinue(sessionId, mobile, st, p.done);
    return carryOn(sessionId, mobile, trackerId, st);
  }

  // A plan quiz (10-15 questions): "continue?" at 10 when more remain; at its end the report, then what next.
  if (more) return roundDone ? askContinue(sessionId, mobile, st, p.done) : carryOn(sessionId, mobile, trackerId, st);
  await Q.finishQuiz(sessionId, mobile, trackerId, { noOffer: true });
  await setState(sessionId, 'main_menu');
  return afterReport(sessionId, mobile, st);
}

/** "Do you still want to continue?" after every 10. */
async function askContinue(sessionId, mobile, st, done) {
  const bal = await W.balance(st.parent_id);
  const cfg = await W.config();
  const low = bal.left > 0 && bal.left <= cfg.low_left ? `\n⚠️ Only *${bal.left} MCQs* left — recharge any time to avoid a break.` : '';
  const balLine = bal.left > 0 ? ` · ${bal.left} MCQs left` : '';
  const buttons = Number(st.siblings) > 1
    ? [{ id: `qc_yes_${st.id}`, title: 'Yes sure' }, { id: `qc_end_${st.id}`, title: 'No, next day' }, { id: 'qc_next', title: '👦 Next student' }]
    : [{ id: `qc_yes_${st.id}`, title: 'Yes sure' }, { id: `qc_end_${st.id}`, title: 'End quiz 📄' }];
  await wa.sendButtons(sessionId, mobile,
    `🎯 *${done} done!*${balLine}${low}\n\nDo you still want to continue?`, buttons, FOOTER);
}

/** After a report: who's next. */
async function afterReport(sessionId, mobile, st) {
  const buttons = [];
  if (Number(st.siblings) > 1) buttons.push({ id: 'qc_next', title: '👦 Next student' });
  buttons.push({ id: `qc_yes_${st.id}`, title: `▶️ ${st.student_name}`.slice(0, 14) + ' again' });
  buttons.push({ id: 'qc_done', title: '✔️ Done' });
  const bal = await W.balance(st.parent_id);
  await wa.sendButtons(sessionId, mobile,
    `What next?${bal.left > 0 ? `\n\n💰 Balance: *${bal.left} MCQs* (valid till ${W.fmtDay(bal.lastExpiry)})` : ''}`,
    buttons.slice(0, 3));
}

/**
 * End a quiz now (END, "No, next day", "End quiz", the daily limit). Never-answered questions are dropped, so
 * the score and the report cover exactly what was answered — and nothing unanswered was ever charged.
 */
async function endQuiz(sessionId, mobile, trackerId, why = 'ended', opts = {}) {
  const t = await trackerOf(trackerId);
  if (!t || ['completed', 'closed', 'cancelled'].includes(t.status_code)) {
    await setState(sessionId, 'main_menu');
    if (!opts.quiet) await wa.sendButtons(sessionId, mobile, 'No quiz is running right now.',
      [{ id: 'start_quiz', title: '▶️ Start quiz' }, { id: 'back_menu', title: 'Menu' }]);
    return;
  }
  const st = await studentOf(t.student_id);
  const p = await answeredIn(trackerId);
  if (p.done === 0) {
    await db.query(`DELETE FROM student_quizpe_histories WHERE tracker_id = $1`, [trackerId]);
    await db.query(`UPDATE quizpe_tracker SET question_count = 1, status_id = (SELECT id FROM quizpe_status WHERE status_code = 'cancelled'), modified_at = now() WHERE id = $1`, [trackerId]);
    await setState(sessionId, 'main_menu');
    if (!opts.quiet) await wa.sendButtons(sessionId, mobile, 'No questions answered yet — nothing was used. 🙂',
      [{ id: `qc_yes_${st.id}`, title: '▶️ Start quiz' }, { id: 'qc_done', title: '✔️ Done' }]);
    return;
  }
  await db.query(`DELETE FROM student_quizpe_histories WHERE tracker_id = $1 AND answered_option IS NULL`, [trackerId]);
  await db.query(`UPDATE quizpe_tracker SET question_count = $2, modified_at = now() WHERE id = $1`, [trackerId, p.done]);
  await Q.finishQuiz(sessionId, mobile, trackerId, { noOffer: true });
  await setState(sessionId, 'main_menu');
  if (!opts.quiet) await afterReport(sessionId, mobile, st);
}

/** The quiz running in this chat right now, if any. */
async function currentTracker(session) {
  const id = Number(session?.context?.tracker_id);
  if (!id) return null;
  const t = await trackerOf(id);
  return t && ['scheduled', 'in_progress', 'delivered', 'yet_to_start'].includes(t.status_code) ? t : null;
}

/** "Yes sure" / "▶️ again": go on with this student — the plan first, then the balance. */
async function continueFor(session, mobile, studentId, begin) {
  const st = await studentOf(studentId);
  if (!st) return;
  const t = await currentTracker(session);
  if (t && Number(t.student_id) === Number(st.id) && (await nextQ(t.id))) {
    if (t.paid_by === 'wallet') {
      const a = await W.allowance(st.parent_id, st.id);
      if (!a.allowed) return sayNoAllowance(session.id, mobile, st, a, await answeredIn(t.id));
    }
    return carryOn(session.id, mobile, t.id, st);
  }
  if (t && Number(t.student_id) === Number(st.id) && t.paid_by === 'wallet') return startWallet(session.id, mobile, st);
  return begin(st);   // flow.beginQuizFor: the next plan quiz, or the balance when the plan is done
}

/** After a recharge: carry on the quiz that stopped, or offer to start. */
async function afterRecharge(sessionId, mobile, studentId) {
  if (!sessionId) return;
  if (studentId) {
    const st = await studentOf(studentId);
    if (st) return startWallet(sessionId, mobile, st);
  }
  await wa.sendButtons(sessionId, mobile, 'Ready when you are! 🚀', [{ id: 'start_quiz', title: '▶️ Start quiz' }, { id: 'back_menu', title: 'Menu' }]);
}

/** "Who is playing?" — buttons for up to 3 students, a list beyond. */
async function whoIsPlaying(sessionId, mobile, students) {
  if (students.length <= 3) {
    await wa.sendButtons(sessionId, mobile, '👋 *Who is playing?*',
      students.map((s) => ({ id: `child_${s.id}`, title: String(s.student_name).slice(0, 20) })));
    return;
  }
  await wa.sendList(sessionId, mobile, {
    header: '▶️ Start quiz', text: '👋 *Who is playing?*', buttonText: 'Choose student',
    rows: students.slice(0, 10).map((s) => ({ id: `child_${s.id}`, title: String(s.student_name).slice(0, 24), description: `${s.board_code} · ${s.grade_name}` })),
  });
}

/** The parent's balance, plainly. */
async function showBalance(sessionId, mobile, parentId) {
  const b = await W.balance(parentId);
  const lines = b.left
    ? `💰 *MCQ balance: ${b.left}*${b.free ? `\n🎁 Free: ${b.free} (till ${W.fmtDay(b.nextExpiry)})` : ''}${b.paid ? `\n💳 Paid: ${b.paid} (till ${W.fmtDay(b.lastExpiry)})` : ''}`
    : '💰 *MCQ balance: 0*';
  await rechargeOffer(sessionId, mobile, `${lines}\n\nPay as you answer — *20 paise per MCQ* (+GST). Recharge any time:`);
}

/** A recharge button was tapped: the Razorpay link. */
async function startRecharge(session, mobile, rupees) {
  const { createMcqLink } = require('../routers/paymentRouter');
  const resume = session?.context?.student_id || null;
  const r = await createMcqLink({ sessionId: session.id, mobile, rupees, resumeStudentId: resume });
  if (r.error) { await wa.sendText(session.id, mobile, `😕 ${r.error} Please try again in a moment.`); return; }
  await wa.sendCtaUrl(session.id, mobile, {
    header: `💳 ${r.mcqs} MCQs`,
    body: `*₹${r.rupees} + GST = ₹${r.amount}* for *${r.mcqs} MCQs* — 20 paise each, valid till 31 March.\n\n`
      + `🔒 Secure payment by *Razorpay* (UPI · card · netbanking). The MCQs are added the moment you pay, and the GST invoice comes here.`,
    displayText: `Pay ₹${r.amount}`,
    url: r.short_url,
    footer: 'ServerPe App Solutions (GST-registered)',
  });
}

module.exports = {
  threeOptions, originalLetter, nextQ, sendQ, startWallet, afterAnswer, endQuiz, continueFor, currentTracker, studentOf,
  afterRecharge, whoIsPlaying, showBalance, startRecharge, askContinue, carryOn, rechargeOffer, FOOTER,
};
