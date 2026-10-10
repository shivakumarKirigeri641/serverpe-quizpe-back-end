/**
 * src/admin/hq/insights.js — the Business Health home and the Graphs section
 * (user, 2026-10-05, admin revamp phase 2). QuizPe's own concept: families,
 * children, daily quizzes, a free trial and a paid plan.
 *
 * READ-ONLY: every function here only SELECTs from QuizPe's database.
 * Days are IST days; quiz_date is already one.
 */

const db = require('../../database/connectDB');
const shared = require('./shared');
/* THE WEBSITE, NOT WHATSAPP (user, 2026-10-10: "drop all WhatsApp contents and graphs, and
   start graphs in web in the QuizPe admin"). Families use quizpe.in/app; what is drawn is
   visits, sign-ins, the app's funnel, quizzes, money and how families are reached (email,
   phone notifications). The owner's own use is left out (hq/notMe.js). */
const ME = require('./notMe').mobile;
const M10 = (col) => `right(regexp_replace(${col}, '\\D', '', 'g'), 10)`;

const IST = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
const clampDays = (d, def = 30) => Math.min(365, Math.max(1, Number(d) || def));
const span = (days) => `SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day')::date AS d`;

/* Families by where they stand today: trial, paying, lapsed, never started. */
const STANDING = `
  WITH now_sub AS (
    SELECT s.parent_id,
           bool_or(pl.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS on_trial,
           bool_or(NOT pl.is_trial AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS paying,
           bool_or(NOT pl.is_trial) AS ever_paid,
           count(*) > 0 AS ever_sub
      FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
     WHERE s.is_active GROUP BY s.parent_id)`;

/* ───────────────────────────── Business Health (home) ───────────────────────────── */

async function home() {
  const { rows: [t] } = await db.query(`${STANDING}
    SELECT
      (SELECT count(*)::int FROM parents WHERE is_active) AS families,
      (SELECT count(*)::int FROM parents WHERE is_active AND ${IST('created_at')} = CURRENT_DATE) AS families_today,
      (SELECT count(*)::int FROM students WHERE is_active) AS children,
      (SELECT count(*)::int FROM parents p JOIN now_sub n ON n.parent_id = p.id WHERE p.is_active AND n.paying) AS paying,
      (SELECT count(*)::int FROM parents p JOIN now_sub n ON n.parent_id = p.id WHERE p.is_active AND n.on_trial AND NOT n.paying) AS on_trial,
      (SELECT count(*)::int FROM parents p JOIN now_sub n ON n.parent_id = p.id WHERE p.is_active AND NOT n.on_trial AND NOT n.paying) AS lapsed,
      (SELECT count(*)::int FROM parents WHERE is_active AND service_paused) AS stopped,
      (SELECT count(*)::int FROM quizpe_tracker WHERE quiz_date = CURRENT_DATE AND is_active) AS quizzes_today,
      (SELECT count(*)::int FROM quizpe_tracker t JOIN quizpe_status st ON st.id = t.status_id
        WHERE t.quiz_date = CURRENT_DATE AND st.status_code = 'completed') AS completed_today,
      (SELECT count(*)::int FROM quizpe_tracker t JOIN quizpe_status st ON st.id = t.status_id
        WHERE t.quiz_date = CURRENT_DATE - 1 AND st.status_code = 'completed') AS completed_yesterday,
      (SELECT count(*)::int FROM quizpe_tracker WHERE quiz_date = CURRENT_DATE - 1 AND is_active) AS quizzes_yesterday,
      (SELECT round(avg(r.score_pct))::int FROM quiz_reports r WHERE r.quiz_date = CURRENT_DATE) AS avg_score_today,
      (SELECT coalesce(sum(total), 0)::numeric FROM invoices WHERE is_active AND ${IST('created_at')} = CURRENT_DATE) AS revenue_today,
      (SELECT coalesce(sum(total), 0)::numeric FROM invoices WHERE is_active
        AND date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')) AS revenue_month,
      -- The website (2026-10-10), where WhatsApp chats used to be.
      (SELECT count(DISTINCT session_id)::int FROM site_visits WHERE NOT coalesce(is_bot, false) AND ${IST('created_at')} = CURRENT_DATE) AS visitors_today,
      (SELECT count(DISTINCT ${M10('mobile_number')})::int FROM parent_web_sessions WHERE ${IST('created_at')} = CURRENT_DATE AND ${ME('mobile_number')}) AS signins_today,
      (SELECT count(DISTINCT ${M10('mobile_number')})::int FROM parent_web_sessions
        WHERE ended_at IS NULL AND expires_at > now() AND last_seen_at > now() - interval '15 minutes' AND ${ME('mobile_number')}) AS on_app_now,
      (SELECT count(*)::int FROM support_tickets WHERE coalesce(status, 'open') = 'open') AS open_tickets,
      (SELECT round(avg(rating), 1)::numeric FROM feedbacks WHERE rating IS NOT NULL AND created_at > now() - interval '30 days') AS rating_30d`);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return {
    ...t,
    revenue_today: Number(t.revenue_today), revenue_month: Number(t.revenue_month),
    rating_30d: t.rating_30d === null ? null : Number(t.rating_30d),
    completion_today: pct(t.completed_today, t.quizzes_today),
    completion_yesterday: pct(t.completed_yesterday, t.quizzes_yesterday),
    paying_share: pct(t.paying, t.paying + t.on_trial + t.lapsed),
  };
}

/* ───────────────────────────── the Graphs pages ───────────────────────────── */

async function overview(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      (SELECT count(*)::int FROM parents WHERE is_active AND ${IST('created_at')} = span.d) AS families,
      (SELECT count(*)::int FROM quizpe_tracker t JOIN quizpe_status st ON st.id = t.status_id
        WHERE t.quiz_date = span.d AND st.status_code = 'completed') AS completed,
      (SELECT count(*)::int FROM quizpe_tracker WHERE quiz_date = span.d AND is_active) AS quizzes,
      (SELECT coalesce(sum(total), 0)::float FROM invoices WHERE is_active AND ${IST('created_at')} = span.d) AS revenue,
      (SELECT count(DISTINCT session_id)::int FROM site_visits WHERE NOT coalesce(is_bot, false) AND ${IST('created_at')} = span.d) AS visitors,
      (SELECT count(DISTINCT ${M10('mobile_number')})::int FROM parent_web_sessions WHERE ${IST('created_at')} = span.d AND ${ME('mobile_number')}) AS signins
      FROM span ORDER BY span.d`, [days]);
  return { series: rows };
}

/*
 * THE APP'S FUNNEL, for the period: visited quizpe.in → asked for a sign-in code →
 * signed in → started the free trial → a child finished a quiz → paid. People, not
 * events: browsers for the visit, mobiles after that.
 */
async function funnel(days) {
  const since = `now() - make_interval(days => $1::int)`;
  const { rows: [f] } = await db.query(`
    WITH signed AS (SELECT DISTINCT ${M10('mobile_number')} AS m FROM parent_web_sessions WHERE created_at > ${since} AND ${ME('mobile_number')})
    SELECT
      (SELECT count(DISTINCT session_id)::int FROM site_visits WHERE NOT coalesce(is_bot, false) AND created_at > ${since}) AS visited,
      (SELECT count(DISTINCT session_id)::int FROM site_visits WHERE NOT coalesce(is_bot, false) AND created_at > ${since} AND path LIKE '/app%') AS opened_app,
      (SELECT count(DISTINCT ${M10('mobile_number')})::int FROM parent_web_codes WHERE created_at > ${since} AND ${ME('mobile_number')}) AS asked_code,
      (SELECT count(*)::int FROM signed) AS signed_in,
      (SELECT count(DISTINCT s.parent_id)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
         JOIN parents p ON p.id = s.parent_id
        WHERE pl.is_trial AND s.created_at > ${since} AND ${ME('p.parent_mobile_number')}) AS trial,
      (SELECT count(DISTINCT p.id)::int FROM parents p JOIN signed ON signed.m = ${M10('p.parent_mobile_number')}
        WHERE EXISTS (SELECT 1 FROM quizpe_tracker t JOIN students st ON st.id = t.student_id JOIN quizpe_status qs ON qs.id = t.status_id
                       WHERE st.parent_id = p.id AND qs.status_code = 'completed' AND t.created_at > ${since})) AS quizzed,
      (SELECT count(DISTINCT s.parent_id)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
         JOIN parents p ON p.id = s.parent_id
        WHERE NOT pl.is_trial AND s.created_at > ${since} AND ${ME('p.parent_mobile_number')}) AS paid`, [days]);
  const STEPS = [
    ['visited', 'Visited quizpe.in'], ['opened_app', 'Opened the app page'], ['asked_code', 'Asked for a sign-in code'],
    ['signed_in', 'Signed in'], ['trial', 'Started the free trial'], ['quizzed', 'A child finished a quiz'], ['paid', 'Paid for a plan'],
  ];
  const top = f.visited || 0;
  let prev = null;
  const steps = STEPS.map(([k, label]) => {
    const count = f[k] || 0;
    const out = { key: k, label, count, pct_of_top: top ? Math.round((count / top) * 1000) / 10 : 0,
      drop_from_prev: prev ? Math.round(((count - prev) / prev) * 1000) / 10 : null };
    prev = count || prev;
    return out;
  });
  return { steps };
}

async function money(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      coalesce(sum(i.total), 0)::float AS revenue,
      coalesce(sum(i.amount_base), 0)::float AS taxable,
      coalesce(sum(coalesce(i.cgst, 0) + coalesce(i.sgst, 0) + coalesce(i.igst, 0)), 0)::float AS gst,
      count(i.id)::int AS invoices
      FROM span LEFT JOIN invoices i ON i.is_active AND ${IST('i.created_at')} = span.d
     GROUP BY span.d ORDER BY span.d`, [days]);
  const { rows: plans } = await db.query(`
    SELECT pl.plan_name AS plan, count(i.id)::int AS invoices, coalesce(sum(i.total), 0)::float AS revenue
      FROM invoices i JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id JOIN quizpe_plans pl ON pl.id = s.plan_id
     WHERE i.is_active AND i.created_at > now() - make_interval(days => $1::int)
     GROUP BY pl.plan_name ORDER BY 3 DESC`, [days]).catch(() => ({ rows: [] }));
  return { series: rows, by_plan: plans };
}

async function families(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      (SELECT count(*)::int FROM parents WHERE is_active AND ${IST('created_at')} = span.d) AS joined,
      -- First sign-in on the app that day (2026-10-10), where "replied STOP" used to be.
      (SELECT count(*)::int FROM (SELECT ${M10('mobile_number')} AS m, min(created_at) AS first_at FROM parent_web_sessions
                                   WHERE ${ME('mobile_number')} GROUP BY 1) f WHERE ${IST('f.first_at')} = span.d) AS first_signin,
      (SELECT count(*)::int FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
        WHERE s.is_active AND NOT pl.is_trial AND ${IST('s.created_at')} = span.d) AS paid_plans
      FROM span ORDER BY span.d`, [days]);
  const { rows: [standing] } = await db.query(`${STANDING}
    SELECT count(*) FILTER (WHERE n.paying)::int AS paying,
           count(*) FILTER (WHERE n.on_trial AND NOT n.paying)::int AS on_trial,
           count(*) FILTER (WHERE NOT n.on_trial AND NOT n.paying AND n.ever_paid)::int AS was_paying,
           count(*) FILTER (WHERE NOT n.on_trial AND NOT n.paying AND NOT n.ever_paid)::int AS trial_ended,
           count(*) FILTER (WHERE n.parent_id IS NULL)::int AS never_started
      FROM parents p LEFT JOIN now_sub n ON n.parent_id = p.id WHERE p.is_active`);
  const { rows: states } = await db.query(`
    SELECT coalesce(su.state_name, nullif(p.state_code, ''), '—') AS state, count(*)::int AS families
      FROM parents p LEFT JOIN states_unions su ON su.state_code = p.state_code
     WHERE p.is_active GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
  const { rows: boards } = await db.query(`
    SELECT b.board_name AS board, g.grade_name AS grade, count(*)::int AS children
      FROM students s LEFT JOIN boards b ON b.id = s.board_id LEFT JOIN grades g ON g.id = s.grade_id
     WHERE s.is_active GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`).catch(() => ({ rows: [] }));
  return { series: rows, standing, states, boards };
}

async function quizzes(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      count(t.id)::int AS sent,
      count(t.id) FILTER (WHERE st.status_code = 'completed')::int AS completed,
      count(t.id) FILTER (WHERE st.status_code IN ('expired', 'skipped', 'idle_closed', 'closed'))::int AS missed,
      count(t.id) FILTER (WHERE st.status_code = 'failed')::int AS failed,
      round(avg(r.score_pct))::int AS avg_score
      FROM span
      LEFT JOIN quizpe_tracker t ON t.quiz_date = span.d AND t.is_active
      LEFT JOIN quizpe_status st ON st.id = t.status_id
      LEFT JOIN quiz_reports r ON r.tracker_id = t.id
     GROUP BY span.d ORDER BY span.d`, [days]);
  const { rows: byGrade } = await db.query(`
    SELECT coalesce(g.grade_name, '—') AS grade,
           count(t.id)::int AS sent,
           count(t.id) FILTER (WHERE st.status_code = 'completed')::int AS completed,
           round(avg(r.score_pct))::int AS avg_score
      FROM quizpe_tracker t
      JOIN quizpe_status st ON st.id = t.status_id
      JOIN students s ON s.id = t.student_id LEFT JOIN grades g ON g.id = s.grade_id
      LEFT JOIN quiz_reports r ON r.tracker_id = t.id
     WHERE t.is_active AND t.quiz_date > CURRENT_DATE - $1::int
     GROUP BY 1 ORDER BY 1`, [days]).catch(() => ({ rows: [] }));
  const { rows: bySubject } = await db.query(`
    SELECT coalesce(sb.subject_name, '—') AS subject,
           count(t.id)::int AS sent,
           count(t.id) FILTER (WHERE st.status_code = 'completed')::int AS completed,
           round(avg(r.score_pct))::int AS avg_score
      FROM quizpe_tracker t JOIN quizpe_status st ON st.id = t.status_id
      LEFT JOIN subjects sb ON sb.id = t.subject_id LEFT JOIN quiz_reports r ON r.tracker_id = t.id
     WHERE t.is_active AND t.quiz_date > CURRENT_DATE - $1::int
     GROUP BY 1 ORDER BY 2 DESC`, [days]).catch(() => ({ rows: [] }));
  return { series: rows, by_grade: byGrade, by_subject: bySubject };
}

/*
 * THE WEBSITE: visitors and page visits, sign-in codes asked for and used, families
 * signing in (and for the first time), on phones or computers, the pages people open
 * and where they come from.
 */
const deviceSql = (ua) => `CASE WHEN ${ua} ~* 'iphone|ipad' THEN 'iPhone / iPad' WHEN ${ua} ~* 'android' THEN 'Android'
  WHEN ${ua} ~* 'windows' THEN 'Windows' WHEN ${ua} ~* 'mac os|macintosh' THEN 'Mac' ELSE 'Other' END`;
async function website(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()}),
         firsts AS (SELECT ${M10('mobile_number')} AS m, min(created_at) AS first_at FROM parent_web_sessions WHERE ${ME('mobile_number')} GROUP BY 1)
    SELECT span.d::text AS d,
      (SELECT count(DISTINCT session_id)::int FROM site_visits WHERE NOT coalesce(is_bot, false) AND ${IST('created_at')} = span.d) AS visitors,
      (SELECT count(*)::int FROM site_visits WHERE NOT coalesce(is_bot, false) AND kind = 'view' AND ${IST('created_at')} = span.d) AS page_views,
      (SELECT count(*)::int FROM parent_web_codes WHERE ${IST('created_at')} = span.d AND ${ME('mobile_number')}) AS codes,
      (SELECT count(*)::int FROM parent_web_codes WHERE ${IST('created_at')} = span.d AND consumed_at IS NOT NULL AND attempts < 5 AND ${ME('mobile_number')}) AS codes_used,
      (SELECT count(DISTINCT ${M10('mobile_number')})::int FROM parent_web_sessions WHERE ${IST('created_at')} = span.d AND ${ME('mobile_number')}) AS signins,
      (SELECT count(*)::int FROM firsts WHERE ${IST('first_at')} = span.d) AS first_signins
      FROM span ORDER BY span.d`, [days]);
  const since = `now() - make_interval(days => $1::int)`;
  const [devices, pages, sources] = await Promise.all([
    db.query(`SELECT ${deviceSql('user_agent')} AS device, count(DISTINCT ${M10('mobile_number')})::int AS families, count(*)::int AS signins
                FROM parent_web_sessions WHERE created_at > ${since} AND ${ME('mobile_number')} GROUP BY 1 ORDER BY 2 DESC`, [days]),
    db.query(`SELECT coalesce(nullif(split_part(path, '?', 1), ''), '/') AS page, count(*)::int AS views, count(DISTINCT session_id)::int AS visitors
                FROM site_visits WHERE NOT coalesce(is_bot, false) AND kind = 'view' AND created_at > ${since}
               GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [days]),
    db.query(`SELECT CASE WHEN coalesce(referrer, '') = '' THEN 'Direct / app'
                          WHEN referrer ~* 'google\\.' THEN 'Google' WHEN referrer ~* 'facebook|fb\\.|instagram' THEN 'Facebook / Instagram'
                          WHEN referrer ~* 'youtube' THEN 'YouTube' WHEN referrer ~* 'quizpe\\.in' THEN 'Within quizpe.in'
                          ELSE regexp_replace(referrer, '^https?://([^/]+).*$', '\\1') END AS source,
                     count(DISTINCT session_id)::int AS visitors
                FROM site_visits WHERE NOT coalesce(is_bot, false) AND created_at > ${since}
               GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [days]),
  ]);
  return { series: rows, devices: devices.rows, pages: pages.rows, sources: sources.rows };
}

/*
 * HOW FAMILIES ARE REACHED (no WhatsApp): who has an email, who allowed phone
 * notifications on the app, who neither — and the reminders sent to them, by day.
 */
async function reach(days) {
  const { rows: [now] } = await db.query(`
    WITH fam AS (
      SELECT p.id, (coalesce(p.email, '') <> '') AS email,
             EXISTS (SELECT 1 FROM parent_push x WHERE ${M10('x.mobile_number')} = ${M10('p.parent_mobile_number')}) AS push
        FROM parents p WHERE p.is_active AND ${ME('p.parent_mobile_number')})
    SELECT count(*) FILTER (WHERE email AND push)::int AS both,
           count(*) FILTER (WHERE email AND NOT push)::int AS email_only,
           count(*) FILTER (WHERE push AND NOT email)::int AS push_only,
           count(*) FILTER (WHERE NOT email AND NOT push)::int AS neither
      FROM fam`);
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      (SELECT count(*)::int FROM notification_log n WHERE n.send_date = span.d AND n.template_name = 'web' AND n.status = 'sent') AS sent,
      (SELECT count(*)::int FROM notification_log n WHERE n.send_date = span.d AND n.template_name = 'web' AND n.status = 'failed') AS not_reached,
      (SELECT count(*)::int FROM parent_push x WHERE ${IST('x.created_at')} = span.d AND ${ME('x.mobile_number')}) AS new_push
      FROM span ORDER BY span.d`, [days]);
  const { rows: kinds } = await db.query(`
    SELECT n.kind, count(*) FILTER (WHERE n.status = 'sent')::int AS sent, count(*) FILTER (WHERE n.status = 'failed')::int AS not_reached
      FROM notification_log n WHERE n.template_name = 'web' AND n.send_date > CURRENT_DATE - $1::int
     GROUP BY 1 ORDER BY 2 DESC`, [days]);
  return { now, series: rows, kinds };
}

async function services(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      count(j.id) FILTER (WHERE j.status = 'done' OR j.status = 'completed')::int AS jobs_ok,
      count(j.id) FILTER (WHERE j.status = 'failed')::int AS jobs_failed,
      (SELECT count(*)::int FROM notification_log n WHERE n.send_date = span.d AND n.template_name = 'web' AND n.status = 'failed') AS sends_failed,
      (SELECT count(*)::int FROM notification_log n WHERE n.send_date = span.d AND n.template_name = 'web') AS scheduled_sends
      FROM span LEFT JOIN job_queue j ON ${IST('j.created_at')} = span.d
     GROUP BY span.d ORDER BY span.d`, [days]).catch(() => ({ rows: [] }));
  // Not WhatsApp, Meta or the shared limit — the website's own services (2026-10-10).
  const status = (await shared.status()).filter((s) => !/whatsapp|meta|limit|peer/i.test(`${s.key} ${s.label}`));
  return { series: rows, status };
}

const PAGES = { overview, website, funnel, families, quizzes, money, reach, services };

async function page(name, days) {
  const fn = PAGES[name];
  if (!fn) return null;
  return { page: name, days: clampDays(days), ...(await fn(clampDays(days))) };
}

/* ─────────────────────────── tap a day: who / what ─────────────────────────── */

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);
const IST_DAY = (t) => new Date(new Date(t).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function drill(kind, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
  if (kind === 'families') {
    const { rows } = await db.query(
      `SELECT p.id::text AS id, p.parent_name AS name, p.parent_mobile_number AS mobile, p.state_code AS state, p.created_at,
              (SELECT string_agg(s.student_name, ', ') FROM students s WHERE s.parent_id = p.id AND s.is_active) AS children
         FROM parents p WHERE p.is_active AND ${IST('p.created_at')} = $1::date ORDER BY p.created_at`, [day]);
    return rows.map((r) => ({ ...r, masked: mask(r.mobile) }));
  }
  if (kind === 'quizzes') {
    const { rows } = await db.query(
      `SELECT t.id::text AS id, s.student_name AS child, p.parent_name AS parent, p.id::text AS parent_id,
              sb.subject_name AS subject, st.status_code AS status, r.score_pct AS score, t.quiz_slot AS slot
         FROM quizpe_tracker t JOIN students s ON s.id = t.student_id JOIN parents p ON p.id = s.parent_id
         JOIN quizpe_status st ON st.id = t.status_id LEFT JOIN subjects sb ON sb.id = t.subject_id
         LEFT JOIN quiz_reports r ON r.tracker_id = t.id
        WHERE t.is_active AND t.quiz_date = $1::date ORDER BY st.status_code, s.student_name LIMIT 500`, [day]);
    return rows;
  }
  if (kind === 'money') {
    const { rows } = await db.query(
      `SELECT i.id::text AS id, i.invoice_id AS number, i.total::float AS total, i.created_at, p.parent_name AS parent, p.id::text AS parent_id, pl.plan_name AS plan
         FROM invoices i LEFT JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id
         LEFT JOIN parents p ON p.id = s.parent_id LEFT JOIN quizpe_plans pl ON pl.id = s.plan_id
        WHERE i.is_active AND ${IST('i.created_at')} = $1::date ORDER BY i.created_at`, [day]);
    return rows;
  }
  // Who signed in on the app that day (2026-10-10), where WhatsApp templates used to be.
  if (kind === 'signins') {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (${M10('w.mobile_number')}) w.id::text AS id, ${M10('w.mobile_number')} AS mobile, w.created_at, w.user_agent,
              p.id::text AS parent_id, p.parent_name AS name,
              (SELECT min(x.created_at) FROM parent_web_sessions x WHERE ${M10('x.mobile_number')} = ${M10('w.mobile_number')}) AS first_at
         FROM parent_web_sessions w
         LEFT JOIN parents p ON ${M10('p.parent_mobile_number')} = ${M10('w.mobile_number')}
        WHERE ${IST('w.created_at')} = $1::date AND ${ME('w.mobile_number')}
        ORDER BY ${M10('w.mobile_number')}, w.created_at LIMIT 500`, [day]);
    return rows.map((r) => ({ ...r, masked: mask(r.mobile), mobile: undefined,
      first_time: r.first_at && IST_DAY(r.first_at) === day }));
  }
  // Reminders sent on the app / by email that day.
  if (kind === 'reach') {
    const { rows } = await db.query(
      `SELECT n.id::text AS id, n.kind, n.status, n.error_message AS error, n.created_at, n.mobile_number AS mobile,
              st.student_name AS child, p.parent_name AS parent, p.id::text AS parent_id
         FROM notification_log n LEFT JOIN students st ON st.id = n.student_id LEFT JOIN parents p ON p.id = n.parent_id
        WHERE n.template_name = 'web' AND n.send_date = $1::date
        ORDER BY (n.status = 'failed') DESC, n.created_at LIMIT 500`, [day]);
    return rows.map((r) => ({ ...r, masked: mask(r.mobile), mobile: undefined }));
  }
  return null;
}

module.exports = { home, page, drill, PAGES: Object.keys(PAGES) };
