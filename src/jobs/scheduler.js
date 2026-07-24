/**
 * src/jobs/scheduler.js
 * ---------------------------------------------------------------------------
 * Daily WhatsApp jobs, checked every minute (IST):
 *
 *   reminder_time (default 19:00)  -> qp_remainder_daily_v3 (falls back to v1)
 *   quiz_time     (default 20:00)  -> qp_quizstart_daily_v2  [▶️ Start Quiz now]
 *
 * Anti-annoyance rules:
 *   • max ONE of each kind per student per day (UNIQUE in notification_log)
 *   • never remind a student who already finished today's quiz
 *   • parents who replied STOP (service_paused) get nothing at all until START
 *   • a template that is not APPROVED in Meta is skipped, never sent
 * ---------------------------------------------------------------------------
 */

const cron = require('node-cron');
const db = require('../database/connectDB');
const wa = require('../whatsapp/client');
const Q = require('../whatsapp/quiz');
const { closeOutDay, CUTOFF_HHMM } = require('./dayCutoff');
const { sendAll } = require('./sendPool');

const TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const BASE_SUBJECT = 'MATHS';
// How late a missed send may still go out (minutes). Beyond this the batch is
// abandoned for the day rather than surprising parents hours after the fact.
const CATCH_UP_MIN = Number(process.env.SCHEDULER_CATCHUP_MIN) || 20;
// The quiz window runs to 23:45, so a "you have not started" nudge is timed to
// a FIXED point late in the evening rather than an offset from each parent's
// slot. Offsetting from the slot would tell a 19:15 parent they had missed it
// at 20:45, when in fact they still had three hours left.
// 21:30 deliberately: late enough that the parent has had their slot and a
// couple of hours to act, early enough that it is not a late-night buzz. It
// still leaves 2h15m of window, which is plenty for a 5-minute quiz. No
// unsolicited message from QuizPe goes out after this time.
const MISSED_AT_HHMM = process.env.MISSED_AT_HHMM || '21:30';
// Advisory-lock key so only one process anywhere runs a scheduler tick.
const SCHEDULER_LOCK = 918101;
// Preference order for the evening reminder. The first APPROVED one is used,
// so a newly created template takes over automatically once Meta clears it.
const REMINDER_TEMPLATES = ['qp_remainder_daily_v3', 'qp_quizstart_daily_v1'];
// Meta's business-initiated conversation limit for the 24h window. Set this to
// your current messaging limit; 0 disables the guard.
const WA_DAILY_CAP = Number(process.env.WA_DAILY_CAP) || 0;

/** 'HH:MM' right now in the configured timezone. */
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/**
 * The first APPROVED template from the preference list.
 *
 * Passing a list lets a new template take over the moment Meta approves it,
 * while the previous one keeps working until then — so swapping templates can
 * never leave an evening with no reminder going out at all.
 */
async function approvedTemplate(names) {
  const list = Array.isArray(names) ? names : [names];
  const { rows } = await db.query(
    `SELECT template_name, approval_status FROM whatsapp_templates
      WHERE template_name = ANY($1::text[]) AND is_active`, [list]);
  for (const name of list) {
    const hit = rows.find(r => r.template_name === name);
    if (hit && hit.approval_status === 'APPROVED') return hit;
  }
  return null;
}

/**
 * Everyone due at this HH:MM for a given job.
 * `kind` = 'reminder' (reminder_time) or 'quiz_trigger' (quiz_time).
 */
async function dueNow(kind, hhmm, offsetMin = 0) {
  const timeCol = kind === 'reminder' ? 'reminder_time' : 'quiz_time';
  // Match a WINDOW, not an exact minute. A tick that is skipped (previous run
  // still going) or missed (restart, clock hiccup) must not drop everyone
  // whose time fell in that minute — they get picked up on the next tick.
  // CATCH_UP_MIN caps how late a message may arrive, so a server started at
  // 11 PM never fires the 8 PM batch. Once-per-day is guaranteed by
  // notification_log, not by the exact time match.
  const [h, m] = hhmm.split(':').map(Number);
  const nowMin = h * 60 + m;

  // The "not started yet" nudge is not tied to anyone's slot — it goes out at
  // one fixed time for everyone still outstanding, late in the window.
  if (kind === 'quiz_missed') {
    const [mh, mm] = MISSED_AT_HHMM.split(':').map(Number);
    const target = mh * 60 + mm;
    if (nowMin < target || nowMin > target + CATCH_UP_MIN) return [];
  }

  const { rows } = await db.query(
    `SELECT st.id  AS student_id, st.student_name,
            p.id   AS parent_id, p.parent_name, p.parent_mobile_number,
            sub.subject_name,
            s.quiz_time,
            (CURRENT_DATE - s.plan_start_date) + 1 AS day_number,
            CURRENT_DATE AS quiz_date_label,
            -- questions still waiting in today's quiz, for the missed nudge
            COALESCE((SELECT COUNT(*)::int
                        FROM student_quizpe_histories h
                        JOIN quizpe_tracker t2 ON t2.id = h.tracker_id
                       WHERE t2.student_id = st.id AND t2.quiz_date = CURRENT_DATE
                         AND h.answered_option IS NULL),
                     (SELECT t3.question_count FROM quizpe_tracker t3
                       WHERE t3.student_id = st.id AND t3.quiz_date = CURRENT_DATE LIMIT 1),
                     10) AS pending_questions,
            w.id AS session_id
       FROM parents_quizpe_subscriptions s
       JOIN parents  p  ON p.id = s.parent_id AND p.is_active
       JOIN students st ON st.parent_id = p.id AND st.is_active
       JOIN subjects sub ON sub.subject_code = $3
       LEFT JOIN LATERAL (SELECT id FROM whatsapp_sessions x
                           WHERE x.mobile_number = p.parent_mobile_number AND x.is_active
                           ORDER BY x.id DESC LIMIT 1) w ON true
      WHERE s.is_active
        AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date
        -- reminder and quiz_trigger match the parent's own slot; quiz_missed
        -- was already gated on the clock above, so it matches everyone left
        AND ($2 = 'quiz_missed'
             OR (EXTRACT(HOUR FROM s.${timeCol}) * 60 + EXTRACT(MINUTE FROM s.${timeCol}) + $5::int)
                  BETWEEN $1::int - $4::int AND $1::int)
        -- a missed-quiz nudge is never sent on the parent's very first day,
        -- when a skipped quiz is usually setup confusion rather than a skip
        AND ($2 <> 'quiz_missed' OR (CURRENT_DATE - s.plan_start_date) + 1 > 1)
        -- STOP pauses EVERY outbound kind: reminder, quiz trigger and the
        -- missed-quiz nudge. A parent who asked for silence gets silence, and
        -- the only thing that lifts it is their own START.
        AND NOT p.service_paused
        AND ($2 <> 'reminder' OR p.reminders_enabled)
        -- one per student per kind per day
        AND NOT EXISTS (SELECT 1 FROM notification_log n
                         WHERE n.student_id = st.id AND n.kind = $2 AND n.send_date = CURRENT_DATE)
        -- never chase someone who already finished today
        AND NOT EXISTS (
              SELECT 1 FROM quizpe_tracker t
                JOIN quizpe_status qs ON qs.id = t.status_id
               WHERE t.student_id = st.id AND t.quiz_date = CURRENT_DATE
                 AND qs.status_code IN ('completed','closed'))`,
    [nowMin, kind, BASE_SUBJECT, CATCH_UP_MIN, offsetMin]);
  return rows;
}

/**
 * Reserve this student's slot for today BEFORE the message goes out.
 * Returns false if someone else already holds it — another instance, or this
 * instance before a restart. Claiming first is what makes the send safe to run
 * from more than one process: the UNIQUE (student_id, kind, send_date) decides
 * the winner, and only the winner calls Meta.
 */
async function claimSend(row, kind, templateName) {
  const { rowCount } = await db.query(
    `INSERT INTO notification_log (parent_id, student_id, mobile_number, kind, template_name, status)
     VALUES ($1,$2,$3,$4,$5,'sending')
     ON CONFLICT (student_id, kind, send_date) DO NOTHING`,
    [row.parent_id, row.student_id, row.parent_mobile_number, kind, templateName]);
  return rowCount > 0;
}

/** Fill in the outcome on the row we already claimed. */
async function finishSend(row, kind, waId, error) {
  await db.query(
    `UPDATE notification_log
        SET wa_message_id = $3, status = $4, error_message = $5
      WHERE student_id = $1 AND kind = $2 AND send_date = CURRENT_DATE`,
    [row.student_id, kind, waId || null, error ? 'failed' : 'sent', error || null]);
}

async function logSend(row, kind, templateName, waId, error) {
  await db.query(
    `INSERT INTO notification_log (parent_id, student_id, mobile_number, kind, template_name,
                                   wa_message_id, status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (student_id, kind, send_date) DO NOTHING`,
    [row.parent_id, row.student_id, row.parent_mobile_number, kind, templateName,
     waId || null, error ? 'failed' : 'sent', error || null]);
}

/* ------------------------------------------------- subscription lifecycle -- */
/**
 * Days before expiry on which a reminder goes out.
 *
 * A week's warning, a nudge at three days, then tomorrow and today. Each one
 * reads differently ("on 30th July" / "tomorrow" / "today"), so they escalate
 * rather than repeat.
 */
const EXPIRING_OFFSETS = [7, 3, 1, 0];
/** Days AFTER expiry for the one-and-only "it has ended" message. */
const EXPIRED_AFTER_DAYS = 1;
/** Both lifecycle notices go out mid-morning, not at quiz time. */
const LIFECYCLE_AT_HHMM = process.env.LIFECYCLE_AT_HHMM || '10:30';

/**
 * Parents whose plan is expiring or has expired.
 *
 * ONE ROW PER PARENT, not per child. A plan belongs to the parent, so a family
 * with three children must get one notice, not three — hence DISTINCT ON
 * (parent) with a representative student. That representative also makes the
 * existing UNIQUE (student_id, kind, send_date) dedupe per parent for free.
 */
async function lifecycleDue(kind) {
  const expiring = kind === 'expiring';
  const { rows } = await db.query(
    `SELECT DISTINCT ON (p.id)
            p.id AS parent_id, p.parent_name, p.parent_mobile_number,
            st.id AS student_id, st.student_name,
            s.plan_end_date, pl.plan_name,
            (s.plan_end_date - CURRENT_DATE)::int AS days_left,
            w.id AS session_id
       FROM parents_quizpe_subscriptions s
       JOIN parents p  ON p.id = s.parent_id AND p.is_active
       JOIN quizpe_plans pl ON pl.id = s.plan_id
       JOIN students st ON st.parent_id = p.id AND st.is_active
       LEFT JOIN LATERAL (SELECT id FROM whatsapp_sessions x
                           WHERE x.mobile_number = p.parent_mobile_number AND x.is_active
                           ORDER BY x.id DESC LIMIT 1) w ON true
      WHERE s.is_active
        AND NOT p.service_paused
        AND ${expiring
          ? `(s.plan_end_date - CURRENT_DATE) = ANY($1::int[])`
          : `(s.plan_end_date - CURRENT_DATE) = -$1::int`}
        -- Never chase someone who has already renewed past this period.
        AND NOT EXISTS (
          SELECT 1 FROM parents_quizpe_subscriptions s2
           WHERE s2.parent_id = p.id AND s2.plan_end_date > s.plan_end_date)
        ${expiring ? '' : `
        -- "Your plan has ended" is said ONCE, ever — not once a day. The
        -- per-day UNIQUE alone would repeat it every morning.
        AND NOT EXISTS (
          SELECT 1 FROM notification_log n
           WHERE n.parent_id = p.id AND n.kind = 'expired')`}
      ORDER BY p.id, st.id`,
    [expiring ? EXPIRING_OFFSETS : EXPIRED_AFTER_DAYS]);
  return rows;
}

/** Sends the expiring / expired templates. Skips silently until approved. */
async function runLifecycleJob(kind) {
  const hhmm = nowHHMM();
  const [th, tm] = LIFECYCLE_AT_HHMM.split(':').map(Number);
  const [nh, nm] = hhmm.split(':').map(Number);
  const target = th * 60 + tm;
  const now = nh * 60 + nm;
  if (now < target || now > target + CATCH_UP_MIN) return;

  const lifecycle = require('../whatsapp/lifecycle');
  const templateName = lifecycle.TEMPLATES[kind];
  if (!(await lifecycle.approved(templateName))) return;   // not cleared by Meta yet

  const due = await lifecycleDue(kind);
  for (const row of due) {
    if (!(await claimSend(row, kind, templateName))) continue;   // already sent today
    try {
      const res = kind === 'expiring'
        ? await lifecycle.sendExpiring({
            sessionId: row.session_id, mobile: row.parent_mobile_number,
            parentName: row.parent_name, planName: row.plan_name, endDate: row.plan_end_date })
        : await lifecycle.sendExpired({
            sessionId: row.session_id, mobile: row.parent_mobile_number,
            parentName: row.parent_name, planName: row.plan_name });
      await finishSend(row, kind, null, res.sent ? null : res.reason);
    } catch (e) {
      await finishSend(row, kind, null, e.message);
    }
    await new Promise((r) => setTimeout(r, 250));            // stay under Meta's rate limit
  }
  if (due.length) console.log(`[scheduler] ${kind}: ${due.length} parent(s)`);
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN',
  { day: '2-digit', month: 'short', year: 'numeric' });

const fmtTime = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

/**
 * The variable values for a template, in the order its Meta body expects.
 *
 * Templates are authored in Meta and each has its own placeholder count, so
 * this is the single place that maps our row data onto each one. Sending the
 * wrong number of values is the (#132000) "Number of parameters" error.
 */
function templateParams(templateName, row) {
  const student = row.student_name;
  const parent = row.parent_name || 'there';
  const day = String(row.day_number);
  const subject = row.subject_name;
  const time = fmtTime(row.quiz_time);

  switch (templateName) {
    // 4 placeholders: student, day, subject, start time (no parent name)
    case 'qp_remainder_daily_v3':
      return [student, day, subject, time];

    // 8 placeholders: the missed-quiz nudge
    case 'qp_quiz_missed_daily_v1':
      return [student, parent, fmtDate(row.quiz_date_label), time, subject, day,
              String(row.pending_questions || 10), `${row.streak || 0} days`];

    // 5 placeholders: parent, student, day, subject, start time (v1 and v2)
    default:
      return [parent, student, day, subject, time];
  }
}

/** Send one job's batch, gently paced so we stay under Meta's rate limits. */
async function runJob(kind, templateNames, offsetMin = 0) {
  const tpl = await approvedTemplate(templateNames);
  if (!tpl) return;                                  // none approved yet -> skip silently
  const templateName = tpl.template_name;

  const hhmm = nowHHMM();
  const due = await dueNow(kind, hhmm, offsetMin);
  if (!due.length) return;

  // Meta caps business-initiated conversations per 24h. Attempting sends past
  // it just produces failures, and repeated failures dent the quality rating
  // that decides the cap — so stop early and say so loudly.
  if (WA_DAILY_CAP) {
    const { rows: [c] } = await db.query(
      `SELECT COUNT(DISTINCT student_id)::int n FROM notification_log WHERE send_date = CURRENT_DATE`);
    if (c.n >= WA_DAILY_CAP) {
      console.error(`[scheduler] DAILY CAP REACHED (${c.n}/${WA_DAILY_CAP}) — ${due.length} ${kind} not sent. Raise WA_DAILY_CAP once Meta lifts your messaging limit.`);
      return;
    }
    if (c.n + due.length > WA_DAILY_CAP) {
      const room = WA_DAILY_CAP - c.n;
      console.warn(`[scheduler] only ${room} of ${due.length} ${kind} fit under today's cap`);
      due.length = room;
    }
  }

  console.log(`[scheduler] ${kind} @${hhmm}: ${due.length} to send (${templateName})`);

  const { count, seconds } = await sendAll(due, async (row) => {
    try {
      // At quiz time, create today's trackers BEFORE announcing the quiz, so
      // "Start Quiz now" always has something to open. Idempotent — the
      // (student, subject, day) UNIQUE makes a re-run a no-op.
      if (kind === 'quiz_trigger') {
        try {
          await Q.scheduleDailyQuizzes(row.student_id);
        } catch (e) {
          console.error(`[scheduler] tracker setup failed for student ${row.student_id}: ${e.message}`);
        }
      }

      if (kind === 'quiz_missed') {
        try {
          row.streak = await require('../whatsapp/mastery').currentStreak(row.student_id);
        } catch { row.streak = 0; }
      }

      // Each Meta template has its OWN placeholder count and order, so the
      // params must be built per TEMPLATE, not per kind. Sending the wrong
      // number is the (#132000) error — which is exactly what a 5-param reminder
      // hit against v3, whose real template has only 4.
      const params = templateParams(templateName, row);

      // claim first, send second — never the other way round
      if (!await claimSend(row, kind, templateName)) {
        console.log(`[scheduler] ${kind} for student ${row.student_id} already claimed — skipping`);
        return;
      }
      const id = await wa.sendTemplate(row.session_id, row.parent_mobile_number, templateName, params);
      await finishSend(row, kind, id, null);
    } catch (e) {
      console.error(`[scheduler] ${kind} failed for ${row.parent_mobile_number}: ${e.message}`);
      await finishSend(row, kind, null, e.message);
    }
  });

  console.log(`[scheduler] ${kind}: ${count} sent in ${seconds.toFixed(1)}s ` +
              `(${(count / Math.max(seconds, 0.001)).toFixed(1)}/sec)`);
}

let started = false;
function startScheduler() {
  if (started || process.env.SCHEDULER_ENABLED === '0') return;
  started = true;

  // every minute — the per-student/day UNIQUE makes re-runs harmless
  let ticking = false;
  cron.schedule('* * * * *', async () => {
    // With many parents a send run can outlast the minute (250ms apart, so
    // ~240 sends per minute). Skip overlapping ticks rather than starting a
    // second pass over people the first pass hasn't reached yet.
    if (ticking) { console.warn('[scheduler] previous tick still running — skipping'); return; }
    ticking = true;

    // A local flag only guards THIS process. On a host running several Node
    // processes every one of them would fire the same job, so take a Postgres
    // advisory lock: whoever gets it runs the tick, the rest do nothing.
    let lock = null;
    try {
      lock = await db.getClient();
      const { rows: [got] } = await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK]);
      if (!got.ok) { lock.release(); lock = null; ticking = false; return; }
    } catch (e) {
      if (lock) { lock.release(); lock = null; }
      ticking = false;
      console.error('[scheduler] could not take the tick lock:', e.message);
      return;
    }

    try {
      // prefer the new reminder template; fall back to v1 until it is approved
      await runJob('reminder', REMINDER_TEMPLATES);
      await runJob('quiz_trigger', 'qp_quizstart_daily_v2');
      // a gentle nudge MISSED_AFTER_MIN after quiz time, only if still untouched
      await runJob('quiz_missed', 'qp_quiz_missed_daily_v1');
      // plan expiry, mid-morning rather than at quiz time — a renewal decision
      // is made in daylight, not thirty seconds before the child sits down
      await runLifecycleJob('expiring');
      await runLifecycleJob('expired');

      // Hard stop for the day: settle every unfinished quiz and kill its link.
      if (nowHHMM() === CUTOFF_HHMM) await closeOutDay();
    } catch (e) {
      console.error('[scheduler] tick failed:', e.message);
    } finally {
      try {
        await lock.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK]);
      } catch { /* connection already gone; the lock dies with the session */ }
      lock.release();
      ticking = false;
    }
  }, { timezone: TZ });

  console.log(`[scheduler] started (${TZ}) — reminder=v1 @reminder_time, quiz trigger=v2 @quiz_time`);
}

module.exports = { startScheduler, runJob, dueNow, nowHHMM };
