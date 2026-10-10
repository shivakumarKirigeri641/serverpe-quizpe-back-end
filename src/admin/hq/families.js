/**
 * src/admin/hq/families.js — QuizPe's "customers" pages (user, 2026-10-05,
 * admin revamp phase 3): who to talk to now, one family's whole story, how
 * each child is doing day by day, and who asked us to stop.
 *
 * READ-ONLY: only SELECTs from QuizPe's database.
 */

const db = require('../../database/connectDB');

const IST = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);
const M10 = (col) => `right(regexp_replace(${col}, '\\D', '', 'g'), 10)`;
const ME = require('./notMe').mobile;

/*
 * HOT LEADS — QuizPe's version of GaadiPe's: families worth a word today.
 *   ending     on a free trial that ends within 2 days, never paid
 *   ended      trial ended in the last 14 days, never paid
 *   no_child   signed in on the app in the last 14 days but has no child enrolled
 *   was_paying a paid plan ended in the last 30 days, not renewed
 * WhatsApp is gone (2026-10-10): each says when they last opened the app and how
 * they can be reached — email, phone notifications, or neither.
 */
async function hotLeads() {
  const subs = `
    WITH sub AS (
      SELECT s.parent_id,
             max(s.plan_end_date) FILTER (WHERE pl.is_trial) AS trial_end,
             max(s.plan_end_date) FILTER (WHERE NOT pl.is_trial) AS paid_end,
             bool_or(NOT pl.is_trial) AS ever_paid,
             bool_or(CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date AND NOT pl.is_trial) AS paying
        FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
       WHERE s.is_active GROUP BY s.parent_id)`;
  const person = `
    p.id::text AS parent_id, p.parent_name AS name, p.parent_mobile_number AS mobile,
    (SELECT string_agg(st.student_name, ', ') FROM students st WHERE st.parent_id = p.id AND st.is_active) AS children,
    (SELECT max(w.last_seen_at) FROM parent_web_sessions w WHERE ${M10('w.mobile_number')} = ${M10('p.parent_mobile_number')}) AS last_app_visit,
    (coalesce(p.email, '') <> '') AS has_email,
    EXISTS (SELECT 1 FROM parent_push x WHERE ${M10('x.mobile_number')} = ${M10('p.parent_mobile_number')}) AS has_push,
    (SELECT count(*)::int FROM quizpe_tracker t JOIN quizpe_status q ON q.id = t.status_id JOIN students st ON st.id = t.student_id
      WHERE st.parent_id = p.id AND q.status_code = 'completed') AS quizzes_done`;
  const live = `p.is_active AND NOT p.service_paused AND ${ME('p.parent_mobile_number')}`;
  const [ending, ended, wasPaying, noChild] = await Promise.all([
    db.query(`${subs} SELECT ${person}, sub.trial_end AS at FROM parents p JOIN sub ON sub.parent_id = p.id
               WHERE ${live} AND NOT sub.ever_paid AND sub.trial_end BETWEEN CURRENT_DATE AND CURRENT_DATE + 2 ORDER BY sub.trial_end`),
    db.query(`${subs} SELECT ${person}, sub.trial_end AS at FROM parents p JOIN sub ON sub.parent_id = p.id
               WHERE ${live} AND NOT sub.ever_paid AND sub.trial_end BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE - 1 ORDER BY sub.trial_end DESC`),
    db.query(`${subs} SELECT ${person}, sub.paid_end AS at FROM parents p JOIN sub ON sub.parent_id = p.id
               WHERE ${live} AND sub.ever_paid AND NOT sub.paying AND sub.paid_end BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1 ORDER BY sub.paid_end DESC`),
    // Signed in on the app lately, but no child enrolled — the trial form was never finished.
    db.query(`SELECT p.id::text AS parent_id, coalesce(p.parent_name, '') AS name, w.m AS mobile, NULL AS children,
                     w.last_seen AS last_app_visit, (coalesce(p.email, '') <> '') AS has_email,
                     EXISTS (SELECT 1 FROM parent_push x WHERE ${M10('x.mobile_number')} = w.m) AS has_push,
                     0 AS quizzes_done, w.first_at AS at
                FROM (SELECT ${M10('mobile_number')} AS m, min(created_at) AS first_at, max(last_seen_at) AS last_seen
                        FROM parent_web_sessions WHERE ${ME('mobile_number')} GROUP BY 1) w
                LEFT JOIN parents p ON ${M10('p.parent_mobile_number')} = w.m
               WHERE w.last_seen > now() - interval '14 days'
                 AND (p.id IS NULL OR NOT EXISTS (SELECT 1 FROM students st WHERE st.parent_id = p.id AND st.is_active))
               ORDER BY w.last_seen DESC`),
  ]);
  const shape = (rows) => rows.map((r) => ({ ...r, masked: mask(r.mobile),
    reach: [r.has_email ? 'email' : null, r.has_push ? 'notifications' : null].filter(Boolean) }));
  const tabs = { ending: shape(ending.rows), ended: shape(ended.rows), was_paying: shape(wasPaying.rows), no_child: shape(noChild.rows) };
  return { tabs, counts: Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, v.length])) };
}

/* ─────────────── a family's whole story, newest first ─────────────── */

async function journey(parentId) {
  const { rows: [p] } = await db.query(
    `SELECT id::text AS id, parent_name AS name, parent_mobile_number AS mobile, created_at, service_paused, paused_at, state_code,
            email, deactivated_at, deactivated_reason, comeback_trial_at
       FROM parents WHERE id = $1`, [parentId]);
  if (!p) return null;
  const m = p.mobile;
  const events = [];
  const add = (rows, f) => rows.forEach((r) => events.push(f(r)));
  const [joined, subs, quizzes, pays, fb, tickets, sess, msgs] = await Promise.all([
    Promise.resolve({ rows: [p] }),
    db.query(`SELECT s.created_at, s.plan_start_date, s.plan_end_date, pl.plan_name, pl.is_trial FROM parents_quizpe_subscriptions s
               JOIN quizpe_plans pl ON pl.id = s.plan_id WHERE s.parent_id = $1`, [parentId]),
    db.query(`SELECT t.id, t.quiz_date, t.created_at, st.student_name, q.status_code, r.score_pct, sb.subject_name
                FROM quizpe_tracker t JOIN students st ON st.id = t.student_id JOIN quizpe_status q ON q.id = t.status_id
                LEFT JOIN quiz_reports r ON r.tracker_id = t.id LEFT JOIN subjects sb ON sb.id = t.subject_id
               WHERE st.parent_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [parentId]),
    db.query(`SELECT i.created_at, i.total::float AS total, i.invoice_id FROM invoices i
                JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id WHERE s.parent_id = $1 AND i.is_active`, [parentId]),
    db.query(`SELECT created_at, rating, left(coalesce(message, ''), 200) AS message FROM feedbacks WHERE parent_id = $1`, [parentId]),
    db.query(`SELECT created_at, ticket_no, status, left(coalesce(message, ''), 200) AS message FROM support_tickets WHERE parent_id = $1 OR mobile_number = $2`, [parentId, m]),
    // The app (2026-10-10), where the WhatsApp chat steps used to be: each sign-in and how it ended.
    db.query(`SELECT created_at, last_seen_at, ended_at, user_agent FROM parent_web_sessions
               WHERE ${M10('mobile_number')} = ${M10('$1')} ORDER BY created_at DESC LIMIT 200`, [m]),
    db.query(`SELECT count(*)::int AS signins, max(last_seen_at) AS last_visit,
                     (SELECT count(*)::int FROM parent_push x WHERE ${M10('x.mobile_number')} = ${M10('$1')}) AS push_devices
                FROM parent_web_sessions WHERE ${M10('mobile_number')} = ${M10('$1')}`, [m]),
  ]);
  add(joined.rows, (r) => ({ at: r.created_at, kind: 'joined', text: 'Joined QuizPe' }));
  add(subs.rows, (r) => ({ at: r.created_at, kind: r.is_trial ? 'trial' : 'plan', text: `${r.is_trial ? 'Free trial' : 'Plan'}: ${r.plan_name} · ${String(r.plan_start_date).slice(0, 10)} → ${String(r.plan_end_date).slice(0, 10)}` }));
  add(quizzes.rows, (r) => ({ at: r.created_at, kind: `quiz_${r.status_code}`, tracker_id: String(r.id),
    text: `${r.student_name} · ${r.subject_name || 'Quiz'} · ${r.status_code.replace(/_/g, ' ')}${r.score_pct != null ? ` · ${r.score_pct}%` : ''}` }));
  add(pays.rows, (r) => ({ at: r.created_at, kind: 'paid', text: `Paid ₹${r.total} · invoice ${r.invoice_id}` }));
  add(fb.rows, (r) => ({ at: r.created_at, kind: 'feedback', text: `Feedback${r.rating ? ` ${r.rating}★` : ''}${r.message ? ` — ${r.message}` : ''}` }));
  add(tickets.rows, (r) => ({ at: r.created_at, kind: 'support', text: `Support ${r.ticket_no} (${r.status})${r.message ? ` — ${r.message}` : ''}` }));
  const device = (ua) => (/iPhone|iPad/i.test(ua || '') ? 'iPhone' : /Android/i.test(ua || '') ? 'Android' : /Windows/i.test(ua || '') ? 'Windows' : /Mac/i.test(ua || '') ? 'Mac' : 'a browser');
  add(sess.rows, (r) => ({ at: r.created_at, kind: 'app', text: `Signed in on the app (${device(r.user_agent)})${r.ended_at ? ' · signed out later' : ''}` }));
  if (p.comeback_trial_at) events.push({ at: p.comeback_trial_at, kind: 'trial', text: 'Took the comeback offer (free days)' });
  if (p.deactivated_at) events.push({ at: p.deactivated_at, kind: 'stopped', text: `Deactivated the account${p.deactivated_reason ? ` — “${p.deactivated_reason}”` : ''}` });
  else if (p.service_paused) events.push({ at: p.paused_at, kind: 'stopped', text: 'Paused — no reminders from QuizPe' });
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  const a = msgs.rows[0] || {};
  return {
    parent: { ...p, masked: mask(m), mobile: undefined },
    app: { signins: a.signins || 0, last_visit: a.last_visit || null, push_devices: a.push_devices || 0, email: Boolean(p.email) },
    events: events.slice(0, 400),
  };
}

/* ─────────────── quizzes per child, per day ─────────────── */

/**
 * QuizPe's version of GaadiPe's "checks per customer": for each child and
 * day, how many quizzes went out, how many were finished, the score.
 * days: how many IST days back (1 = today); minMissed: only children who
 * missed at least this many.
 */
async function quizzesPerChild({ days = 1, minMissed = 0 } = {}) {
  const d = Math.min(90, Math.max(1, Number(days) || 1));
  const { rows } = await db.query(
    `SELECT t.quiz_date::text AS day, st.id::text AS student_id, st.student_name AS child, p.id::text AS parent_id, p.parent_name AS parent,
            g.grade_name AS grade,
            count(*)::int AS sent,
            count(*) FILTER (WHERE q.status_code = 'completed')::int AS completed,
            count(*) FILTER (WHERE q.status_code IN ('expired', 'skipped', 'idle_closed', 'closed'))::int AS missed,
            count(*) FILTER (WHERE q.status_code IN ('scheduled', 'delivered', 'yet_to_start', 'in_progress'))::int AS open,
            round(avg(r.score_pct))::int AS avg_score,
            string_agg(DISTINCT sb.subject_name, ', ') AS subjects
       FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id JOIN parents p ON p.id = st.parent_id
       JOIN quizpe_status q ON q.id = t.status_id
       LEFT JOIN grades g ON g.id = st.grade_id LEFT JOIN subjects sb ON sb.id = t.subject_id
       LEFT JOIN quiz_reports r ON r.tracker_id = t.id
      WHERE t.is_active AND t.quiz_date > CURRENT_DATE - $1::int
      GROUP BY 1, 2, 3, 4, 5, 6
     HAVING count(*) FILTER (WHERE q.status_code IN ('expired', 'skipped', 'idle_closed', 'closed')) >= $2
      ORDER BY 1 DESC, 7 DESC, 3`, [d, Math.max(0, Number(minMissed) || 0)]);
  const totals = {
    children: new Set(rows.map((r) => r.student_id)).size,
    sent: rows.reduce((a, r) => a + r.sent, 0),
    completed: rows.reduce((a, r) => a + r.completed, 0),
    missed: rows.reduce((a, r) => a + r.missed, 0),
  };
  return { days: d, totals, rows };
}

module.exports = { hotLeads, journey, quizzesPerChild };
