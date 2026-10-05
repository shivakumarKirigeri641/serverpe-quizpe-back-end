/**
 * src/admin/hq/insights.js — the Business Health home and the Graphs section
 * (user, 2026-10-05, admin revamp phase 2). QuizPe's own concept: families,
 * children, daily quizzes, a free trial and a paid plan.
 *
 * READ-ONLY: every function here only SELECTs from QuizPe's database.
 * Days are IST days; quiz_date is already one.
 */

const db = require('../../database/connectDB');
const metrics = require('../metrics');
const shared = require('./shared');

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
      (SELECT count(DISTINCT mobile_number)::int FROM whatsapp_messages WHERE direction = 'inbound' AND ${IST('created_at')} = CURRENT_DATE) AS chats_today,
      (SELECT count(*)::int FROM support_tickets WHERE coalesce(status, 'open') = 'open') AS open_tickets,
      (SELECT round(avg(rating), 1)::numeric FROM feedbacks WHERE rating IS NOT NULL AND created_at > now() - interval '30 days') AS rating_30d`);
  const limit = await shared.waLimit();
  const meta = await shared.metaStatus().catch(() => ({ ok: false }));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return {
    ...t,
    revenue_today: Number(t.revenue_today), revenue_month: Number(t.revenue_month),
    rating_30d: t.rating_30d === null ? null : Number(t.rating_30d),
    completion_today: pct(t.completed_today, t.quizzes_today),
    completion_yesterday: pct(t.completed_yesterday, t.quizzes_yesterday),
    paying_share: pct(t.paying, t.paying + t.on_trial + t.lapsed),
    limit, meta,
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
      (SELECT count(DISTINCT mobile_number)::int FROM whatsapp_messages WHERE direction = 'inbound' AND ${IST('created_at')} = span.d) AS chats
      FROM span ORDER BY span.d`, [days]);
  return { series: rows };
}

async function funnel() {
  return { steps: await metrics.funnel() };
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
      (SELECT count(*)::int FROM parents WHERE is_active AND service_paused AND ${IST('paused_at')} = span.d) AS stopped,
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

async function whatsapp(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      count(m.id) FILTER (WHERE m.direction = 'inbound')::int AS received,
      count(m.id) FILTER (WHERE m.direction = 'outbound' AND m.message_type <> 'template')::int AS replies,
      count(m.id) FILTER (WHERE m.direction = 'outbound' AND m.message_type = 'template')::int AS templates,
      count(m.id) FILTER (WHERE m.direction = 'outbound' AND m.status = 'failed')::int AS failed,
      count(DISTINCT m.mobile_number) FILTER (WHERE m.direction = 'outbound' AND m.message_type = 'template' AND coalesce(m.status, '') <> 'failed')::int AS people_messaged_first
      FROM span LEFT JOIN whatsapp_messages m ON ${IST('m.created_at')} = span.d
     GROUP BY span.d ORDER BY span.d`, [days]);
  const { rows: templates } = await db.query(`
    SELECT coalesce(payload->'template'->>'name', body, '—') AS template,
           count(*)::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status = 'read')::int AS read
      FROM whatsapp_messages
     WHERE direction = 'outbound' AND message_type = 'template' AND created_at > now() - make_interval(days => $1::int)
     GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [days]).catch(() => ({ rows: [] }));
  const marketing = await shared.num('hq_whatsapp_marketing_paise', 85);
  const utility = await shared.num('hq_whatsapp_utility_paise', 11);
  return { series: rows, templates, limit: await shared.waLimit(), rates: { marketing_paise: marketing, utility_paise: utility } };
}

async function services(days) {
  const { rows } = await db.query(`
    WITH span AS (${span()})
    SELECT span.d::text AS d,
      count(j.id) FILTER (WHERE j.status = 'done' OR j.status = 'completed')::int AS jobs_ok,
      count(j.id) FILTER (WHERE j.status = 'failed')::int AS jobs_failed,
      (SELECT count(*)::int FROM whatsapp_messages m WHERE m.direction = 'outbound' AND m.status = 'failed' AND ${IST('m.created_at')} = span.d) AS sends_failed,
      (SELECT count(*)::int FROM notification_log n WHERE n.send_date = span.d) AS scheduled_sends
      FROM span LEFT JOIN job_queue j ON ${IST('j.created_at')} = span.d
     GROUP BY span.d ORDER BY span.d`, [days]).catch(() => ({ rows: [] }));
  return { series: rows, status: await shared.status() };
}

const PAGES = { overview, funnel, money, families, quizzes, whatsapp, services };

async function page(name, days) {
  const fn = PAGES[name];
  if (!fn) return null;
  return { page: name, days: clampDays(days), ...(await fn(clampDays(days))) };
}

/* ─────────────────────────── tap a day: who / what ─────────────────────────── */

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);

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
  if (kind === 'whatsapp') {
    const { rows } = await db.query(
      `SELECT m.id::text AS id, m.mobile_number AS mobile, m.message_type AS type, m.status, m.error_message AS error,
              left(coalesce(m.body, ''), 120) AS body, m.created_at
         FROM whatsapp_messages m
        WHERE m.direction = 'outbound' AND m.message_type = 'template' AND ${IST('m.created_at')} = $1::date
        ORDER BY (m.status = 'failed') DESC, m.created_at LIMIT 500`, [day]);
    return rows.map((r) => ({ ...r, masked: mask(r.mobile), mobile: undefined }));
  }
  return null;
}

module.exports = { home, page, drill, PAGES: Object.keys(PAGES) };
