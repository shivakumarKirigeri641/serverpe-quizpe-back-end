/**
 * src/routers/publicRouter.js
 * ---------------------------------------------------------------------------
 * Public, unauthenticated endpoints for the parent-facing website.
 *
 *   GET /public/stats     headline numbers for a landing page
 *   GET /public/coverage  which boards, grades and mediums are actually live
 *
 * AGGREGATES ONLY. Nothing here can identify a parent, a child or a school —
 * no names, no numbers, no per-row data. These endpoints are reachable by
 * anyone on the internet, so the rule is simple: if a single person could be
 * picked out of a response, it does not belong here.
 *
 * Cached briefly in memory because a landing page can be hit far more often
 * than these numbers change.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../database/connectDB');

const router = express.Router();
const TTL_MS = Number(process.env.PUBLIC_STATS_TTL_MS) || 60_000;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + TTL_MS });
  return value;
}

router.get('/stats', async (req, res) => {
  try {
    const stats = await cached('stats', async () => {
      const { rows: [r] } = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM parents WHERE is_active)                        AS parents,
          (SELECT COUNT(*)::int FROM students WHERE is_active)                       AS students,
          (SELECT COUNT(*)::int FROM quizpe_tracker)                                 AS quizzes_delivered,
          (SELECT COUNT(*)::int FROM quizpe_tracker t JOIN quizpe_status s ON s.id=t.status_id
            WHERE s.status_code = 'completed')                                       AS quizzes_completed,
          (SELECT COUNT(*)::int FROM student_quizpe_histories
            WHERE answered_option IS NOT NULL)                                       AS questions_answered,
          (SELECT COUNT(*)::int FROM question_bank WHERE is_active)                  AS questions_available,
          (SELECT COUNT(*)::int FROM quiz_reports WHERE is_active)                   AS reports_generated,
          (SELECT COUNT(DISTINCT board_id)::int FROM question_bank WHERE is_active)  AS boards_live,
          (SELECT COUNT(DISTINCT grade_id)::int FROM question_bank WHERE is_active)  AS grades_live,
          (SELECT COUNT(DISTINCT state_code)::int FROM parents
            WHERE is_active AND state_code IS NOT NULL)                              AS states_reached,
          (SELECT COALESCE(ROUND(AVG(score_pct)), 0)::int FROM quiz_reports
            WHERE is_active)                                                         AS average_score_pct,
          (SELECT COALESCE(ROUND(AVG(rating), 1), 0)::numeric FROM feedbacks
            WHERE rating IS NOT NULL)                                                AS average_rating,
          (SELECT COUNT(*)::int FROM feedbacks WHERE rating IS NOT NULL)             AS ratings_count,
          (SELECT COUNT(*)::int FROM quizpe_tracker WHERE quiz_date = CURRENT_DATE)  AS quizzes_today
      `);
      return r;
    });

    res.json({
      success: true,
      stats,
      // so a landing page can say "as of today" without guessing
      as_of: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[public] stats:', e.message);
    res.status(500).json({ success: false, error: 'Could not load statistics.' });
  }
});

/** What we can actually deliver — drives "available for" on a landing page. */
router.get('/coverage', async (req, res) => {
  try {
    const coverage = await cached('coverage', async () => {
      const { getAvailability } = require('../content/availability');
      const a = await getAvailability();
      const combos = [];
      for (const [board, grades] of Object.entries(a.availability)) {
        for (const [grade, gv] of Object.entries(grades)) {
          combos.push({
            board, grade, grade_name: gv.grade_name,
            mediums: Object.values(gv.mediums).map((m) => m.label),
          });
        }
      }
      return { boards: a.boards, grades: a.grades, combinations: combos };
    });
    res.json({ success: true, ...coverage });
  } catch (e) {
    console.error('[public] coverage:', e.message);
    res.status(500).json({ success: false, error: 'Could not load coverage.' });
  }
});

/**
 * Plans exactly as they are sold. The website must never quote a price the
 * checkout will not honour, so this reads quizpe_plans rather than repeating
 * the numbers in the front-end.
 */
router.get('/plans', async (req, res) => {
  try {
    const rows = await cached('plans', async () => (await db.query(
      `SELECT plan_code, plan_name, plan_description, price::numeric,
              regular_price::numeric, comparable_price::numeric,
              student_count, duration, is_trial
         FROM quizpe_plans
        WHERE is_active
        ORDER BY is_trial DESC, price`)).rows);

    const gst = (await db.query(
      `SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];

    // Seat counts move as people enrol, so this is deliberately NOT served from
    // the plans cache — a banner claiming seats that have gone is worse than no
    // banner at all.
    const offer = await require('../utils/launchOffer').status();

    res.json({
      success: true,
      gst_pct: gst ? Number(gst.gst_value) : 18,
      offer,
      plans: rows.map((p) => {
        const regular = p.regular_price == null ? Number(p.price) : Number(p.regular_price);
        // Trials are free and never discounted, so the offer must not touch them.
        const payable = p.is_trial || !offer.active ? (p.is_trial ? Number(p.price) : regular) : Number(p.price);
        return {
          ...p,
          price: payable,
          regular_price: regular,
          saving: Math.max(0, regular - payable),
          is_launch_price: !p.is_trial && offer.active && payable < regular,
          comparable_price: p.comparable_price == null ? null : Number(p.comparable_price),
          // a per-day figure is the honest way to compare a 7-day trial with a
          // 28-day plan, and it is the number parents actually weigh up
          per_day: p.duration > 0 ? +(payable / p.duration).toFixed(2) : 0,
        };
      }),
    });
  } catch (e) {
    console.error('[public] plans:', e.message);
    res.status(500).json({ success: false, error: 'Could not load plans.' });
  }
});

/**
 * Live seat count for the launch banner. Separate from /plans so the website
 * can poll it cheaply without re-fetching everything, and never cached.
 */
router.get('/launch-offer', async (req, res) => {
  try {
    res.json({ success: true, ...(await require('../utils/launchOffer').status()) });
  } catch (e) {
    console.error('[public] launch-offer:', e.message);
    res.status(500).json({ success: false, error: 'Could not load offer status.' });
  }
});

/* ------------------------------------------------------------ testimonials */
/** Only moderated, approved testimonials are ever public. */
router.get('/testimonials', async (req, res) => {
  try {
    const rows = await cached('testimonials', async () => (await db.query(
      `SELECT author_name, author_role, location, rating, message
         FROM testimonials
        WHERE is_approved AND is_active
        ORDER BY display_order, id DESC
        LIMIT 24`)).rows);
    res.json({ success: true, rows });
  } catch (e) {
    console.error('[public] testimonials:', e.message);
    res.status(500).json({ success: false, error: 'Could not load testimonials.' });
  }
});

/**
 * Feedback left on the website by anyone. It is stored UNAPPROVED and never
 * appears on the site until an admin approves it — otherwise the testimonial
 * wall becomes a spam target.
 */
router.post('/feedback', express.json(), async (req, res) => {
  const { user_name, rating, message, location } = req.body || {};
  const name = String(user_name || '').trim().slice(0, 120);
  const text = String(message || '').trim();
  const stars = Number(rating);

  if (name.length < 2) return res.status(400).json({ success: false, error: 'Please tell us your name.' });
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, error: 'Please choose a rating from 1 to 5 stars.' });
  }
  if (text.length < 10) return res.status(400).json({ success: false, error: 'Please write at least a short sentence.' });
  if (text.length > 1000) return res.status(400).json({ success: false, error: 'Please keep it under 1000 characters.' });

  try {
    await db.query(
      `INSERT INTO testimonials (author_name, author_role, location, rating, message, source, is_approved)
       VALUES ($1,$2,$3,$4,$5,'website',false)`,
      [name, String(req.body.author_role || 'Parent').slice(0, 60),
       String(location || '').slice(0, 80) || null, stars, text]);
    res.json({ success: true, message: 'Thank you! Your feedback will appear once we have reviewed it.' });
  } catch (e) {
    console.error('[public] feedback:', e.message);
    res.status(500).json({ success: false, error: 'Could not save your feedback.' });
  }
});

/**
 * The badge catalogue, so the website can show what a child can earn.
 *
 * Catalogue only — no child, no score, no name. Anything identifying belongs
 * behind a token, not on a public marketing page.
 */
router.get('/badges', async (req, res) => {
  try {
    const rows = await cached('badges', async () => (await db.query(
      `SELECT badge_code, badge_name, description, icon, tier
         FROM badges WHERE is_active ORDER BY display_order`)).rows);
    res.json({ success: true, badges: rows });
  } catch (e) {
    console.error('[public] badges:', e.message);
    res.status(500).json({ success: false, error: 'Could not load badges.' });
  }
});

/* --------------------------------------------------------------- enquiries */
const QUERY_TYPES = [
  { code: 'how_it_works', label: 'How does it work?' },
  { code: 'enrolment', label: 'Enrolment / getting started' },
  { code: 'pricing', label: 'Pricing and plans' },
  { code: 'board_grade', label: 'My board or grade is not listed' },
  { code: 'school', label: 'School or bulk enquiry' },
  { code: 'feedback', label: 'Feedback or suggestion' },
  { code: 'other', label: 'Something else' },
];

router.get('/query-types', (req, res) => res.json({ success: true, rows: QUERY_TYPES }));

router.post('/enquiry', express.json(), async (req, res) => {
  const { user_name, mobile_number, email, query_type, message } = req.body || {};
  const name = String(user_name || '').trim().slice(0, 120);
  const mobile = String(mobile_number || '').replace(/\D/g, '').slice(-10);
  const text = String(message || '').trim();

  if (name.length < 2) return res.status(400).json({ success: false, error: 'Please tell us your name.' });
  if (mobile.length !== 10 || !/^[6-9]/.test(mobile)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit mobile number.' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(email))) {
    return res.status(400).json({ success: false, error: 'That email address does not look right.' });
  }
  if (!QUERY_TYPES.some(q => q.code === query_type)) {
    return res.status(400).json({ success: false, error: 'Please choose what your enquiry is about.' });
  }
  if (text.length < 10) return res.status(400).json({ success: false, error: 'Please describe your enquiry in a little more detail.' });
  if (text.length > 2000) return res.status(400).json({ success: false, error: 'Please keep it under 2000 characters.' });

  try {
    // simple flood guard: the same number cannot file more than 3 in an hour
    const { rows: [recent] } = await db.query(
      `SELECT COUNT(*)::int n FROM website_enquiries
        WHERE mobile_number = $1 AND created_at > now() - interval '1 hour'`, [mobile]);
    if (recent.n >= 3) {
      return res.status(429).json({ success: false, error: 'You have already sent a few messages. We will reply shortly.' });
    }

    const { rows: [{ n }] } = await db.query(`SELECT nextval('enquiry_seq')::bigint AS n`);
    const d = new Date();
    const ref = `QE${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${n}`;

    await db.query(
      `INSERT INTO website_enquiries (ref_no, user_name, mobile_number, email, query_type, message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ref, name, mobile, String(email || '').trim() || null, query_type, text]);

    // Operator alert — an enquiry from the public site is a prospective customer.
    try {
      const notify = require('../mail/notify');
      const { fromRequest } = require('../mail/context');
      const label = (await db.query(
        `SELECT label FROM query_types WHERE code=$1`, [query_type]).catch(() => ({ rows: [] })))
        .rows[0]?.label || query_type;
      notify.support({
        ticket: ref,
        category: label,
        subjectLine: `Website enquiry — ${name}`,
        message: text,
        parent: { name, mobile, email: String(email || '').trim() || null, isCustomer: false },
        ctx: fromRequest(req, { channel: 'Website contact form (quizpe.in)' }),
      });
    } catch (e) { console.error('[public] enquiry alert skipped:', e.message); }

    res.json({ success: true, ref_no: ref, message: 'Thank you — we reply within 24–48 hours, during our support hours of 9 AM – 6 PM.' });
  } catch (e) {
    console.error('[public] enquiry:', e.message);
    res.status(500).json({ success: false, error: 'Could not send your enquiry. Please try again.' });
  }
});

module.exports = router;
