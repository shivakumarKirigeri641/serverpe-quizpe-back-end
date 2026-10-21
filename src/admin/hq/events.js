/**
 * src/admin/hq/events.js — THE EVENT LOG AND WHO IS HERE NOW (user, 2026-10-21: "continue with QuizPe" —
 * the QuizPe admin like GaadiPe's web admin, which has a Log of every event in words and Live users).
 *
 * QuizPe has no app event stream of its own, so both are read from the tables that already record what
 * happens — nothing new is tracked:
 *   site_visits                  a page of quizpe.in opened (bots left out)
 *   parent_web_codes             a sign-in code asked for
 *   parent_web_sessions          a sign-in to quizpe.in/app, and when the family was last seen there
 *   parents_quizpe_subscriptions a free trial started, a plan begun
 *   payments (+ checkout_sessions for the mobile)   a payment captured, or failed
 *   quizpe_tracker               a child finished a quiz
 *   quiz_reports                 the explanation report ready
 *   notification_log             a reminder sent (or not)
 *   support_tickets, feedbacks   a support request, a rating
 *
 *   log({ hours, kind, q, visits, limit })   newest first; page visits only when asked (visits=1), as on
 *                                            GaadiPe; kind narrows to one kind; q a mobile, name or words
 *   live()                                   visitors on quizpe.in in the last 15 minutes, and families on
 *                                            the app now
 * Every family's row carries its mobile, so the admin's agreed-only filter (hq/agreed.js) applies.
 * The owner's own use is left out (hq/notMe.js). READ-ONLY.
 */

const db = require('../../database/connectDB');
const ME = require('./notMe').mobile;
const { deviceOf } = require('./web');

const M10 = (col) => `right(regexp_replace(${col}, '\\D', '', 'g'), 10)`;
const NAME = (m) => `(SELECT p.parent_name FROM parents p WHERE ${M10('p.parent_mobile_number')} = ${m} ORDER BY p.id LIMIT 1)`;
const KINDS = ['visit', 'code', 'signin', 'trial', 'plan', 'paid', 'payment_failed', 'quiz', 'report', 'reminder', 'support', 'feedback'];

async function log({ hours = 24, kind = 'all', q = '', visits = false, limit = 300 } = {}) {
  const h = Math.min(24 * 90, Math.max(1, Number(hours) || 24));
  const since = `now() - make_interval(hours => ${h})`;
  const parts = [
    visits ? `SELECT 'visit' AS kind, v.created_at AS at, NULL::text AS mobile, NULL::text AS name,
                     coalesce(v.path, '/') AS a, concat_ws(', ', v.city, v.region) AS b, v.user_agent AS c, v.session_id::text AS ref
                FROM site_visits v WHERE v.created_at > ${since} AND NOT coalesce(v.is_bot, false)` : null,
    `SELECT 'code', c.created_at, ${M10('c.mobile_number')}, ${NAME(M10('c.mobile_number'))},
            CASE WHEN c.consumed_at IS NOT NULL THEN 'used' WHEN c.expires_at < now() THEN 'not used' ELSE 'waiting' END, NULL, NULL, c.id::text
       FROM parent_web_codes c WHERE c.created_at > ${since} AND ${ME('c.mobile_number')}`,
    `SELECT 'signin', w.created_at, ${M10('w.mobile_number')}, ${NAME(M10('w.mobile_number'))}, NULL, w.ip, w.user_agent, w.id::text
       FROM parent_web_sessions w WHERE w.created_at > ${since} AND ${ME('w.mobile_number')}`,
    `SELECT CASE WHEN pl.is_trial THEN 'trial' ELSE 'plan' END, s.created_at, ${M10('p.parent_mobile_number')}, p.parent_name,
            pl.plan_name, s.plan_end_date::text, pl.price::text, s.id::text
       FROM parents_quizpe_subscriptions s JOIN quizpe_plans pl ON pl.id = s.plan_id JOIN parents p ON p.id = s.parent_id
      WHERE s.created_at > ${since} AND ${ME('p.parent_mobile_number')}`,
    `SELECT CASE WHEN pay.status = 'captured' THEN 'paid' ELSE 'payment_failed' END, pay.created_at,
            ${M10('cs.mobile_number')}, ${NAME(M10('cs.mobile_number'))}, pay.amount::text, pay.method,
            coalesce(pay.error_description, pay.error_reason), pay.id::text
       FROM payments pay LEFT JOIN checkout_sessions cs ON cs.razorpay_order_id = pay.order_id
      WHERE pay.created_at > ${since} AND pay.status IN ('captured', 'failed')
        AND coalesce(cs.razorpay_mode, 'live') <> 'test' AND (cs.mobile_number IS NULL OR ${ME('cs.mobile_number')})`,
    `SELECT 'quiz', t.modified_at, ${M10('p.parent_mobile_number')}, p.parent_name, st.student_name,
            coalesce(t.question_count, 0)::text, t.quiz_type, t.id::text
       FROM quizpe_tracker t JOIN quizpe_status qs ON qs.id = t.status_id JOIN students st ON st.id = t.student_id JOIN parents p ON p.id = st.parent_id
      WHERE qs.status_code = 'completed' AND t.modified_at > ${since} AND ${ME('p.parent_mobile_number')}`,
    `SELECT 'report', r.created_at, ${M10('p.parent_mobile_number')}, p.parent_name, st.student_name,
            concat(r.score_correct, '/', r.score_total), r.grade, r.id::text
       FROM quiz_reports r JOIN students st ON st.id = r.student_id JOIN parents p ON p.id = st.parent_id
      WHERE r.created_at > ${since} AND r.is_active AND ${ME('p.parent_mobile_number')}`,
    `SELECT 'reminder', n.created_at, ${M10('n.mobile_number')}, ${NAME(M10('n.mobile_number'))}, n.kind, n.status, n.error_message, n.id::text
       FROM notification_log n WHERE n.created_at > ${since} AND ${ME('n.mobile_number')}`,
    `SELECT 'support', t.created_at, ${M10('t.mobile_number')}, t.user_name, t.ticket_no, t.query_type, left(t.message, 140), t.id::text
       FROM support_tickets t WHERE t.created_at > ${since} AND t.is_active AND ${ME('t.mobile_number')}`,
    `SELECT 'feedback', f.created_at, ${M10('f.mobile_number')}, f.user_name, f.rating::text, f.feedback_type, left(f.message, 140), f.id::text
       FROM feedbacks f WHERE f.created_at > ${since} AND f.is_active AND ${ME('f.mobile_number')}`,
  ].filter(Boolean);
  const want = KINDS.includes(kind) ? kind : null;
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `SELECT * FROM (${parts.join('\nUNION ALL\n')}) e (kind, at, mobile, name, a, b, c, ref)
      WHERE ($1::text IS NULL OR e.kind = $1)
        AND ($2 = '' OR e.mobile LIKE '%' || $2 || '%' OR coalesce(e.name, '') ILIKE '%' || $2 || '%'
             OR concat_ws(' ', e.a, e.b, e.c) ILIKE '%' || $2 || '%')
      ORDER BY e.at DESC LIMIT $3`, [want, term, Math.min(1000, Number(limit) || 300)]);
  const rupees = (v) => `₹${Math.round(Number(v || 0)).toLocaleString('en-IN')}`;
  const words = (e) => ({
    visit: () => ['🌐', `Opened quizpe.in${e.a === '/' ? '' : e.a}`, [e.b, deviceOf(e.c)].filter(Boolean).join(' · ')],
    code: () => ['🔑', 'Asked for a sign-in code', e.a === 'used' ? 'used it' : e.a === 'not used' ? 'did not use it' : 'not used yet'],
    signin: () => ['✅', 'Signed in on the app', deviceOf(e.c) || ''],
    trial: () => ['🎁', `Started the free trial · ${e.a}`, e.b ? `until ${e.b}` : ''],
    plan: () => ['📘', `Plan begun · ${e.a}`, [e.c ? rupees(e.c) : null, e.b ? `until ${e.b}` : null].filter(Boolean).join(' · ')],
    paid: () => ['💰', `Paid ${rupees(e.a)}`, e.b || ''],
    payment_failed: () => ['❌', `Payment failed · ${rupees(e.a)}`, e.c || ''],
    quiz: () => ['📝', `${e.a || 'A child'} finished a quiz`, `${e.b} questions${e.c ? ` · ${e.c}` : ''}`],
    report: () => ['📊', `Report ready for ${e.a || 'a child'}`, [e.b, e.c].filter(Boolean).join(' · ')],
    reminder: () => ['🔔', `Reminder · ${String(e.a || '').replace(/_/g, ' ')}`, [e.b, e.c].filter(Boolean).join(' · ')],
    support: () => ['🆘', `Support request ${e.a || ''}`.trim(), [e.b, e.c].filter(Boolean).join(' · ')],
    feedback: () => ['⭐', e.a && e.a !== 'null' ? `Rated ${e.a}/5` : 'Sent feedback', [e.b, e.c].filter(Boolean).join(' · ')],
  }[e.kind] || (() => ['•', e.kind, '']))();
  return {
    hours: h, kinds: KINDS,
    rows: rows.map((e) => {
      const [icon, text, detail] = words(e);
      const bad = e.kind === 'payment_failed' || (e.kind === 'reminder' && /fail|error/i.test(String(e.b || ''))) || (e.kind === 'code' && e.a === 'not used');
      return { kind: e.kind, at: e.at, icon, text, detail, mobile: e.mobile, name: e.name, ref: e.ref, bad };
    }),
  };
}

/* Who is here now: quizpe.in visitors in the last 15 minutes, and families seen on the app. */
async function live() {
  const [site, app] = await Promise.all([
    db.query(
      `SELECT v.session_id::text AS session, min(v.created_at) AS first_at, max(v.created_at) AS last_at, count(*)::int AS pages,
              (array_agg(v.path ORDER BY v.created_at DESC))[1] AS page,
              (array_agg(concat_ws(', ', v.city, v.region) ORDER BY v.created_at DESC))[1] AS place,
              (array_agg(v.user_agent ORDER BY v.created_at DESC))[1] AS ua,
              (array_agg(v.referrer ORDER BY v.created_at))[1] AS came_from
         FROM site_visits v
        WHERE v.created_at > now() - interval '15 minutes' AND NOT coalesce(v.is_bot, false)
        GROUP BY 1 ORDER BY max(v.created_at) DESC LIMIT 100`),
    db.query(
      `WITH a AS (
         SELECT ${M10('w.mobile_number')} AS m, max(w.last_seen_at) AS last_seen,
                (array_agg(w.user_agent ORDER BY w.last_seen_at DESC))[1] AS ua
           FROM parent_web_sessions w
          WHERE w.ended_at IS NULL AND w.last_seen_at > now() - interval '15 minutes' AND ${ME('w.mobile_number')}
          GROUP BY 1)
       SELECT a.m AS mobile, ${NAME('a.m')} AS name, a.last_seen, a.ua FROM a ORDER BY a.last_seen DESC LIMIT 100`),
  ]);
  return {
    site: site.rows.map((r) => ({ ...r, device: deviceOf(r.ua), ua: undefined })),
    app: app.rows.map((r) => ({ ...r, device: deviceOf(r.ua), ua: undefined })),
  };
}

module.exports = { log, live, KINDS };
