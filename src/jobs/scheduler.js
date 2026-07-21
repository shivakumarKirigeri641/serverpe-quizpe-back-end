/**
 * src/jobs/scheduler.js
 * ---------------------------------------------------------------------------
 * Daily WhatsApp jobs, checked every minute (IST):
 *
 *   reminder_time (default 19:00)  -> qp_quizstart_daily_v1  "quiz is at 8 PM"
 *   quiz_time     (default 20:00)  -> qp_quizstart_daily_v2  [▶️ Start Quiz now]
 *
 * Anti-annoyance rules:
 *   • max ONE of each kind per student per day (UNIQUE in notification_log)
 *   • never remind a student who already finished today's quiz
 *   • parents who replied STOP (reminders_enabled=false) get no reminders
 *   • a template that is not APPROVED in Meta is skipped, never sent
 * ---------------------------------------------------------------------------
 */

const cron = require('node-cron');
const db = require('../database/connectDB');
const wa = require('../whatsapp/client');
const Q = require('../whatsapp/quiz');
const { closeOutDay, CUTOFF_HHMM } = require('./dayCutoff');

const TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const BASE_SUBJECT = 'MATHS';
// How late a missed send may still go out (minutes). Beyond this the batch is
// abandoned for the day rather than surprising parents hours after the fact.
const CATCH_UP_MIN = Number(process.env.SCHEDULER_CATCHUP_MIN) || 20;
// How long after quiz_time before a skipped quiz is called missed. Long enough
// that a parent still mid-quiz is never accused of skipping.
const MISSED_AFTER_MIN = Number(process.env.MISSED_AFTER_MIN) || 90;

/** 'HH:MM' right now in the configured timezone. */
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/** Only send templates Meta has actually approved. */
async function approvedTemplate(name) {
  const { rows } = await db.query(
    `SELECT template_name, approval_status FROM whatsapp_templates
      WHERE template_name=$1 AND is_active`, [name]);
  if (!rows[0]) return null;
  return rows[0].approval_status === 'APPROVED' ? rows[0] : null;
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
        AND (EXTRACT(HOUR FROM s.${timeCol}) * 60 + EXTRACT(MINUTE FROM s.${timeCol}) + $5::int)
              BETWEEN $1::int - $4::int AND $1::int
        -- a missed-quiz nudge is never sent on the parent's very first day,
        -- when a skipped quiz is usually setup confusion rather than a skip
        AND ($2 <> 'quiz_missed' OR (CURRENT_DATE - s.plan_start_date) + 1 > 1)
        -- reminders respect the STOP opt-out; the quiz trigger always goes
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

async function logSend(row, kind, templateName, waId, error) {
  await db.query(
    `INSERT INTO notification_log (parent_id, student_id, mobile_number, kind, template_name,
                                   wa_message_id, status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (student_id, kind, send_date) DO NOTHING`,
    [row.parent_id, row.student_id, row.parent_mobile_number, kind, templateName,
     waId || null, error ? 'failed' : 'sent', error || null]);
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN',
  { day: '2-digit', month: 'short', year: 'numeric' });

const fmtTime = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** Send one job's batch, gently paced so we stay under Meta's rate limits. */
async function runJob(kind, templateName, offsetMin = 0) {
  const tpl = await approvedTemplate(templateName);
  if (!tpl) return;                                  // not approved yet -> skip silently

  const hhmm = nowHHMM();
  const due = await dueNow(kind, hhmm, offsetMin);
  if (!due.length) return;

  console.log(`[scheduler] ${kind} @${hhmm}: ${due.length} to send (${templateName})`);
  for (const row of due) {
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

      // v1/v2: parent, student, day, subject, start time
      // missed: student, parent, date, time, subject, day, questions, streak
      if (kind === 'quiz_missed') {
        try {
          row.streak = await require('../whatsapp/mastery').currentStreak(row.student_id);
        } catch { row.streak = 0; }
      }

      const params = kind === 'quiz_missed'
        ? [row.student_name, row.parent_name || 'there', fmtDate(row.quiz_date_label),
           fmtTime(row.quiz_time), row.subject_name, String(row.day_number),
           String(row.pending_questions || 10), `${row.streak || 0} days`]
        : [row.parent_name || 'there', row.student_name, String(row.day_number),
           row.subject_name, fmtTime(row.quiz_time)];
      const id = await wa.sendTemplate(row.session_id, row.parent_mobile_number, templateName, params);
      await logSend(row, kind, templateName, id, null);
    } catch (e) {
      console.error(`[scheduler] ${kind} failed for ${row.parent_mobile_number}: ${e.message}`);
      await logSend(row, kind, templateName, null, e.message);
    }
    await new Promise(r => setTimeout(r, 250));      // ~4 msg/sec
  }
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
    try {
      await runJob('reminder', 'qp_quizstart_daily_v1');
      await runJob('quiz_trigger', 'qp_quizstart_daily_v2');
      // a gentle nudge MISSED_AFTER_MIN after quiz time, only if still untouched
      await runJob('quiz_missed', 'qp_quiz_missed_daily_v1', MISSED_AFTER_MIN);

      // Hard stop for the day: settle every unfinished quiz and kill its link.
      if (nowHHMM() === CUTOFF_HHMM) await closeOutDay();
    } catch (e) {
      console.error('[scheduler] tick failed:', e.message);
    } finally {
      ticking = false;
    }
  }, { timezone: TZ });

  console.log(`[scheduler] started (${TZ}) — reminder=v1 @reminder_time, quiz trigger=v2 @quiz_time`);
}

module.exports = { startScheduler, runJob, dueNow, nowHHMM };
