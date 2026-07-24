/**
 * src/whatsapp/flow.js
 * ---------------------------------------------------------------------------
 * The chatbot state machine.
 *
 *   new ──hi──> welcome ──agree──> main_menu
 *                                     │
 *                        start_trial ─┴─> trial_terms ──agree──> ask_student_name
 *                                              → ask_board → ask_grade → ask_state
 *                                              → active (trial created)
 *
 * Every inbound message is logged (idempotently, by wamid) and every state
 * change is recorded in whatsapp_session_events for funnel tracking.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
const wa = require('./client');
const M = require('./messages');
const { getUserContext, getStudents, buildMainMenu, normaliseMobile } = require('./userContext');
const Q = require('./quiz');

/* ------------------------------------------------------------------ session */

async function getOrCreateSession(mobile) {
  const { rows } = await db.query(
    `SELECT * FROM whatsapp_sessions WHERE mobile_number=$1 AND is_active`, [mobile]);
  if (rows.length) return rows[0];

  const ins = await db.query(
    `INSERT INTO whatsapp_sessions (mobile_number, state, last_inbound_at)
     VALUES ($1,'new', now()) RETURNING *`, [mobile]);
  return ins.rows[0];
}

async function setState(session, toState, event, payload = null) {
  await db.query(
    `INSERT INTO whatsapp_session_events (session_id, from_state, to_state, event, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [session.id, session.state, toState, event, payload]);
  await db.query(
    `UPDATE whatsapp_sessions SET state=$2, modified_at=now() WHERE id=$1`,
    [session.id, toState]);
  session.state = toState;
}

async function mergeContext(session, patch) {
  const { rows } = await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at=now()
      WHERE id=$1 RETURNING context`, [session.id, JSON.stringify(patch)]);
  session.context = rows[0].context;
  return session.context;
}

/** Idempotent — a redelivered webhook returns false and is skipped. */
async function logInbound(session, msg, mobile) {
  const { rowCount } = await db.query(
    `INSERT INTO whatsapp_messages
       (session_id, wa_message_id, direction, mobile_number, message_type, body, payload)
     VALUES ($1,$2,'inbound',$3,$4,$5,$6)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [session.id, msg.id, mobile, msg.type, extractText(msg), msg]);
  await db.query(
    `UPDATE whatsapp_sessions SET last_inbound_at=now(), modified_at=now() WHERE id=$1`,
    [session.id]);
  return rowCount > 0;
}

/* ------------------------------------------------------------------ helpers */

/** Pull usable text/id out of any inbound message shape. */
function extractText(msg) {
  if (msg.type === 'text') return msg.text?.body?.trim() || '';
  if (msg.type === 'button') return msg.button?.text || msg.button?.payload || '';
  if (msg.type === 'interactive') {
    return msg.interactive?.button_reply?.title
        || msg.interactive?.list_reply?.title || '';
  }
  return '';
}

/** The stable id of a tapped button/list row (falls back to text). */
function extractId(msg) {
  if (msg.type === 'interactive') {
    return msg.interactive?.button_reply?.id
        || msg.interactive?.list_reply?.id || '';
  }
  if (msg.type === 'button') return msg.button?.payload || '';
  return '';
}

const isGreeting = (t) => /^(hi|hii+|hello+|hey|start|menu|namaste|hi quizpe)$/i.test(t.trim());

/** 'HH:MM' shifted by whole hours, wrapping within the day. */
function shiftHour(hhmm, by) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${String((h + by + 24) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Detect the "Start Quiz now" tap from the 8 PM template (v2). Template
 * quick-reply buttons arrive as a `button` message whose text/payload is the
 * button label; also accept a typed "start quiz".
 */
function isStartQuiz(msg, text, id) {
  const hay = `${text || ''} ${id || ''} ${msg.button?.text || ''} ${msg.button?.payload || ''}`.toLowerCase();
  return /start\s*quiz/.test(hay);
}

/**
 * The "View plans" quick reply on the expiring/expired templates.
 *
 * A template button arrives as a `button` message, not a list selection, so it
 * would otherwise fall through to whatever state the session happens to be in
 * — quite possibly a stale one, since these templates are sent to parents who
 * have not been in touch for days.
 */
function isViewPlans(msg, text, id) {
  const hay = `${text || ''} ${id || ''} ${msg.button?.text || ''} ${msg.button?.payload || ''}`.toLowerCase();
  return /view\s*plans?/.test(hay);
}

async function recordConsent(session, policyId, mobile, waMessageId, parentId = null) {
  await db.query(
    `INSERT INTO policy_consents (session_id, parent_id, policy_id, mobile_number, wa_message_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (mobile_number, policy_id) DO NOTHING`,
    [session.id, parentId, policyId, mobile, waMessageId]);
}

/* -------------------------------------------------------------------- steps */

async function showWelcome(session, mobile) {
  const w = await M.welcome();
  await mergeContext(session, { terms_policy_id: w.policyId });

  // Brand the first impression with the QuizPe logo as an image header.
  let logoId;
  try {
    const { paths } = require('../assets/buildLogo');
    logoId = await wa.cachedMediaId(paths.banner);
  } catch (e) { console.error('[flow] logo header skipped:', e.message); }

  await wa.sendButtons(session.id, mobile, w.text,
    [{ id: 'agree_terms', title: '✅ Agree & Continue' }], w.footer, logoId);
  await setState(session, 'welcome', 'said_hi');
}

async function showMainMenu(session, mobile, ctx) {
  const rows = buildMainMenu(ctx);
  const greeting = ctx.exists && ctx.parentName ? `Welcome back, *${ctx.parentName}*! 👋` : `You're all set! 🎉`;
  let body = `${greeting}\n\n`;

  if (ctx.isSubscribed) {
    body += `*${ctx.planName}*${ctx.isTrial ? ' _(free trial)_' : ''} · ${ctx.daysLeft} day${ctx.daysLeft === 1 ? '' : 's'} remaining\n` +
            `Valid till ${M.fmtDate(ctx.endDate)}\n\n`;
  } else if (ctx.status === 'EXPIRED') {
    body += `Your *${ctx.planName}* ended on ${M.fmtDate(ctx.endDate)}.\n\n`;
  } else if (ctx.canStartTrial) {
    body += `You're new here — let's start with something free. 🎁\n\n`;
  }
  body += `*What would you like to do?*`;

  await wa.sendList(session.id, mobile, {
    text: body, buttonText: 'Choose an option', rows,
    footer: 'QuizPe · Small quiz, Big progress',
  });
  await setState(session, 'main_menu', 'shown_menu');
}

async function showTrialTerms(session, mobile) {
  const t = await M.trialTerms();
  await mergeContext(session, { trial_policy_id: t.policyId });

  // Short summary + link to full terms, so it fits one interactive message.
  await wa.sendButtons(session.id, mobile, t.text,
    [{ id: 'agree_trial', title: '✅ Agree & Proceed' },
     { id: 'back_menu', title: '⬅️ Back' }],
    t.footer);

  await setState(session, 'trial_terms', 'chose_trial');
}

async function askBoard(session, mobile) {
  // Only boards we can actually deliver. is_active alone is not enough: ICSE is
  // active but has no questions, and offering it dead-ends the parent after a
  // full signup. The EXISTS check keeps the list honest against real content —
  // the same promise the public site makes.
  const boards = (await db.query(
    `SELECT b.board_code, b.board_name FROM boards b
      WHERE b.is_active
        AND EXISTS (SELECT 1 FROM question_bank qb WHERE qb.board_id = b.id AND qb.is_active)
      ORDER BY b.display_order LIMIT 10`)).rows;
  const name = session.context.student_name;
  await wa.sendList(session.id, mobile, {
    text: `Nice to meet ${name}! 😊\n\n*2 of 4 — Which board is ${name} studying in?*`,
    buttonText: 'Select board',
    rows: boards.map(b => ({ id: `board_${b.board_code}`, title: b.board_code, description: b.board_name })),
  });
  await setState(session, 'ask_board', 'asked_board');
}

/** Mediums this board actually offers AND that we have content for. */
async function availableMediums(boardCode) {
  const { rows } = await db.query(
    `SELECT m.id, m.medium_code, m.medium_name, m.native_name
       FROM board_mediums bm
       JOIN boards  b ON b.id = bm.board_id
       JOIN mediums m ON m.id = bm.medium_id
      WHERE b.board_code = $1 AND bm.is_active AND m.is_active
        -- content gate: CBSE Hindi and KSEAB Kannada are configured but empty,
        -- so exclude any medium with no questions for this board
        AND EXISTS (SELECT 1 FROM question_bank qb
                     WHERE qb.board_id = b.id AND qb.medium_id = m.id AND qb.is_active)
      ORDER BY m.display_order LIMIT 10`, [boardCode]);
  return rows;
}

/** Ask only when there is a real choice; otherwise pick the single medium. */
async function askMediumOrSkip(session, mobile) {
  const mediums = await availableMediums(session.context.board_code);

  if (mediums.length === 0) {
    await wa.sendText(session.id, mobile,
      `😕 We don't have content for that board yet. Please choose another.`);
    await askBoard(session, mobile);
    return;
  }
  if (mediums.length === 1) {
    await mergeContext(session, { medium_code: mediums[0].medium_code });
    await askGrade(session, mobile);
    return;
  }
  await wa.sendList(session.id, mobile, {
    text: `*Which medium is ${session.context.student_name} studying in?*`,
    buttonText: 'Select medium',
    rows: mediums.map(m => ({
      id: `medium_${m.medium_code}`,
      title: m.native_name || m.medium_name,
      description: m.medium_name,
    })),
  });
  await setState(session, 'ask_medium', 'asked_medium');
}

async function askGrade(session, mobile) {
  // Grades we can serve for the board and medium already chosen. Every enabled
  // grade currently has content for both boards, so this changes nothing today —
  // but it means a partially-loaded board can never offer an empty grade.
  const { board_code, medium_code } = session.context;
  const grades = (await db.query(
    `SELECT g.grade_code, g.grade_name FROM grades g
      WHERE g.is_active
        AND EXISTS (
          SELECT 1 FROM question_bank qb
            JOIN boards  b ON b.id = qb.board_id  AND b.board_code  = $1
            JOIN mediums m ON m.id = qb.medium_id AND m.medium_code = $2
           WHERE qb.grade_id = g.id AND qb.is_active)
      ORDER BY g.display_order LIMIT 10`, [board_code, medium_code])).rows;
  await wa.sendList(session.id, mobile, {
    text: `*3 of 4 — Which grade is ${session.context.student_name} in?*`,
    buttonText: 'Select grade',
    rows: grades.map(g => ({ id: `grade_${g.grade_code}`, title: g.grade_name })),
  });
  await setState(session, 'ask_grade', 'asked_grade');
}

async function askState(session, mobile) {
  // 37 states > the 10-row list limit, so this step is typed, not a dropdown.
  await wa.sendText(session.id, mobile,
`*4 of 4 — Which state are you from?*
_(Needed for billing)_

Just type your state name, e.g. *Karnataka*`);
  await setState(session, 'ask_state', 'asked_state');
}

/** Create parent + student + trial subscription atomically. */
async function activateTrial(session, mobile, stateCode) {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const { student_name, board_code, grade_code } = session.context;

    const parent = (await c.query(
      `INSERT INTO parents (parent_name, parent_mobile_number, state_code)
       VALUES ($1,$2,$3)
       ON CONFLICT (parent_mobile_number) DO UPDATE
         SET state_code = EXCLUDED.state_code, modified_at = now()
       RETURNING id`,
      [session.context.parent_name || 'Parent', mobile, stateCode])).rows[0].id;

    const student = (await c.query(
      `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name)
       VALUES ($1,(SELECT id FROM boards  WHERE board_code=$2),
                  (SELECT id FROM grades  WHERE grade_code=$3),
                  (SELECT id FROM mediums WHERE medium_code=$4),$5)
       ON CONFLICT (parent_id, student_name) DO UPDATE
         SET board_id=EXCLUDED.board_id, grade_id=EXCLUDED.grade_id,
             medium_id=EXCLUDED.medium_id, modified_at=now()
       RETURNING id`,
      [parent, board_code, grade_code,
       session.context.medium_code || 'ENGLISH', student_name])).rows[0].id;

    // only one active subscription per parent
    await c.query(
      `UPDATE parents_quizpe_subscriptions SET is_active=false, modified_at=now()
        WHERE parent_id=$1 AND is_active`, [parent]);

    // whichever plan is flagged is_trial — length comes from the plan row
    const trial = (await c.query(
      `SELECT id, duration FROM quizpe_plans WHERE is_trial AND is_active ORDER BY id LIMIT 1`)).rows[0];
    if (!trial) throw new Error('NO_ACTIVE_TRIAL_PLAN');

    const slot = require('./quizSlot').slotFor(parent);   // spread the evening load

    const sub = (await c.query(
      `INSERT INTO parents_quizpe_subscriptions
         (parent_id, plan_id, plan_end_date, quiz_time, reminder_time)
       VALUES ($1, $2, CURRENT_DATE + $3::int, $4::time, $5::time)
       RETURNING id, plan_end_date, quiz_time`,
      [parent, trial.id, trial.duration, slot.quiz_time, slot.reminder_time])).rows[0];

    await c.query(
      `UPDATE whatsapp_sessions SET parent_id=$2, modified_at=now() WHERE id=$1`,
      [session.id, parent]);

    // Record who sent them, if anyone. Nothing is paid out here — the reward
    // lands on their first payment, so a free trial cannot be farmed for days.
    // Any failure is swallowed: a referral must never block an enrolment.
    if (session.context?.referral_code) {
      try {
        await require('../referrals/engine').capture(parent, session.context.referral_code, c);
      } catch (e) { console.error('[flow] referral capture skipped:', e.message); }
    }

    await c.query('COMMIT');

    // Operator alert, after COMMIT and never awaited: the parent's trial must
    // start whether or not the founder's notification email does.
    try {
      const notify = require('../mail/notify');
      const { fromWhatsApp } = require('../mail/context');
      const meta = (await db.query(
        `SELECT b.board_code, g.grade_name, m.medium_name, su.state_name, pl.plan_name
           FROM boards b, grades g, mediums m
           LEFT JOIN states_unions su ON su.state_code = $4
           LEFT JOIN quizpe_plans pl ON pl.id = $5
          WHERE b.board_code=$1 AND g.grade_code=$2 AND m.medium_code=$3 LIMIT 1`,
        [board_code, grade_code, session.context.medium_code || 'ENGLISH', stateCode, trial.id])).rows[0] || {};
      notify.trial({
        parent: { name: session.context.parent_name || 'Parent', mobile, state: meta.state_name || stateCode },
        children: [{
          name: student_name, board: meta.board_code || board_code,
          grade: meta.grade_name || grade_code, medium: meta.medium_name,
          school: session.context.school_name,
        }],
        plan: {
          name: meta.plan_name || 'Free trial', duration: trial.duration,
          start: M.fmtDate(new Date()), end: M.fmtDate(sub.plan_end_date),
          quizTime: M.fmtTime(sub.quiz_time), reminderTime: M.fmtTime(slot.reminder_time),
        },
        ctx: fromWhatsApp({ sessionId: session.id, mobile }),
      });
    } catch (e) { console.error('[flow] trial admin alert skipped:', e.message); }

    return { parentId: parent, studentId: student, ...sub };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/* ------------------------------------------------------------- main handler */

/**
 * One conversation at a time, per mobile number.
 *
 * Meta delivers each tap as its own webhook, so an impatient parent tapping a
 * menu row three times produces three concurrent runs of this state machine.
 * Without serialising, they interleave: two sessions get created, a plan is
 * chosen twice, the same question is answered twice. Queueing per number keeps
 * each conversation strictly sequential while different parents still run in
 * parallel — which is what matters at 8 PM.
 */
const inFlight = new Map();

// How long an identical repeated tap is treated as an accidental double-tap.
const REPEAT_TAP_SECONDS = Number(process.env.REPEAT_TAP_SECONDS) || 4;

function serialise(mobile, work) {
  const prev = inFlight.get(mobile) || Promise.resolve();
  const next = prev.then(work, work);          // run even if the previous failed
  const tail = next.catch(() => {});           // the chain must survive a failure
  inFlight.set(mobile, tail);
  // drop the entry once this number goes quiet, so the map can't grow forever
  tail.then(() => { if (inFlight.get(mobile) === tail) inFlight.delete(mobile); });
  return next;
}

function handleInbound(msg, contactName) {
  return serialise(normaliseMobile(msg.from), () => processInbound(msg, contactName));
}

async function processInbound(msg, contactName) {
  const mobile = normaliseMobile(msg.from);
  const session = await getOrCreateSession(mobile);

  const fresh = await logInbound(session, msg, mobile);
  if (!fresh) {
    console.log(`[flow] duplicate webhook ${msg.id} — skipped`);
    return;
  }

  // An impatient parent taps the same row three times. Those are three real
  // messages with different ids, so the wamid check above lets them through —
  // and they'd get three identical menus. Answer the first, ignore the rest.
  // Scoped to the same body within a few seconds, so deliberate repeats later
  // (or two different answers) are never swallowed.
  const body = extractText(msg);
  if (body) {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*)::int n FROM whatsapp_messages
        WHERE mobile_number = $1 AND direction = 'inbound' AND body = $2
          AND wa_message_id <> $3
          AND created_at > now() - ($4 || ' seconds')::interval`,
      [mobile, body, msg.id, String(REPEAT_TAP_SECONDS)]);
    if (r.n > 0) {
      console.log(`[flow] repeated "${body.slice(0, 24)}" from ${mobile} — ignored`);
      return;
    }
  }

  // A completed Flow arrives as one nfm_reply. Two flows use this: the signup
  // form and the per-question quiz screen — tell them apart by their payload.
  const flowReply = msg.interactive?.type === 'nfm_reply'
    ? safeJson(msg.interactive.nfm_reply?.response_json) : null;
  if (flowReply) {
    if (flowReply.tracker_id && flowReply.answer) {
      await handleAnswer(session, mobile,
        `ans_${flowReply.tracker_id}_${flowReply.serial}_${flowReply.answer}`);
    } else {
      await handleFlowSubmission(session, mobile, flowReply);
    }
    return;
  }

  // Anything that isn't text or a tap — photos, voice notes, stickers,
  // location, contacts. extractText() returns '' for these, which would
  // silently fall through to the state handler (and could even be stored as
  // feedback), so say plainly that we can't read it.
  const READABLE = ['text', 'button', 'interactive'];
  if (!READABLE.includes(msg.type)) {
    const what = {
      image: 'a photo', video: 'a video', audio: 'a voice note', sticker: 'a sticker',
      document: 'a file', location: 'a location', contacts: 'a contact',
    }[msg.type] || 'that';
    await wa.sendText(session.id, mobile,
      `🙈 Sorry, I can't read ${what} yet — I understand typed messages and the buttons below.\n\n` +
      `_Type *menu* to see your options._`);
    return;
  }

  const text = extractText(msg);
  const id = extractId(msg);
  const ctx = await getUserContext(mobile);
  if (contactName && !session.context.parent_name) {
    await mergeContext(session, { parent_name: contactName });
  }
  // Meta only sends the WhatsApp profile name on an INBOUND message — there is
  // no API to look it up. So capture it whenever it arrives, and fill in a
  // parent whose name is still blank or a placeholder (e.g. after an admin
  // changed their number). Never overwrite a name a human actually typed.
  if (contactName && ctx.parentId) {
    await db.query(
      `UPDATE parents
          SET parent_name = $2, modified_at = now()
        WHERE id = $1
          AND (parent_name IS NULL OR btrim(parent_name) = '' OR parent_name = 'Parent')`,
      [ctx.parentId, contactName.slice(0, 120)]).catch(() => {});
  }

  // STOP / START — a full pause, honoured from any state.
  //
  // STOP silences everything: the reminder, the quiz link and the missed-quiz
  // nudge. Because that means a paying parent stops receiving the service, the
  // reply has to say so plainly and name the date their plan still runs to —
  // otherwise silence looks like a fault rather than their own choice.
  if (/^(stop|unsubscribe|stop reminders|pause)$/i.test(text.trim())) {
    const { rows } = await db.query(
      `UPDATE parents SET service_paused = true, reminders_enabled = false,
              paused_at = now(), modified_at = now()
        WHERE parent_mobile_number = $1
        RETURNING id`, [mobile]);
    if (!rows.length) return;

    const till = (await db.query(
      `SELECT to_char(max(plan_end_date), 'DD Mon YYYY') AS d
         FROM parents_quizpe_subscriptions
        WHERE parent_id = $1 AND is_active AND plan_end_date >= CURRENT_DATE`,
      [rows[0].id])).rows[0]?.d;

    await wa.sendText(session.id, mobile,
      `🔕 *All messages paused.*\n\n` +
      `You will not get reminders, quiz links or any other message from us until you ask for them.\n\n` +
      (till ? `⚠️ Your plan still runs to *${till}* and is not cancelled — while it is paused, no quiz is sent, ` +
              `so those days are not used for practice.\n\n` : '') +
      `_Reply *START* whenever you want the daily quiz back._`);
    return;
  }

  // START must be forgiving. A parent who paused everything has no other way
  // back in, so anything that plainly means "resume" is accepted — including a
  // bare START, which is what WhatsApp users are used to typing.
  if (/^(start|start reminders|resume|unpause|begin)$/i.test(text.trim())) {
    const { rows } = await db.query(
      `UPDATE parents SET service_paused = false, reminders_enabled = true,
              paused_at = NULL, modified_at = now()
        WHERE parent_mobile_number = $1
        RETURNING id`, [mobile]);
    if (rows.length) {
      await wa.sendText(session.id, mobile,
        `🔔 *Welcome back!* Everything is switched on again.\n\n` +
        `Your child's next quiz arrives at its usual time this evening.`);
      // Show the menu rather than asking them to type "menu". START also reads
      // as a greeting, so whichever way the parent meant it, they get both the
      // resume and the options — and the session lands in a known state.
      await showMainMenu(session, mobile, ctx);
      return;
    }
    // not an enrolled parent — fall through so "start" still opens the menu
  }

  // HELP — a way out from any state, for parents who don't know what to type.
  if (/^(help|\?|commands)$/i.test(text.trim())) {
    await wa.sendText(session.id, mobile,
`❓ *How to use QuizPe*

• *menu* — all your options
• *report* — recent scores
• *stop* — pause all messages
• *start* — turn everything back on

Your child's quiz link arrives automatically each evening — just tap the button in that message.

Still stuck? Type *menu* and choose *💬 Support*.`);
    return;
  }

  // Feedback rating tap — valid from ANY state (the prompt arrives after a
  // quiz, but the parent may tap it much later).
  if (id.startsWith('fb_')) {
    const [, trackerId, rating] = id.split('_');
    const saved = await Q.saveFeedback(Number(trackerId), Number(rating),
      session.context.parent_name || contactName);
    const ack = rating >= '4' ? `🎉 Wonderful — thank you!`
      : rating === '3' ? `🙏 Thanks for the feedback.`
      : `🙏 Thank you. We'll adjust the difficulty to suit your child better.`;
    if (saved?.id) {
      await mergeContext(session, { feedback_id: saved.id });
      await setState(session, 'awaiting_feedback_text', 'feedback_rated', { rating: Number(rating) });
      await wa.sendText(session.id, mobile,
        `${ack}\n\nAnything you'd like to tell us? Type it below — or reply *skip*.`);
    } else {
      await wa.sendText(session.id, mobile, `${ack}\n\n${await nextQuizSignOff(ctx)}`);
    }
    return;
  }

  // "Change quiz time" — the second quick-reply on the missed-quiz template,
  // and a typed request. Offers the evening slots; the tap is handled below.
  if (id.startsWith('qt_')) {
    const at = id.slice(3);                                  // 'qt_20:00' -> '20:00'
    if (/^\d{2}:\d{2}$/.test(at) && ctx.parentId) {
      await db.query(
        `UPDATE parents_quizpe_subscriptions
            SET quiz_time = $2::time,
                reminder_time = ($2::time - interval '1 hour')::time,
                modified_at = now()
          WHERE parent_id = $1 AND is_active`, [ctx.parentId, at]);
      await wa.sendText(session.id, mobile,
        `✅ Quiz time updated to *${M.fmtTime(at)}*.\n\n` +
        `Your reminder will now come an hour earlier, at *${M.fmtTime(shiftHour(at, -1))}*.\n\n` +
        `_Type *menu* for other options._`);
    } else {
      await wa.sendText(session.id, mobile, `Couldn't update the time. Type *menu* to try again.`);
    }
    return;
  }
  if (/change\s*quiz\s*time|change\s*time/i.test(`${text} ${id}`)) {
    if (!ctx.isSubscribed) {
      await wa.sendText(session.id, mobile, `You don't have an active subscription yet. Type *menu* to get started.`);
      return;
    }
    await wa.sendList(session.id, mobile, {
      header: 'Daily quiz time',
      text: `⏰ *When should the daily quiz arrive?*\n\nCurrently *${M.fmtTime(ctx.quizTime)}*.\n\n` +
            `_The reminder comes one hour before._`,
      buttonText: 'Choose a time',
      rows: ['17:00', '18:00', '19:00', '20:00', '21:00'].map(t => ({
        id: `qt_${t}`, title: M.fmtTime(t),
        description: t === String(ctx.quizTime).slice(0, 5) ? 'Current setting' : `Reminder at ${M.fmtTime(shiftHour(t, -1))}`,
      })),
    });
    return;
  }

  // The 8 PM template's "Start Quiz now" quick-reply arrives as a `button`
  // message. Tapping it reopens the 24h window AND starts today's quiz, from
  // whatever state the session is in.
  if (isStartQuiz(msg, text, id)) {
    if (ctx.isSubscribed) {
      await handleMenuChoice(session, mobile, ctx, 'start_quiz');
    } else {
      await wa.sendText(session.id, mobile,
        `Your subscription isn't active. Type *menu* to subscribe. 💎`);
    }
    return;
  }

  // A referral link pre-fills "JOIN ABC123", so the very first message a
  // referred parent sends carries the code. It is stashed on the session and
  // only acted on once they actually enrol — at this point there is no parent
  // record to attach it to. Falls through so the greeting still happens.
  {
    const referrals = require('../referrals/engine');
    const code = referrals.parseCode(text);
    if (code && !session.context?.referral_code) {
      const owner = await referrals.ownerOf(code).catch(() => null);

      // The owner tapping their OWN link. This is common — a parent tests the
      // link before sharing it — so it must be handled kindly, not with a
      // "someone invited you" message to yourself. Nothing is stashed, so the
      // code cannot later self-credit.
      if (owner && ctx.parentId && owner.id === ctx.parentId) {
        await wa.sendText(session.id, mobile,
          `😊 That's *your own* invite link — share it with another parent, not yourself!\n\n` +
          `When a friend joins with it, you *both* get free days. Type *menu* → *🎁 Refer a friend* for the message to forward.`);
        return;
      }

      // A genuine referral from someone else — stash it for enrolment.
      if (owner) {
        await mergeContext(session, { referral_code: code });
        const first = String(owner.parent_name || '').trim().split(/\s+/)[0] || 'A friend';
        await wa.sendText(session.id, mobile,
          `🎁 *${first} invited you to QuizPe!*\n\n` +
          `Start your free trial below. When you subscribe, you *both* get free days added.`);
      } else {
        // Unknown code — remember it anyway so a typo can be looked at later,
        // but say nothing; a stranger typing "JOIN" should not get an error.
        await mergeContext(session, { referral_code: code });
      }
    }
  }

  // "View plans" on an expiry template. Handled from ANY state, because these
  // templates reach parents whose session was last used days ago and may be
  // parked mid-flow. A renewing parent must not be dropped into a half-finished
  // signup, so the state is reset to the menu first.
  if (isViewPlans(msg, text, id)) {
    await setState(session, 'main_menu', 'view_plans_from_template');
    await handleMenuChoice(session, mobile, ctx, ctx.status === 'EXPIRED' ? 'renew' : 'view_plans');
    return;
  }

  // Global escapes — work from any state.
  if (isGreeting(text) || id === 'back_menu') {
    if (ctx.exists && session.state !== 'new') { await showMainMenu(session, mobile, ctx); return; }
    if (!ctx.exists) { await showWelcome(session, mobile); return; }
  }

  switch (session.state) {
    case 'new':
      await showWelcome(session, mobile);
      break;

    case 'welcome':
      if (id === 'agree_terms') {
        await recordConsent(session, session.context.terms_policy_id, mobile, msg.id, ctx.parentId);
        await setState(session, 'main_menu', 'agreed_terms');
        await showMainMenu(session, mobile, ctx);
      } else {
        await wa.sendText(session.id, mobile, 'Please tap *✅ Agree & Continue* to get started.');
      }
      break;

    case 'awaiting_payment':
      // A plan tap or "menu" can arrive while we wait for payment.
      if (id.startsWith('plan_')) { await handleMenuChoice(session, mobile, ctx, id); break; }
      if (ctx.isSubscribed) { await showMainMenu(session, mobile, ctx); break; }
      await handleMenuChoice(session, mobile, ctx, id || text);
      break;

    case 'main_menu':
    case 'in_quiz':
      // Answers can arrive in either state (the list stays tappable).
      if (id.startsWith('ans_')) { await handleAnswer(session, mobile, id); break; }
      if (id.startsWith('plan_')) { await handleMenuChoice(session, mobile, ctx, id); break; }
      // Typed answers: "B", "b)", "Option C" all work.
      if (session.state === 'in_quiz') {
        const typed = text.trim().match(/^(?:option\s*)?([ABCDabcd])\)?$/);
        if (typed && session.context.tracker_id) {
          const next = await Q.nextQuestion(Number(session.context.tracker_id));
          if (next) {
            await handleAnswer(session, mobile,
              `ans_${session.context.tracker_id}_${next.serial_number}_${typed[1].toUpperCase()}`);
            break;
          }
        }
      }
      await handleMenuChoice(session, mobile, ctx, id || text);
      break;

    case 'trial_terms':
      if (id === 'agree_trial') {
        await recordConsent(session, session.context.trial_policy_id, mobile, msg.id, ctx.parentId);

        // One short web form instead of a chain of questions.
        const { createSignupLink } = require('../routers/trialRouter');
        const { url } = await createSignupLink(session.id, mobile, session.context.parent_name);
        await setState(session, 'awaiting_form', 'agreed_trial');
        await wa.sendCtaUrl(session.id, mobile, {
          header: 'One quick form',
          body: `📝 *Almost done!*\n\nTap below to enter your child's name, board, medium, grade and state — takes about 30 seconds.`,
          displayText: '📝 Fill the form',
          url,
          footer: 'Secure · works for 60 minutes · single use',
        });
      } else {
        await wa.sendText(session.id, mobile, 'Tap *✅ Agree & Proceed* to continue, or *⬅️ Back* for the menu.');
      }
      break;

    case 'ask_student_name': {
      const name = text.replace(/[^\p{L}\p{N}\s.'-]/gu, '').trim().slice(0, 60);
      if (name.length < 2) {
        await wa.sendText(session.id, mobile, `That doesn't look like a name. Please type your child's name.`);
        break;
      }
      await mergeContext(session, { student_name: name });
      await askBoard(session, mobile);
      break;
    }

    case 'ask_board': {
      const code = id.startsWith('board_') ? id.slice(6) : text.toUpperCase();
      const ok = (await db.query(
        `SELECT 1 FROM boards WHERE board_code=$1 AND is_active`, [code])).rowCount;
      if (!ok) { await askBoard(session, mobile); break; }
      await mergeContext(session, { board_code: code });
      await askMediumOrSkip(session, mobile);
      break;
    }

    case 'ask_medium': {
      const code = id.startsWith('medium_') ? id.slice(7) : null;
      const ok = code && (await db.query(
        `SELECT 1 FROM mediums WHERE medium_code=$1 AND is_active`, [code])).rowCount;
      if (!ok) { await askMediumOrSkip(session, mobile); break; }
      await mergeContext(session, { medium_code: code });
      await askGrade(session, mobile);
      break;
    }

    case 'ask_grade': {
      let code = id.startsWith('grade_') ? id.slice(6) : null;
      if (!code) {
        const m = text.match(/(\d+)/);
        code = m ? `G${m[1]}` : null;
      }
      const ok = code && (await db.query(
        `SELECT 1 FROM grades WHERE grade_code=$1 AND is_active`, [code])).rowCount;
      if (!ok) { await askGrade(session, mobile); break; }
      await mergeContext(session, { grade_code: code });
      await askState(session, mobile);
      break;
    }

    case 'ask_state': {
      const { rows } = await db.query(
        `SELECT state_code, state_name FROM states_unions
          WHERE is_active AND lower(state_name) LIKE lower($1) || '%' LIMIT 5`, [text]);
      if (rows.length !== 1) {
        await wa.sendText(session.id, mobile, rows.length
          ? `Did you mean:\n${rows.map(r => `• ${r.state_name}`).join('\n')}\n\nPlease type the full state name.`
          : `I couldn't find that state. Please type your state name, e.g. *Karnataka*`);
        break;
      }
      const sub = await activateTrial(session, mobile, rows[0].state_code);
      const grade = (await db.query(
        `SELECT grade_name FROM grades WHERE grade_code=$1`, [session.context.grade_code])).rows[0];

      await require('./lifecycle').sendEnrolment({
        sessionId: session.id, mobile,
        parentName: session.context?.parent_name || 'there',
        students: [session.context.student_name],
        planName: 'Free Trial',
      });

      await wa.sendText(session.id, mobile, M.trialActivated({
        studentName: session.context.student_name,
        boardCode: session.context.board_code,
        gradeName: grade.grade_name,
        endDate: sub.plan_end_date,
        quizTime: sub.quiz_time,
      }));
      await setState(session, 'active', 'trial_activated', { subscription_id: sub.id });
      break;
    }

    case 'awaiting_feedback_text': {
      const txt = text.trim();
      const signOff = await nextQuizSignOff(ctx);
      if (/^(skip|no|nothing|none)$/i.test(txt) || !txt) {
        await wa.sendText(session.id, mobile, `👍 No problem — thank you!\n\n${signOff}`);
      } else {
        const { saveMessage } = require('./feedback');
        await saveMessage(session.context.feedback_id, txt);
        await wa.sendText(session.id, mobile,
          `🙏 Thank you — we've noted that. It genuinely helps us improve QuizPe.\n\n${signOff}`);
      }
      await setState(session, ctx.isSubscribed ? 'active' : 'main_menu', 'feedback_message');
      break;
    }

    case 'awaiting_form':
      // They messaged instead of filling the form — re-send a fresh link.
      if (ctx.isSubscribed) { await showMainMenu(session, mobile, ctx); break; }
      {
        const { createSignupLink } = require('../routers/trialRouter');
        const { url } = await createSignupLink(session.id, mobile, session.context.parent_name);
        await wa.sendCtaUrl(session.id, mobile, {
          body: `Here's your signup form again — tap below to finish setting up your child.\n\n_Type *menu* for other options._`,
          displayText: '📝 Fill the form',
          url,
          footer: 'Secure · valid for 60 minutes',
        });
      }
      break;

    case 'active':
    default:
      await showMainMenu(session, mobile, ctx);
  }
}

/** Show active paid plans — a text overview (with struck prices) + a selectable list. */
async function showPlans(session, mobile) {
  const plans = (await db.query(
    `SELECT plan_code, plan_name, price, comparable_price, student_count, duration
       FROM quizpe_plans WHERE is_active AND price > 0 ORDER BY price`)).rows;

  // Overview as TEXT so WhatsApp renders ~strikethrough~ on the old price.
  const overview = `💎 *QuizPe Premium Plans*\n\n${plans.map(p => {
    const off = Math.round((1 - Number(p.price) / Number(p.comparable_price)) * 100);
    return `*${p.plan_name}*\n` +
           `~₹${Number(p.comparable_price)}~  *₹${Number(p.price)}*  _(${off}% off)_\n` +
           `👦 ${p.student_count} child${p.student_count > 1 ? 'ren' : ''} · ${p.duration} days`;
  }).join('\n\n')}\n\n_All plans include daily quizzes, explanations, spiral revision & PDF report cards._`;
  await wa.sendText(session.id, mobile, overview);

  await wa.sendList(session.id, mobile, {
    header: '💎 Choose your plan',
    text: 'Tap a plan to continue to secure checkout.',
    buttonText: 'View plans',
    footer: 'Secure payment via Razorpay',
    rows: plans.map(p => ({
      id: `plan_${p.plan_code}`,
      title: `${p.plan_name} — ₹${Number(p.price)}`.slice(0, 24),
      description: `${p.student_count} child${p.student_count > 1 ? 'ren' : ''} · ${p.duration} days · ${Math.round((1 - Number(p.price) / Number(p.comparable_price)) * 100)}% off`,
    })),
  });
}

/** A plan was chosen — show the pay summary + secure checkout link. */
async function startCheckout(session, mobile, planCode) {
  const plan = (await db.query(
    `SELECT plan_name, price, comparable_price, student_count, duration
       FROM quizpe_plans WHERE plan_code=$1 AND is_active`, [planCode])).rows[0];
  if (!plan) { await showPlans(session, mobile); return; }

  const gst = (await db.query(`SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  const pct = gst ? Number(gst.gst_value) : 18;
  const gross = Number(plan.price);
  const base = (gross * 100 / (100 + pct)).toFixed(2);
  const tax = (gross - base).toFixed(2);

  const { createCheckoutLink } = require('../routers/paymentRouter');
  const { url } = await createCheckoutLink(session.id, mobile, planCode);
  await setState(session, 'awaiting_payment', 'chose_plan', { plan_code: planCode });

  await wa.sendCtaUrl(session.id, mobile, {
    header: `Payment summary`,
    body:
`🧾 *${plan.plan_name}*

Plan price (incl. GST): ₹${gross}
• Base: ₹${base}
• GST @ ${pct}%: ₹${tax}
👦 For ${plan.student_count} child${plan.student_count > 1 ? 'ren' : ''} · ${plan.duration} days

*Total payable: ₹${gross}*

Tap below to enter your child${plan.student_count > 1 ? 'ren\'s' : "'s"} details, accept the terms and pay securely.`,
    displayText: `💳 Pay ₹${gross}`,
    url,
    footer: 'Secure checkout via Razorpay · valid 30 minutes',
  });
}

async function handleMenuChoice(session, mobile, ctx, choice) {
  const students = await getStudents(ctx.parentId);

  if (String(choice).startsWith('plan_')) {
    await startCheckout(session, mobile, String(choice).slice(5));
    return;
  }

  // A specific child was picked from the multi-child quiz menu.
  if (String(choice).startsWith('child_')) {
    const kid = students.find(s => String(s.id) === String(choice).slice(6));
    if (kid) { await beginQuizFor(session, mobile, kid, students.length); return; }
  }

  switch (choice) {
    case 'start_quiz': {
      if (!students.length) {
        await wa.sendText(session.id, mobile, 'No child enrolled yet. Type *menu* to get started.');
        break;
      }
      // Multiple children -> let the parent choose whose quiz to take.
      if (students.length > 1) {
        await wa.sendList(session.id, mobile, {
          header: '▶️ Start quiz',
          text: 'Which child is taking the quiz now?',
          buttonText: 'Choose child',
          rows: students.map(s => ({ id: `child_${s.id}`, title: s.student_name.slice(0, 24),
            description: `${s.board_code} · ${s.grade_name}` })),
        });
        break;
      }
      await beginQuizFor(session, mobile, students[0], 1);
      break;
    }

    case 'start_trial':
      if (!ctx.canStartTrial) {
        await wa.sendText(session.id, mobile, ctx.trialUsed
          ? `You've already used your free trial. 💎 Here are our plans — from just ₹99.`
          : `You already have an active subscription. 🎉`);
        if (ctx.trialUsed) await showPlans(session, mobile);
        break;
      }
      await showTrialTerms(session, mobile);
      break;

    case 'renew':
    case 'subscribe':
    case 'view_plans':
      await showPlans(session, mobile);
      break;

    case 'my_subscription':
      await wa.sendText(session.id, mobile, await M.subscriptionDetails(ctx, students));
      break;

    case 'quiz_report': {
      const body = await M.quizReport(students);
      // no reports yet -> nothing to open, so no button
      if (!body.includes('Tap below')) { await wa.sendText(session.id, mobile, body); break; }
      await wa.sendCtaUrl(session.id, mobile, {
        body,
        displayText: '📥 Get reports',
        url: M.reportsPortalUrl(),
        footer: 'Protected by a one-time code',
      });
      break;
    }

    case 'quiz_schedule':
      await wa.sendText(session.id, mobile, M.quizSchedule(ctx, students));
      break;

    case 'refer_friend': {
      const referrals = require('../referrals/engine');
      const s = await referrals.summary(ctx.parentId);
      if (!s.enabled) {
        await wa.sendText(session.id, mobile, 'Referrals are not running at the moment.');
        break;
      }

      // Two messages on purpose. The second contains ONLY the invite text, so
      // a parent can forward it straight into a school group without having to
      // edit our explanation out of it first.
      const earned = s.rewarded > 0
        ? `\n\n✅ So far: *${s.rewarded}* friend${s.rewarded === 1 ? '' : 's'} subscribed · *${s.days_earned} free days* earned.`
        : s.joined > 0
          ? `\n\n👀 *${s.joined}* ${s.joined === 1 ? 'person has' : 'people have'} joined with your code — you get your days when they subscribe.`
          : '';

      await wa.sendText(session.id, mobile,
`🎁 *Give ${s.reward_days} days, get ${s.reward_days} days*

Share the message below with another parent. When they subscribe, *you both* get *${s.reward_days} free days* added to your plan.

Your code: *${s.code}*${earned}

_Forward the next message 👇_`);

      await wa.sendText(session.id, mobile,
`My child does a 10-question maths quiz every evening on WhatsApp — it arrives on its own, marks itself and sends a full report. It's called QuizPe. 📚

Try it free, and we both get ${s.reward_days} bonus days:
${s.link || `Message and send: JOIN ${s.code}`}`);
      break;
    }

    case 'support': {
      // A form, so every query arrives categorised and with a ticket number —
      // far better than "reply with your question" free text in chat.
      const { createSupportLink } = require('../routers/supportWebRouter');
      const { url } = await createSupportLink(session.id, mobile, ctx.parentId);
      const b = await M.business();
      await wa.sendCtaUrl(session.id, mobile, {
        header: 'Support',
        body: `💬 *We're here to help!*

Tap below to raise a request — pick what it's about, describe the issue, and you'll get a ticket number straight away.

📧 ${b.support_email}
🌐 ${b.product_website}`,
        displayText: '🛠️ Raise a request',
        url,
        footer: `${b.company_name}`,
      });
      break;
    }

    default:
      await showMainMenu(session, mobile, ctx);
  }
}

const QUIZ_TZ = process.env.TZ_NAME || 'Asia/Kolkata';

/** 'HH:MM' right now in the quiz timezone. */
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: QUIZ_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/**
 * Quizzes open at the subscription's quiz_time (20:00) and not a minute before,
 * so every child answers the same paper on the same schedule. Returns null when
 * the window is open, or the 'HH:MM' it opens at when it is not.
 */
async function quizTimeOf(studentId) {
  const { rows } = await db.query(
    `SELECT sub.quiz_time
       FROM students st
       JOIN parents_quizpe_subscriptions sub
         ON sub.parent_id = st.parent_id AND sub.is_active
      WHERE st.id = $1
      ORDER BY sub.id DESC LIMIT 1`, [studentId]);
  return rows.length ? String(rows[0].quiz_time).slice(0, 5) : null;
}

async function quizNotYetOpen(studentId) {
  const opensAt = await quizTimeOf(studentId);
  if (!opensAt) return null;                           // no subscription -> other checks handle it
  return nowHHMM() < opensAt ? opensAt : null;
}

/** Schedule + start today's quiz for one specific child. */
async function beginQuizFor(session, mobile, st, siblingCount) {
  try {
      // The quiz is available anywhere inside the evening window, not only at
      // this parent's notification slot. Their slot decides when we MESSAGE
      // them; the window decides when the child may ANSWER. Nothing is created
      // before the window opens — an early tap would consume today's questions
      // and the evening message would then announce a quiz already taken.
      const W = require('./quizWindow');
      const where = W.state();

      if (where === 'before') {
        const at = await quizTimeOf(st.id);
        await wa.sendText(session.id, mobile,
          `⏰ Tonight's quiz opens at *${M.fmtTime(W.OPEN_HHMM)}*.\n\n` +
          `${st.student_name} can take it any time after that, right up to *${M.fmtTime(W.CLOSE_HHMM)}*` +
          `${at ? ` — we'll nudge you at *${M.fmtTime(at)}*` : ''}. See you this evening! 🌙`);
        return;
      }

      if (where === 'closed') {
        const at = await quizTimeOf(st.id);
        await wa.sendText(session.id, mobile,
          `🌙 Tonight's quiz has closed (it stays open until *${M.fmtTime(W.CLOSE_HHMM)}*).\n\n` +
          `${st.student_name}'s next one opens tomorrow at *${M.fmtTime(W.OPEN_HHMM)}*` +
          `${at ? `, and we'll remind you around *${M.fmtTime(at)}*` : ''}. Sleep well! 😴`);
        return;
      }

      // The 8 PM job already creates today's trackers; this is the safety net
      // for anyone starting a quiz outside that path (menu, or a first quiz on
      // signup day). Idempotent, so calling it twice costs nothing.
      await Q.scheduleDailyQuizzes(st.id);

      const pending = await Q.pendingTrackers(st.id);
      if (!pending.length) {
        const at = await quizTimeOf(st.id);
        await wa.sendText(session.id, mobile,
          `✅ ${st.student_name} has finished all of today's quizzes. ` +
          `See you tomorrow${at ? ` at *${M.fmtTime(at)}*` : ''}! 🌙`);
        return;
      }

      const target = pending[0];
      const r = await Q.startQuiz(target.id);
      if (r.error || !r.trackerId) {
        console.error(`[flow] startQuiz failed: ${r.error} (tracker=${target.id}, student=${st.id})`);
        await wa.sendText(session.id, mobile,
          r.error === 'NO_QUESTIONS'
            ? `😕 No new ${target.subject_name} questions left for ${st.board_code} ${st.grade_name} this month. We're adding more soon!`
            : `😕 Sorry — we couldn't start the quiz. Please type *menu* and try again.`);
        return;
      }

      const q = await Q.nextQuestion(r.trackerId);
      if (!q) { await Q.finishQuiz(session.id, mobile, r.trackerId); return; }

      await mergeContext(session, { tracker_id: r.trackerId, student_id: st.id });
      await setState(session, 'in_quiz', r.resumed ? 'quiz_resumed' : 'quiz_started',
        { tracker_id: r.trackerId, subject: target.subject_code });

      const more = pending.length > 1
        ? `\n_${pending.length - 1} more subject${pending.length > 2 ? 's' : ''} after this._` : '';
      const isTest = target.quiz_type === 'test';
      const intro = r.resumed
        ? '_Resuming where you left off._'
        : `_${q.total} question${q.total === 1 ? '' : 's'}${isTest ? ' — today is a TEST 📝' : ', about 5 minutes'}._`;

      // The quiz runs on a web page: full option text (no 24-char truncation)
      // and the next question appears instantly on tap.
      const { createQuizLink } = require('../routers/quizWebRouter');
      const { url } = await createQuizLink(session.id, mobile, r.trackerId);
      await wa.sendCtaUrl(session.id, mobile, {
        header: `${st.student_name}'s ${isTest ? 'test' : 'quiz'}`,
        body: `📚 *${target.subject_name}*\n${intro}${more}\n\nTap below to begin — the score and report come straight back here.`,
        displayText: isTest ? '📝 Start test' : '▶️ Start quiz',
        url,
        footer: 'QuizPe by ServerPe App Solutions',
      });
  } catch (e) {
    console.error('[flow] beginQuizFor failed:', e.message);
    await wa.sendText(session.id, mobile, '😕 Sorry — we couldn\'t start the quiz. Please type *menu* and try again.');
  }
}

/** Warm closing line naming the next quiz time (falls back to 8 PM). */
async function nextQuizSignOff(ctx) {
  let t = '8:00 PM';
  try {
    if (ctx?.parentId) {
      const r = (await db.query(
        `SELECT quiz_time FROM parents_quizpe_subscriptions
          WHERE parent_id=$1 AND is_active ORDER BY id DESC LIMIT 1`, [ctx.parentId])).rows[0];
      if (r?.quiz_time) t = M.fmtTime(r.quiz_time);
    }
  } catch { /* default time */ }
  return `See you tomorrow at *${t}* for the next quiz! 🚀`;
}

function safeJson(s) {
  if (!s) return null;
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

/**
 * All signup fields arrive at once from the Flow form, so validate them
 * together and activate in a single step.
 */
async function handleFlowSubmission(session, mobile, data) {
  const studentName = String(data.student_name || '').trim().slice(0, 60);
  const board = String(data.board || '').trim();
  const medium = String(data.medium || 'ENGLISH').trim();
  const grade = String(data.grade || '').trim();
  const state = String(data.state || '').trim();

  const bad = [];
  if (studentName.length < 2) bad.push('child\'s name');
  if (!(await db.query(`SELECT 1 FROM boards  WHERE board_code=$1  AND is_active`, [board])).rowCount) bad.push('board');
  if (!(await db.query(`SELECT 1 FROM mediums WHERE medium_code=$1 AND is_active`, [medium])).rowCount) bad.push('medium');
  if (!(await db.query(`SELECT 1 FROM grades  WHERE grade_code=$1  AND is_active`, [grade])).rowCount) bad.push('grade');
  if (!(await db.query(`SELECT 1 FROM states_unions WHERE state_code=$1 AND is_active`, [state])).rowCount) bad.push('state');

  if (bad.length) {
    await wa.sendText(session.id, mobile,
      `⚠️ Could not read: *${bad.join(', ')}*. Type *menu* and try again.`);
    await setState(session, 'main_menu', 'flow_invalid', { invalid: bad });
    return;
  }

  await mergeContext(session,
    { student_name: studentName, board_code: board, medium_code: medium, grade_code: grade });

  const sub = await activateTrial(session, mobile, state);
  const gradeRow = (await db.query(`SELECT grade_name FROM grades WHERE grade_code=$1`, [grade])).rows[0];

  // Formal welcome first, then the detail. Silently skipped until Meta
  // approves the template, so the detail message below is never lost.
  await require('./lifecycle').sendEnrolment({
    sessionId: session.id, mobile,
    parentName: session.context?.parent_name || 'there',
    students: [studentName],
    planName: 'Free Trial',
  });

  await wa.sendText(session.id, mobile, M.trialActivated({
    studentName, boardCode: board, gradeName: gradeRow.grade_name,
    endDate: sub.plan_end_date, quizTime: sub.quiz_time,
  }));
  await setState(session, 'active', 'trial_activated', { subscription_id: sub.id, via: 'flow' });
}

/** Answer id format: ans_<trackerId>_<serial>_<letter> */
async function handleAnswer(session, mobile, id) {
  const [, trackerId, serial, letter] = id.split('_');
  const res = await Q.submitAnswer(session.id, mobile, Number(trackerId), Number(serial), letter);

  if (res.alreadyAnswered) {
    await wa.sendText(session.id, mobile, '_You already answered that one._');
  }

  const next = await Q.nextQuestion(Number(trackerId));
  if (next) {
    await Q.sendQuestion(session.id, mobile, Number(trackerId), next);
  } else {
    const score = await Q.finishQuiz(session.id, mobile, Number(trackerId));
    await setState(session, 'main_menu', 'quiz_completed', score);
  }
}

module.exports = { handleInbound, getOrCreateSession, extractText, extractId };
