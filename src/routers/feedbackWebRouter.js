/**
 * src/routers/feedbackWebRouter.js
 * ---------------------------------------------------------------------------
 * Backs public/feedback.html — the parent rates the quiz on a web page rather
 * than through chat buttons, so we can collect a star rating, quick tags and a
 * free-text comment in one go instead of a two-step chat exchange.
 *
 *   GET  /feedback/api/context?token=...  -> who this is for, tag choices
 *   POST /feedback/api/submit             -> save, then thank them on WhatsApp
 *
 * The link is single-use: once submitted it is spent, like the quiz link.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database/connectDB');

const router = express.Router();
const TTL_HOURS = 48;                        // a rating is still useful next day
const SPENT = 'Thanks — this feedback has already been submitted.';

/** The three quick-tag chips, per rating mood. */
const TAGS = {
  happy: ['🎯 Right level', '⚡ Quick & fun', '📈 Learning more'],
  unhappy: ['😵 Too hard', '🐌 Too long', '🔁 Repetitive'],
};

/** Mint (or reuse) a feedback link for one quiz. */
async function createFeedbackLink({ sessionId, mobile, trackerId, parentId, studentId, type, planType, periodKey }) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  const existing = trackerId && (await db.query(
    `SELECT token FROM feedback_links
      WHERE tracker_id = $1 AND expires_at > now() AND submitted_at IS NULL`, [trackerId])).rows[0];
  if (existing) return { token: existing.token, url: `${base}/feedback.html?token=${existing.token}` };

  const token = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO feedback_links (token, tracker_id, parent_id, student_id, whatsapp_session_id,
                                 mobile_number, feedback_type, plan_type, period_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10||' hours')::interval)
     ON CONFLICT (tracker_id) WHERE tracker_id IS NOT NULL DO UPDATE
       SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, submitted_at = NULL`,
    [token, trackerId || null, parentId || null, studentId || null, sessionId || null,
     mobile, type || null, planType || null, periodKey || null, String(TTL_HOURS)]);
  return { token, url: `${base}/feedback.html?token=${token}` };
}

async function load(token) {
  const { rows } = await db.query(
    `SELECT fl.*, st.student_name, p.parent_name,
            sub.subject_name, t.quiz_date,
            r.score_correct, r.score_total, r.score_pct, r.grade
       FROM feedback_links fl
       LEFT JOIN students st ON st.id = fl.student_id
       LEFT JOIN parents  p  ON p.id  = fl.parent_id
       LEFT JOIN quizpe_tracker t ON t.id = fl.tracker_id
       LEFT JOIN subjects sub     ON sub.id = t.subject_id
       LEFT JOIN quiz_reports r   ON r.tracker_id = fl.tracker_id
      WHERE fl.token = $1 AND fl.expires_at > now()`, [token]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ context */
router.get('/api/context', async (req, res) => {
  try {
    const l = await load(req.query.token);
    if (!l) return res.status(410).json({ success: false, error: 'This feedback link has expired.' });
    if (l.submitted_at) return res.status(410).json({ success: false, error: SPENT });
    res.json({
      success: true,
      student: l.student_name, parent: l.parent_name, subject: l.subject_name,
      score: l.score_total ? { correct: l.score_correct, total: l.score_total, pct: l.score_pct, grade: l.grade } : null,
      tags: TAGS,
    });
  } catch (e) {
    console.error('[feedbackweb] context failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
});

/* ------------------------------------------------------------------- submit */
router.post('/api/submit', async (req, res) => {
  // declared out here so the catch can hand the link back on failure
  let claimedId = null, saved = false;
  try {
    const { token, rating, tags, message } = req.body || {};
    const l = await load(token);
    if (!l) return res.status(410).json({ success: false, error: 'This feedback link has expired.' });
    if (l.submitted_at) return res.status(410).json({ success: false, error: SPENT });

    // Validate server-side too — the page checks, but the page is not trusted.
    const stars = Number(rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, error: 'Please choose a rating from 1 to 5 stars.' });
    }
    const allowed = [...TAGS.happy, ...TAGS.unhappy];
    const picked = Array.isArray(tags) ? tags.filter(t => allowed.includes(t)).slice(0, 3) : [];
    const note = String(message || '').trim().slice(0, 1000);
    // A low rating without a reason tells us nothing actionable.
    if (stars <= 2 && !note && !picked.length) {
      return res.status(400).json({
        success: false,
        error: 'Please tell us what went wrong — pick a tag or leave a short note.',
      });
    }

    // Claim the link first so a double submit can't write two rows.
    const claimed = await db.query(
      `UPDATE feedback_links SET submitted_at = now()
        WHERE id = $1 AND submitted_at IS NULL`, [l.id]);
    if (!claimed.rowCount) return res.status(410).json({ success: false, error: SPENT });
    claimedId = l.id;   // from here a failure must hand the link back

    // markAsked() already wrote a placeholder row for this period (that's how
    // "don't nag again tomorrow" works), and fb_once_per_period enforces one
    // row per parent per period — so fill that row in rather than inserting.
    await db.query(
      `INSERT INTO feedbacks (parent_id, student_id, tracker_id, mobile_number, user_name,
                              rating, message, tags, feedback_type, plan_type, period_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT ON CONSTRAINT fb_once_per_period DO UPDATE SET
         rating      = EXCLUDED.rating,
         message     = COALESCE(EXCLUDED.message, feedbacks.message),
         tags        = COALESCE(EXCLUDED.tags, feedbacks.tags),
         tracker_id  = COALESCE(EXCLUDED.tracker_id, feedbacks.tracker_id),
         user_name   = COALESCE(EXCLUDED.user_name, feedbacks.user_name),
         modified_at = now()`,
      [l.parent_id, l.student_id, l.tracker_id, l.mobile_number, l.parent_name,
       stars, note || null, picked.length ? picked : null,
       l.feedback_type, l.plan_type, l.period_key]);
    saved = true;

    // Thank them in chat, naming their own next quiz time.
    let thanks = null;
    try {
      const wa = require('../whatsapp/client');
      const M = require('../whatsapp/messages');
      const t = (await db.query(
        `SELECT quiz_time FROM parents_quizpe_subscriptions
          WHERE parent_id = $1 AND is_active ORDER BY id DESC LIMIT 1`, [l.parent_id])).rows[0];
      const at = t ? ` at *${M.fmtTime(t.quiz_time)}*` : '';
      thanks = stars >= 4
        ? `🙏 *Thank you, ${l.parent_name || 'there'}!*\n\nSo glad ${l.student_name || 'your child'} is enjoying it. See you tomorrow${at} for the next quiz! 🚀`
        : `🙏 *Thank you for the honest feedback.*\n\nWe read every message and we'll use this to make the questions better for ${l.student_name || 'your child'}. See you tomorrow${at}! 🚀`;
      await wa.sendText(l.whatsapp_session_id, l.mobile_number, thanks);
    } catch (e) {
      console.error('[feedbackweb] thank-you message failed:', e.message);
    }

    const n = String(process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
    res.json({ success: true, rating: stars, whatsapp_url: n ? `https://wa.me/${n}` : null });
  } catch (e) {
    console.error('[feedbackweb] submit failed:', e.message);
    // never leave a link spent on a feedback we failed to store
    if (claimedId && !saved) {
      await db.query(`UPDATE feedback_links SET submitted_at = NULL WHERE id = $1`, [claimedId])
        .catch(() => {});
    }
    res.status(500).json({ success: false, error: 'Could not save your feedback.' });
  }
});

module.exports = router;
module.exports.createFeedbackLink = createFeedbackLink;
module.exports.TAGS = TAGS;
