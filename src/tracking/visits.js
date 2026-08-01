/**
 * src/tracking/visits.js
 * ---------------------------------------------------------------------------
 * First-party visitor tracking for the marketing site (quizpe.in).
 *
 * Two things are recorded, both from the public site with no login:
 *   • 'view'     — someone opened the landing page
 *   • 'wa_click' — someone tapped a "Start on WhatsApp" button (high intent)
 *
 * Why first-party when GA4 already exists: GA4 lives in Google's dashboard and
 * cannot (a) show counts inside our own admin panel, or (b) email the founder
 * the moment a WhatsApp button is clicked. This module does exactly those two
 * things; GA4 still handles the deep geography/funnel charts.
 *
 * Country is resolved with an OFFLINE geo-IP dataset (geoip-lite) so we can
 * flag visitors from India without any external call.
 *
 * Volume control:
 *   • WA-click  -> instant admin email (deduped per session, 30 min)
 *   • views     -> never emailed; they appear in the admin Inbox only while the
 *                  `visits_to_inbox` switch is ON (default ON, admin can toggle)
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');
// geoip-lite is optional at runtime: if it isn't installed on the server yet,
// the platform must still boot — country just stays blank until it is.
let geoip = null;
try { geoip = require('geoip-lite'); }
catch { console.warn('[visits] geoip-lite not installed — visitor country will be blank until `npm install`'); }
const { sendAdminMail } = require('../mail/mailer');
const { LAUNCH_DATE, TZ } = require('../config/launch');

const BOT_RE = /bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternalhit|whatsapp|telegram|preview|monitor|curl|wget|python|node-fetch|axios|headless|lighthouse|pingdom|uptime/i;

/** Lightweight user-agent breakdown — no dependency, covers the common cases. */
function deviceOf(ua = '') {
  const s = String(ua || '');
  const os = /Windows NT/i.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Android/i.test(s) ? 'Android'
    : /Mac OS X/i.test(s) ? 'macOS'
    : /CrOS/i.test(s) ? 'ChromeOS'
    : /Linux/i.test(s) ? 'Linux' : 'Unknown OS';
  const browser = /Edg\//i.test(s) ? 'Edge'
    : /OPR\/|Opera/i.test(s) ? 'Opera'
    : /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Safari\//i.test(s) ? 'Safari' : 'Unknown browser';
  const type = /iPad|Tablet/i.test(s) ? 'Tablet'
    : /Mobi|Android|iPhone|iPod/i.test(s) ? 'Mobile' : 'Desktop';
  return { os, browser, type, summary: `${type} · ${os} · ${browser}` };
}

/**
 * geoip-lite reports region as an ISO-3166-2 subdivision code (e.g. "KA").
 * Map the Indian ones to readable state / union-territory names so the admin
 * panel shows "Karnataka", not "KA". Unknown codes fall back to the raw value.
 */
const IN_STATES = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam',
  BR: 'Bihar', CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh',
  DN: 'Dadra & Nagar Haveli and Daman & Diu', DD: 'Dadra & Nagar Haveli and Daman & Diu',
  DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh',
  JK: 'Jammu & Kashmir', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh',
  LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya',
  MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', OR: 'Odisha', PY: 'Puducherry', PB: 'Punjab',
  RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana',
  TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand', UT: 'Uttarakhand', WB: 'West Bengal',
};
/** Readable state/union name for a visit (India only; else the raw region). */
function stateName(region, country) {
  if (!region) return null;
  if (country === 'IN') return IN_STATES[String(region).toUpperCase()] || region;
  return region;
}

/** Floor every analytics query at the real launch date (IST midnight). */
const LAUNCH_FLOOR = `(TIMESTAMP '${LAUNCH_DATE} 00:00:00' AT TIME ZONE '${TZ}')`;
const IST_TS = (c) => `to_char(${c} AT TIME ZONE '${TZ}', 'DD Mon, HH24:MI')`;

let schemaReady = false;

/** Create the table + default setting once, idempotently, at startup. */
async function ensureSchema() {
  if (schemaReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_visits (
      id          bigserial PRIMARY KEY,
      kind        text        NOT NULL DEFAULT 'view',
      path        text,
      referrer    text,
      country     text,
      region      text,
      city        text,
      ip          text,
      user_agent  text,
      is_bot      boolean     NOT NULL DEFAULT false,
      session_id  text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_site_visits_created ON site_visits(created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_site_visits_kind    ON site_visits(kind);`);
  // default the inbox switch ON — the founder can turn it off in the panel
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('visits_to_inbox', 'true', now())
       ON CONFLICT (key) DO NOTHING`);
  schemaReady = true;
  console.log('[visits] tracking schema ready');
}

/** The real client IP behind nginx / a proxy. */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

/** Is the inbox switch on? (default true) */
async function inboxOn() {
  try {
    const { rows: [r] } = await db.query(`SELECT value FROM app_settings WHERE key='visits_to_inbox'`);
    return r ? r.value === 'true' : true;
  } catch { return true; }
}

async function setInboxOn(on) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('visits_to_inbox', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [on ? 'true' : 'false']);
  return on;
}

/** Record one event and (for wa_click) alert the admin. */
async function record(req, { kind, path, referrer, sid }) {
  await ensureSchema();
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 400);
  const isBot = BOT_RE.test(ua) || !ua;
  const geo = (ip && geoip) ? geoip.lookup(ip) : null;
  const country = geo?.country || null;

  const { rows: [row] } = await db.query(
    `INSERT INTO site_visits (kind, path, referrer, country, region, city, ip, user_agent, is_bot, session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, kind, path, referrer, country, region, city, ip, user_agent, is_bot, session_id, ${IST_TS('created_at')} AS at_ist`,
    [kind === 'wa_click' ? 'wa_click' : 'view', (path || '/').slice(0, 300),
     (referrer || '').slice(0, 300) || null, country, geo?.region || null,
     geo?.city || null, ip || null, ua, isBot, (sid || '').slice(0, 64) || null]);

  if (kind === 'wa_click' && !isBot) notifyWaClick(row).catch(() => {});
  return row;
}

/** Instant email on a WhatsApp-button click — deduped per session (30 min). */
async function notifyWaClick(row) {
  if (row.session_id) {
    const { rows: [dup] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM site_visits
        WHERE kind='wa_click' AND session_id=$1 AND created_at > now() - interval '30 minutes'`,
      [row.session_id]);
    if (dup.n > 1) return; // already alerted for this visitor recently
  }
  const dev = deviceOf(row.user_agent);
  const where = [row.city, row.region, row.country].filter(Boolean).join(', ') || 'unknown';
  const rowHtml = (label, value) =>
    `<tr><td style="padding:5px 16px 5px 0;color:#5c716a;white-space:nowrap;vertical-align:top">${label}</td>` +
    `<td style="padding:5px 0;color:#15332b"><b>${value || '—'}</b></td></tr>`;
  await sendAdminMail({
    subject: '🔔 QuizPe — someone tapped "Start on WhatsApp"',
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;color:#15332b;max-width:560px">
        <h2 style="color:#075e54;margin:0 0 6px">A visitor just clicked the WhatsApp button</h2>
        <p style="margin:0 0 14px;color:#5c716a">They may be about to message you — keep an eye on WhatsApp.</p>
        <table style="border-collapse:collapse;font-size:14px;width:100%">
          ${rowHtml('When', `${row.at_ist} IST`)}
          ${rowHtml('Device', dev.summary)}
          ${rowHtml('Browser / OS', `${dev.browser} on ${dev.os}`)}
          ${rowHtml('IP address', row.ip)}
          ${rowHtml('Location', where)}
          ${rowHtml('Page', row.path || '/')}
          ${rowHtml('Came via', row.referrer || 'direct')}
          ${rowHtml('Visitor ID', row.session_id)}
        </table>
        <p style="margin:14px 0 4px;color:#5c716a;font-size:12px">
          Full user-agent:<br><span style="color:#8a9a94;word-break:break-all">${row.user_agent || '—'}</span>
        </p>
        <p style="margin:12px 0 0;color:#8a9a94;font-size:12px;line-height:1.5">
          Website visitors are anonymous — there is no name until they message you. When their WhatsApp
          chat arrives, the <b>Visitor ID</b> above lets you match it to this click.
        </p>
      </div>`,
  });
}

/** Full visitor analytics, windowed from the launch date, in IST. */
async function analytics() {
  await ensureSchema();
  const [summary, series, refs] = await Promise.all([
    db.query(`
      WITH v AS (
        SELECT kind, session_id, country,
               (created_at AT TIME ZONE '${TZ}')::date AS d
          FROM site_visits
         WHERE NOT is_bot AND created_at >= ${LAUNCH_FLOOR}),
      t AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS today)
      SELECT (SELECT today FROM t) AS today,
        COUNT(*) FILTER (WHERE kind='view')::int                                          AS views_total,
        COUNT(DISTINCT session_id) FILTER (WHERE kind='view')::int                        AS uniques_total,
        COUNT(*) FILTER (WHERE kind='wa_click')::int                                      AS wa_total,
        COUNT(*) FILTER (WHERE kind='view' AND country='IN')::int                         AS india_views,
        COUNT(*) FILTER (WHERE kind='view' AND d=(SELECT today FROM t))::int              AS views_today,
        COUNT(DISTINCT session_id) FILTER (WHERE kind='view' AND d=(SELECT today FROM t))::int AS uniques_today,
        COUNT(*) FILTER (WHERE kind='wa_click' AND d=(SELECT today FROM t))::int          AS wa_today,
        COUNT(*) FILTER (WHERE kind='view' AND d=(SELECT today FROM t)-1)::int            AS views_yday,
        COUNT(*) FILTER (WHERE kind='view' AND d > (SELECT today FROM t)-7)::int          AS views_7d,
        COUNT(*) FILTER (WHERE kind='view' AND d <= (SELECT today FROM t)-7
                                          AND d > (SELECT today FROM t)-14)::int          AS views_prev7
      FROM v`),
    db.query(`
      SELECT (created_at AT TIME ZONE '${TZ}')::date AS day,
             COUNT(*) FILTER (WHERE kind='view')::int      AS views,
             COUNT(DISTINCT session_id) FILTER (WHERE kind='view')::int AS uniques,
             COUNT(*) FILTER (WHERE kind='wa_click')::int  AS wa
        FROM site_visits
       WHERE NOT is_bot AND created_at >= ${LAUNCH_FLOOR}
       GROUP BY day ORDER BY day`),
    db.query(`
      SELECT COALESCE(NULLIF(referrer,''),'direct') AS source, COUNT(*)::int AS n
        FROM site_visits
       WHERE NOT is_bot AND kind='view' AND created_at >= ${LAUNCH_FLOOR}
       GROUP BY source ORDER BY n DESC LIMIT 8`),
  ]);

  const s = summary.rows[0] || {};
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0));
  return {
    launch_date: LAUNCH_DATE,
    today: s.today,
    totals: {
      views: s.views_total || 0,
      uniques: s.uniques_total || 0,
      wa_clicks: s.wa_total || 0,
      india_views: s.india_views || 0,
      conversion_pct: s.views_total > 0 ? Math.round((s.wa_total / s.views_total) * 100) : 0,
      india_pct: s.views_total > 0 ? Math.round((s.india_views / s.views_total) * 100) : 0,
    },
    today_stats: {
      views: s.views_today || 0,
      uniques: s.uniques_today || 0,
      wa_clicks: s.wa_today || 0,
      vs_yesterday_pct: pct(s.views_today || 0, s.views_yday || 0),
    },
    week: {
      views: s.views_7d || 0,
      prev_views: s.views_prev7 || 0,
      change_pct: pct(s.views_7d || 0, s.views_prev7 || 0),
    },
    daily: series.rows,
    referrers: refs.rows,
  };
}

/** Recent individual visits for the admin Inbox (only used while switch is on). */
async function recent(limit = 60) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT id, kind, path, referrer, country, region, city, ip, user_agent, session_id,
            ${IST_TS('created_at')} AS at_ist
       FROM site_visits
      WHERE NOT is_bot AND created_at >= ${LAUNCH_FLOOR}
      ORDER BY id DESC LIMIT $1`, [Math.min(200, Number(limit) || 60)]);
  return rows.map((r) => ({
    ...r,
    device: deviceOf(r.user_agent).summary,
    state: stateName(r.region, r.country),
  }));
}

/** Top-N {name, n} from a plain {name: count} tally, biggest first. */
function topN(tally, n = 8) {
  return Object.entries(tally)
    .map(([name, count]) => ({ name, n: count }))
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}

/**
 * Visits rolled up into mutually-exclusive time buckets (today / yesterday /
 * earlier this week / earlier this month / older), each with a count and a
 * breakdown by device, state/union, place (city), country and unique IPs.
 *
 * `kind`: 'all' (default), 'view', or 'wa_click' (WhatsApp-intent only — used
 * by the Conversations page, since WhatsApp chats themselves carry no geo/IP).
 */
async function grouped(kind = 'all') {
  await ensureSchema();
  const kindFilter = kind === 'wa_click' ? `AND kind = 'wa_click'`
    : kind === 'view' ? `AND kind = 'view'` : '';
  const { rows } = await db.query(`
    WITH t AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS today),
    v AS (
      SELECT kind, ip, country, region, city, user_agent, session_id, created_at,
             (created_at AT TIME ZONE '${TZ}')::date AS d
        FROM site_visits
       WHERE NOT is_bot AND created_at >= ${LAUNCH_FLOOR} ${kindFilter})
    SELECT v.kind, v.ip, v.country, v.region, v.city, v.user_agent, v.session_id,
      CASE
        WHEN v.d = t.today                                         THEN 'today'
        WHEN v.d = t.today - 1                                     THEN 'yesterday'
        WHEN v.d >= date_trunc('week',  t.today)::date AND v.d < t.today - 1
                                                                   THEN 'this_week'
        WHEN v.d >= date_trunc('month', t.today)::date AND v.d < date_trunc('week', t.today)::date
                                                                   THEN 'this_month'
        ELSE 'older'
      END AS bucket
      FROM v, t
     ORDER BY v.created_at DESC
     LIMIT 20000`);

  const KEYS = ['today', 'yesterday', 'this_week', 'this_month', 'older'];
  const LABELS = {
    today: 'Today', yesterday: 'Yesterday', this_week: 'Earlier this week',
    this_month: 'Earlier this month', older: 'Older',
  };
  const init = () => ({ total: 0, uniques: new Set(), wa: 0, ips: new Set(), dev: {}, st: {}, pl: {}, co: {} });
  const acc = Object.fromEntries(KEYS.map((k) => [k, init()]));

  for (const r of rows) {
    const b = acc[r.bucket];
    if (!b) continue;
    b.total++;
    if (r.session_id) b.uniques.add(r.session_id);
    if (r.kind === 'wa_click') b.wa++;
    if (r.ip) b.ips.add(r.ip);
    const type = deviceOf(r.user_agent).type;
    b.dev[type] = (b.dev[type] || 0) + 1;
    const st = stateName(r.region, r.country) || 'Unknown';
    b.st[st] = (b.st[st] || 0) + 1;
    const pl = r.city || 'Unknown';
    b.pl[pl] = (b.pl[pl] || 0) + 1;
    const co = r.country || 'Unknown';
    b.co[co] = (b.co[co] || 0) + 1;
  }

  const buckets = KEYS.map((k) => {
    const b = acc[k];
    return {
      key: k, label: LABELS[k],
      total: b.total, uniques: b.uniques.size, wa_clicks: b.wa, unique_ips: b.ips.size,
      devices: topN(b.dev), states: topN(b.st), places: topN(b.pl), countries: topN(b.co),
    };
  });
  return { kind, buckets };
}

/**
 * Geography for the India heatmap: website visitors by state (from the geo-IP
 * region → state name), and enrolled families by state (parents.state_code →
 * states_unions). Two separate breakdowns because the two sources name states
 * slightly differently; the panel shows them side by side.
 */
async function geo() {
  await ensureSchema();
  const { rows: vraw } = await db.query(`
    SELECT region, country, COUNT(*)::int AS n
      FROM site_visits
     WHERE NOT is_bot AND kind='view' AND created_at >= ${LAUNCH_FLOOR}
     GROUP BY region, country`);
  const vmap = {};
  let india = 0, other = 0;
  for (const r of vraw) {
    if (r.country === 'IN') {
      const nm = stateName(r.region, 'IN') || 'Unknown';
      vmap[nm] = (vmap[nm] || 0) + r.n;
      india += r.n;
    } else other += r.n;
  }

  const { rows: families } = await db.query(`
    SELECT COALESCE(su.state_name, NULLIF(p.state_code,''), 'Unknown') AS name, COUNT(*)::int AS n
      FROM parents p
      LEFT JOIN states_unions su ON su.state_code = p.state_code
     WHERE p.is_active
     GROUP BY 1 ORDER BY n DESC`);

  return { visitors: topN(vmap, 100), families, visitors_india: india, visitors_other: other };
}

module.exports = { ensureSchema, record, analytics, recent, grouped, geo, inboxOn, setInboxOn, clientIp };
