/**
 * src/prepaid/alerts.js — PAY AS YOU ANSWER, PHASE 2 (user, 2026-10-28).
 * ---------------------------------------------------------------------------
 *   low balance   18:00 IST — a family whose balance has dropped to 20 MCQs or fewer: once per drop (again only
 *                 after a recharge). Phone notification + email (web/notify), never WhatsApp.
 *   expiry        10:00 IST, 30 and 7 days before 31 March — "N MCQs expire on 31 Mar". Phone + email.
 *   daily quiz    07:00 IST — the WhatsApp template qp_daily_reminder_v1, ONLY to parents who said yes
 *                 (parents.quiz_reminder_on). Skipped: a family with no balance and no plan, a day the parent
 *                 skipped, a student who already practised today, and after 3 reminders in a row with no tap.
 *                 A parent who wrote within the last 23 h 30 min gets our own message with 3 buttons instead (free).
 *                 Templates go only while WHATSAPP_MODE=on and the template is approved (whatsapp/client.js,
 *                 lifecycle.approved) — so nothing is sent during the replies-only weeks.
 *
 * SMS waits for the DLT templates. Each sweep runs once per day per family (dedupe columns on parents).
 * ---------------------------------------------------------------------------
 */
const db = require('../database/connectDB');
const W = require('./wallet');

const REMINDER_TEMPLATE = process.env.QUIZ_REMINDER_TEMPLATE || 'qp_daily_reminder_v1';
const LOW_AT = '18:00';
const EXPIRY_AT = '10:00';
const REMIND_AT = process.env.QUIZ_REMINDER_AT || '07:00';

const ran = new Map();   // once per day per job, per process (the scheduler tick holds a global lock)
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function due(job, hhmm, now) {
  const key = `${job}:${today()}`;
  // Within two hours of its time only: a restart at 3 PM must not send the 7 AM reminder.
  if (mins(now) < mins(hhmm) || mins(now) > mins(hhmm) + 120 || ran.get(job) === key) return false;
  ran.set(job, key);
  return true;
}

async function lowBalance() {
  const cfg = await W.config();
  const { rows } = await db.query(
    `SELECT p.id, p.parent_mobile_number AS mobile, b.left
       FROM parents p
       JOIN LATERAL (SELECT coalesce(sum(mcqs - used), 0)::int AS left, max(created_at) AS last_lot
                       FROM mcq_lots WHERE parent_id = p.id AND expires_at > now()) b ON true
      WHERE p.is_active AND NOT coalesce(p.service_paused, false)
        AND b.last_lot IS NOT NULL AND b.left <= $1
        AND (p.mcq_low_alert_at IS NULL OR p.mcq_low_alert_at < b.last_lot)
        AND EXISTS (SELECT 1 FROM mcq_lots l WHERE l.parent_id = p.id AND l.source <> 'free')`, [cfg.low_left]);
  for (const r of rows) {
    await require('../web/notify').toMobile(r.mobile, {
      title: r.left > 0 ? `QuizPe balance is low: ${r.left} MCQs left` : 'QuizPe balance is used up',
      body: 'Recharge to continue daily practice — ₹50 / ₹100 / ₹200 (+GST). Send "Recharge" on WhatsApp to +91 83173 19463.',
      tag: 'mcq-low',
    }).catch((e) => console.error('[mcq-alerts] low %s: %s', r.id, e.message));
    await db.query(`UPDATE parents SET mcq_low_alert_at = now() WHERE id = $1`, [r.id]);
  }
  return rows.length;
}

async function expiry() {
  const end = W.yearEnd();
  const daysLeft = Math.round((end - new Date(`${today()}T23:59:59+05:30`)) / 864e5);
  if (![30, 7].includes(daysLeft)) return 0;
  const mark = `${end.toISOString().slice(0, 4)}-${daysLeft}`;
  const { rows } = await db.query(
    `SELECT p.id, p.parent_mobile_number AS mobile, b.left
       FROM parents p
       JOIN LATERAL (SELECT coalesce(sum(mcqs - used), 0)::int AS left FROM mcq_lots
                      WHERE parent_id = p.id AND expires_at > now()) b ON true
      WHERE p.is_active AND b.left > 0 AND coalesce(p.mcq_expiry_alerted, '') <> $1`, [mark]);
  for (const r of rows) {
    await require('../web/notify').toMobile(r.mobile, {
      title: `${r.left} MCQs expire on 31 Mar`,
      body: `Dear Parent, ${r.left} MCQs in your QuizPe balance will expire on 31 Mar. Send Hi on WhatsApp to +91 83173 19463 to continue practice.`,
      tag: 'mcq-expiry',
    }).catch((e) => console.error('[mcq-alerts] expiry %s: %s', r.id, e.message));
    await db.query(`UPDATE parents SET mcq_expiry_alerted = $2 WHERE id = $1`, [r.id, mark]);
  }
  return rows.length;
}

async function dailyReminders() {
  const wa = require('../whatsapp/client');
  const lifecycle = require('../whatsapp/lifecycle');
  if (String(process.env.WHATSAPP_MODE || '').toLowerCase() !== 'on') return 0;     // replies-only weeks: nothing
  if (!(await lifecycle.approved(REMINDER_TEMPLATE).catch(() => false))) return 0;
  const { rows } = await db.query(
    `SELECT p.id, p.parent_name, p.parent_mobile_number AS mobile,
            (SELECT id FROM whatsapp_sessions s WHERE s.mobile_number = p.parent_mobile_number AND s.is_active ORDER BY id DESC LIMIT 1) AS session_id,
            (SELECT string_agg(split_part(st.student_name, ' ', 1), ' & ' ORDER BY st.id) FROM students st WHERE st.parent_id = p.id AND st.is_active) AS kids,
            -- 23 h 30 min, not 24: a margin so the free-form message never lands just outside Meta's window
            EXISTS (SELECT 1 FROM whatsapp_messages m
                     WHERE m.direction = 'inbound' AND right(m.mobile_number, 10) = right(p.parent_mobile_number, 10)
                       AND m.created_at > now() - interval '23 hours 30 minutes') AS in_window
       FROM parents p
      WHERE p.is_active AND p.quiz_reminder_on AND NOT coalesce(p.service_paused, false)
        AND coalesce(p.quiz_reminder_ignored, 0) < 3
        AND (p.quiz_reminder_skip_on IS NULL OR p.quiz_reminder_skip_on <> (now() AT TIME ZONE 'Asia/Kolkata')::date)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.mobile_number = p.parent_mobile_number AND s.opted_out)
        -- nobody in the family has practised today yet
        AND NOT EXISTS (SELECT 1 FROM quizpe_tracker t JOIN students st ON st.id = t.student_id
                         WHERE st.parent_id = p.id AND t.quiz_date = CURRENT_DATE
                           AND EXISTS (SELECT 1 FROM student_quizpe_histories h WHERE h.tracker_id = t.id AND h.answered_option IS NOT NULL))`);
  let sent = 0;
  for (const r of rows) {
    try {
      const bal = await W.balance(r.id);
      const onPlan = await W.onPlan(r.id);
      if (bal.left <= 0 && !onPlan) continue;                    // nothing to practise with: never a reminder
      const first = String(r.parent_name || 'Parent').trim().split(/\s+/)[0] || 'Parent';
      const kids = String(r.kids || 'your student');
      const names = kids.split(' & ').length > 3 ? `${kids.split(' & ').slice(0, 3).join(', ')} & ${kids.split(' & ').length - 3} more` : kids;
      // INSIDE THE 24-HOUR WINDOW, OUR OWN MESSAGE (user, 2026-10-31): a parent who wrote in the last ~24 h gets a
      // normal message with three buttons (free); only the others get the approved template.
      const id = r.in_window
        ? await wa.sendButtons(r.session_id, r.mobile,
          `🌅 Good morning ${first}! Today's practice for *${names}* is ready.\n\n💰 Balance: *${bal.left} MCQs*${onPlan ? ' · daily plan active' : ''}`,
          [{ id: 'start_quiz', title: '▶️ Start quiz' }, { id: 'rem_skip', title: 'Skip today' }, { id: 'rem_off', title: 'Stop reminders' }])
        : await wa.sendTemplate(r.session_id, r.mobile, REMINDER_TEMPLATE, [first, names, String(bal.left)]);
      if (id) {
        sent += 1;
        await db.query(`UPDATE parents SET quiz_reminder_ignored = coalesce(quiz_reminder_ignored, 0) + 1 WHERE id = $1`, [r.id]);
      }
    } catch (e) { console.error('[mcq-alerts] reminder %s: %s', r.id, e.message); }
  }
  return sent;
}

/** Called every scheduler tick with the IST "HH:MM". */
async function tick(now) {
  if (due('remind', REMIND_AT, now)) await dailyReminders().catch((e) => console.error('[mcq-alerts] reminders:', e.message));
  if (due('expiry', EXPIRY_AT, now)) await expiry().catch((e) => console.error('[mcq-alerts] expiry:', e.message));
  if (due('low', LOW_AT, now)) await lowBalance().catch((e) => console.error('[mcq-alerts] low:', e.message));
}

module.exports = { tick, lowBalance, expiry, dailyReminders, REMINDER_TEMPLATE };
