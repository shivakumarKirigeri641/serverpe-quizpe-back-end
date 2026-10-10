/**
 * src/admin/hq/web.js — THE WEBSITE in the QuizPe admin (user, 2026-10-10: "start
 * QuizPe like GaadiPe, web based; in the admin hide the WhatsApp parts and start
 * with the web activities"). WhatsApp is gone; parents use quizpe.in/app.
 *
 *   overview()   visitors, sign-ins, who is on the app now, web families, how
 *                reminders can reach them (email / phone notifications)
 *   signIns()    every sign-in to the app: the family, device, IP, when, last seen
 *   families()   every family that has used the app, with plan status, email,
 *                notification devices and last visit — and who cannot be reached
 *
 * READ-ONLY: only SELECTs from QuizPe's database.
 */

const db = require('../../database/connectDB');

const n = (v) => Number(v || 0);
const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const ONLINE_MIN = 15;     // seen on the app in the last 15 minutes = "on the app now"

/** "Android 14 · Chrome" from a user agent — enough to tell devices apart. */
function deviceOf(ua) {
  const s = String(ua || '');
  if (!s) return null;
  const os = /Android\s?([\d.]+)?/i.test(s) ? `Android ${(/Android\s?([\d.]+)/i.exec(s) || [])[1] || ''}`.trim()
    : /iPhone|iPad|iOS/i.test(s) ? 'iPhone / iPad'
      : /Windows/i.test(s) ? 'Windows' : /Mac OS X|Macintosh/i.test(s) ? 'Mac' : /Linux/i.test(s) ? 'Linux' : 'Other';
  const br = /Edg\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const phone = /Mobile|Android|iPhone/i.test(s);
  return `${phone ? '📱' : '💻'} ${os} · ${br}`;
}

/* A family's plan as the app sees it: trial / paid / ended / none (userContext.js, in SQL). */
const PLAN = `
  LEFT JOIN LATERAL (
    SELECT s.plan_end_date, pl.plan_name, pl.is_trial,
           (s.is_active AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date) AS running
      FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id
     WHERE s.parent_id = p.id ORDER BY s.plan_end_date DESC, s.id DESC LIMIT 1) sub ON true`;
const planOf = (r) => (!r.parent_id ? 'not enrolled'
  : !r.plan_name ? 'no plan'
    : r.running ? (r.is_trial ? 'free trial' : 'paid plan') : (r.is_trial ? 'trial ended' : 'plan ended'));

async function overview() {
  const s = (await db.query(
    `SELECT
       (SELECT count(*) FROM site_visits WHERE NOT coalesce(is_bot, false) AND created_at >= ${TODAY})::int AS visits_today,
       (SELECT count(DISTINCT session_id) FROM site_visits WHERE NOT coalesce(is_bot, false) AND created_at >= ${TODAY})::int AS visitors_today,
       (SELECT count(*) FROM parent_web_sessions WHERE created_at >= ${TODAY})::int AS signins_today,
       (SELECT count(*) FROM parent_web_sessions WHERE created_at > now() - interval '7 days')::int AS signins_7d,
       (SELECT count(DISTINCT mobile_number) FROM parent_web_sessions
         WHERE ended_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(mins => ${ONLINE_MIN}))::int AS online_now,
       (SELECT count(DISTINCT mobile_number) FROM parent_web_sessions)::int AS web_families,
       (SELECT count(DISTINCT mobile_number) FROM parent_web_sessions WHERE created_at > now() - interval '30 days')::int AS active_30d,
       (SELECT count(*) FROM parent_web_sessions WHERE ended_at IS NULL AND expires_at > now())::int AS open_sessions,
       (SELECT count(DISTINCT mobile_number) FROM parent_push)::int AS push_families,
       (SELECT count(*) FROM parents WHERE email IS NOT NULL AND email <> '')::int AS email_families,
       (SELECT count(*) FROM parent_web_codes WHERE created_at >= ${TODAY})::int AS codes_today,
       (SELECT count(*) FROM parent_web_codes WHERE created_at >= ${TODAY} AND consumed_at IS NULL)::int AS codes_unused_today`)).rows[0];
  // Families on the app who cannot be reached by either (no email, no phone notifications).
  const unreachable = (await db.query(
    `SELECT count(DISTINCT w.mobile_number)::int AS n FROM parent_web_sessions w
       LEFT JOIN parents p ON right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10) = right(regexp_replace(w.mobile_number, '\\D', '', 'g'), 10)
      WHERE coalesce(p.email, '') = ''
        AND NOT EXISTS (SELECT 1 FROM parent_push x WHERE right(regexp_replace(x.mobile_number, '\\D', '', 'g'), 10) = right(regexp_replace(w.mobile_number, '\\D', '', 'g'), 10))`)).rows[0];
  const { rows: days } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM parent_web_sessions w WHERE (w.created_at AT TIME ZONE 'Asia/Kolkata')::date = d)::int AS signins,
            (SELECT count(DISTINCT session_id) FROM site_visits v WHERE NOT coalesce(v.is_bot, false) AND (v.created_at AT TIME ZONE 'Asia/Kolkata')::date = d)::int AS visitors
       FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 13, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d
      ORDER BY d`);
  return { ...s, unreachable: n(unreachable?.n), days };
}

async function signIns({ days = 30, q = '', limit = 300 } = {}) {
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `SELECT w.id, w.mobile_number, w.ip, w.user_agent, w.created_at, w.last_seen_at, w.expires_at, w.ended_at, w.terms_accepted_at,
            p.id AS parent_id, p.parent_name, p.email,
            (SELECT count(*) FROM students st WHERE st.parent_id = p.id AND st.is_active)::int AS children,
            sub.plan_name, sub.is_trial, sub.running
       FROM parent_web_sessions w
       LEFT JOIN parents p ON right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10) = right(regexp_replace(w.mobile_number, '\\D', '', 'g'), 10)
       ${PLAN}
      WHERE w.created_at > now() - make_interval(days => $1::int)
        AND ($2 = '' OR w.mobile_number LIKE '%' || $2 || '%' OR coalesce(p.parent_name, '') ILIKE '%' || $2 || '%')
      ORDER BY w.created_at DESC LIMIT $3`, [Math.min(365, Math.max(1, Number(days) || 30)), term, Math.min(1000, Number(limit) || 300)]);
  const now = Date.now();
  return {
    rows: rows.map((r) => ({
      id: String(r.id), mobile: ten(r.mobile_number), name: r.parent_name || null, email: r.email || null,
      parent_id: r.parent_id ? String(r.parent_id) : null, children: n(r.children), plan: planOf(r), plan_name: r.plan_name || null,
      device: deviceOf(r.user_agent), user_agent: r.user_agent, ip: r.ip,
      signed_in_at: r.created_at, last_seen_at: r.last_seen_at, ended_at: r.ended_at,
      state: r.ended_at ? 'signed out' : new Date(r.expires_at) < now ? 'expired'
        : now - new Date(r.last_seen_at).getTime() < ONLINE_MIN * 60e3 ? 'on the app now' : 'signed in',
    })),
  };
}

/*
 * Every family that has used the app: plan, children, email, phone notifications,
 * sign-ins and the last visit. filter: all | unreachable (no email and no
 * notifications) | no_email | push | trial | paid | not_enrolled
 */
async function families({ q = '', filter = 'all', limit = 300 } = {}) {
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `WITH w AS (
       SELECT right(regexp_replace(mobile_number, '\\D', '', 'g'), 10) AS m10, min(created_at) AS first_at, max(last_seen_at) AS last_at,
              count(*)::int AS signins,
              bool_or(ended_at IS NULL AND expires_at > now()) AS signed_in
         FROM parent_web_sessions GROUP BY 1),
     pu AS (SELECT right(regexp_replace(mobile_number, '\\D', '', 'g'), 10) AS m10, count(*)::int AS devices FROM parent_push GROUP BY 1)
     SELECT w.*, coalesce(pu.devices, 0) AS push_devices,
            p.id AS parent_id, p.parent_name, p.email, p.created_at AS enrolled_at,
            (SELECT count(*) FROM students st WHERE st.parent_id = p.id AND st.is_active)::int AS children,
            sub.plan_name, sub.is_trial, sub.running, sub.plan_end_date
       FROM w
       LEFT JOIN pu ON pu.m10 = w.m10
       LEFT JOIN parents p ON right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10) = w.m10
       ${PLAN}
      WHERE ($1 = '' OR w.m10 LIKE '%' || $1 || '%' OR coalesce(p.parent_name, '') ILIKE '%' || $1 || '%')
      ORDER BY w.last_at DESC NULLS LAST LIMIT $2`, [term, Math.min(1000, Number(limit) || 300)]);
  const all = rows.map((r) => ({
    mobile: r.m10, name: r.parent_name || null, email: r.email || null, parent_id: r.parent_id ? String(r.parent_id) : null,
    children: n(r.children), plan: planOf(r), plan_name: r.plan_name || null, plan_ends: r.plan_end_date || null,
    push_devices: n(r.push_devices), signins: n(r.signins), signed_in: Boolean(r.signed_in),
    first_at: r.first_at, last_at: r.last_at, enrolled_at: r.enrolled_at,
    reach: [r.email ? 'email' : null, n(r.push_devices) ? 'push' : null].filter(Boolean),
  }));
  const F = {
    unreachable: (x) => !x.reach.length, no_email: (x) => !x.email, push: (x) => x.push_devices > 0,
    trial: (x) => x.plan === 'free trial', paid: (x) => x.plan === 'paid plan', not_enrolled: (x) => x.plan === 'not enrolled',
  }[filter];
  return { rows: F ? all.filter(F) : all, total: all.length };
}

module.exports = { overview, signIns, families, deviceOf };
