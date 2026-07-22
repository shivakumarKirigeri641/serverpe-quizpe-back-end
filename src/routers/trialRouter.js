/**
 * src/routers/trialRouter.js
 * ---------------------------------------------------------------------------
 * Backs public/trial.html — the one-page free-trial signup form that the
 * WhatsApp bot links to.
 *
 *   GET  /trial/api/context?token=...  -> dropdown data + who the link is for
 *   POST /trial/api/submit             -> creates parent + student + trial
 *
 * The token is single-use and short-lived, so the page needs no login.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database/connectDB');

const router = express.Router();
const TOKEN_TTL_MINUTES = 60;

/** Mint a signup link for a WhatsApp session. */
async function createSignupLink(sessionId, mobile, parentName) {
  const token = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO signup_links (token, session_id, mobile_number, parent_name, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
    [token, sessionId, mobile, parentName || null, String(TOKEN_TTL_MINUTES)]);

  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  return { token, url: `${base}/trial.html?token=${token}` };
}

/**
 * Deep link back into the WhatsApp chat with our business number.
 * wa.me works on mobile and desktop; the prefilled text is optional.
 */
function waDeepLink(prefill) {
  const num = String(process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
  if (!num) return null;
  return `https://wa.me/${num}${prefill ? `?text=${encodeURIComponent(prefill)}` : ''}`;
}

async function loadToken(token) {
  const { rows } = await db.query(
    `SELECT * FROM signup_links
      WHERE token=$1 AND is_active AND used_at IS NULL AND expires_at > now()`, [token]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ context */

router.get('/api/context', async (req, res) => {
  try {
    const link = await loadToken(req.query.token);
    if (!link) return res.status(410).json({ success: false, error: 'This link has expired or was already used.' });

    const { getAvailability } = require('../content/availability');
    const [avail, boards, mediums, grades, states, plan, policy, biz] = await Promise.all([
      // only board/grade/medium combos that actually have questions
      getAvailability(),
      db.query(`SELECT board_code, board_name FROM boards WHERE is_active ORDER BY display_order`),
      db.query(`SELECT m.medium_code, m.medium_name, m.native_name, b.board_code
                  FROM board_mediums bm
                  JOIN boards b  ON b.id = bm.board_id
                  JOIN mediums m ON m.id = bm.medium_id
                 WHERE bm.is_active AND m.is_active AND b.is_active
                 ORDER BY b.display_order, m.display_order`),
      db.query(`SELECT grade_code, grade_name FROM grades WHERE is_active ORDER BY display_order`),
      db.query(`SELECT state_code, state_name FROM states_unions WHERE is_active ORDER BY state_name`),
      db.query(`SELECT plan_name, plan_description, duration FROM quizpe_plans
                  WHERE is_trial AND is_active ORDER BY id LIMIT 1`),
      db.query(`SELECT title, url FROM policies WHERE policy_code='trial_conditions' AND is_active ORDER BY id DESC LIMIT 1`),
      db.query(`SELECT product_name, product_tagline, company_name, support_email FROM business_details WHERE is_active LIMIT 1`),
    ]);

    // medium options grouped by board, so the form can filter as you pick
    const mediumsByBoard = {};
    for (const m of mediums.rows) {
      (mediumsByBoard[m.board_code] ||= []).push(
        { medium_code: m.medium_code, label: m.native_name || m.medium_name });
    }

    res.json({
      success: true,
      parentName: link.parent_name,
      mobile: link.mobile_number,
      // content-driven: a parent can only pick something we can deliver
      availability: avail.availability,
      boards: avail.boards,
      mediumsByBoard,
      grades: avail.grades,
      states: states.rows,
      plan: plan.rows[0],
      policy: policy.rows[0],
      business: biz.rows[0],
    });
  } catch (e) {
    console.error('[trial] context failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

/* ------------------------------------------------------------------- submit */

router.post('/api/submit', async (req, res) => {
  const { token, student_name, school_name, board, medium, grade, state, accept_terms } = req.body || {};
  try {
    const link = await loadToken(token);
    if (!link) return res.status(410).json({ success: false, error: 'This link has expired or was already used.' });
    if (!accept_terms) return res.status(400).json({ success: false, error: 'Please accept the terms to continue.' });

    const name = String(student_name || '').trim().slice(0, 60);
    if (name.length < 2) return res.status(400).json({ success: false, error: "Please enter your child's name." });

    // validate every choice against the DB rather than trusting the form
    const checks = await Promise.all([
      db.query(`SELECT id FROM boards  WHERE board_code=$1  AND is_active`, [board]),
      db.query(`SELECT id FROM mediums WHERE medium_code=$1 AND is_active`, [medium]),
      db.query(`SELECT id FROM grades  WHERE grade_code=$1  AND is_active`, [grade]),
      db.query(`SELECT state_code FROM states_unions WHERE state_code=$1 AND is_active`, [state]),
    ]);
    const labels = ['board', 'medium', 'grade', 'state'];
    const bad = labels.filter((_, i) => checks[i].rowCount === 0);
    if (bad.length) return res.status(400).json({ success: false, error: `Invalid ${bad.join(', ')}.` });

    // one trial per mobile number
    const used = await db.query(
      `SELECT 1 FROM parents p
         JOIN parents_quizpe_subscriptions s ON s.parent_id = p.id
         JOIN quizpe_plans pl ON pl.id = s.plan_id
        WHERE p.parent_mobile_number = $1 AND pl.is_trial`, [link.mobile_number]);
    if (used.rowCount) {
      return res.status(409).json({ success: false, error: 'A free trial has already been used on this number.' });
    }

    const c = await db.getClient();
    try {
      await c.query('BEGIN');
      const parentId = (await c.query(
        `INSERT INTO parents (parent_name, parent_mobile_number, state_code)
         VALUES ($1,$2,$3)
         ON CONFLICT (parent_mobile_number) DO UPDATE
           SET state_code=EXCLUDED.state_code, modified_at=now()
         RETURNING id`,
        [link.parent_name || 'Parent', link.mobile_number, state])).rows[0].id;

      await c.query(
        `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name, school_name)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (parent_id, student_name) DO UPDATE
           SET board_id=EXCLUDED.board_id, grade_id=EXCLUDED.grade_id,
               medium_id=EXCLUDED.medium_id,
               -- optional field: never wipe a stored school with a blank
               school_name=COALESCE(EXCLUDED.school_name, students.school_name),
               modified_at=now()`,
        [parentId, checks[0].rows[0].id, checks[2].rows[0].id, checks[1].rows[0].id, name,
         String(school_name || '').trim().slice(0, 120) || null]);

      // The form is filtered, but a crafted POST is not — refuse anything we
      // cannot actually deliver rather than creating a doomed subscription.
      const { isDeliverable } = require('../content/availability');
      if (!await isDeliverable(board, grade, medium)) {
        await c.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'We do not have quiz content for that board, grade and medium yet. Please pick another combination.',
        });
      }

      // Supersede any earlier subscription for this parent — only one may be
      // active at a time, so the daily sweep can never pick up two.
      await c.query(
        `UPDATE parents_quizpe_subscriptions
            SET is_active=false, modified_at=now()
          WHERE parent_id=$1 AND is_active`, [parentId]);

      // The trial is whichever plan is flagged is_trial — its length comes from
      // the plan row, so changing `duration` in the DB changes the trial with
      // no code edit. Refuse rather than guess if no trial is on offer.
      const trial = (await c.query(
        `SELECT id, duration FROM quizpe_plans WHERE is_trial AND is_active ORDER BY id LIMIT 1`)).rows[0];
      if (!trial) throw new Error('NO_ACTIVE_TRIAL_PLAN');

      // spread the evening load instead of putting everyone at 8 PM
      const { slotFor } = require('../whatsapp/quizSlot');
      const slot = slotFor(parentId);

      const sub = (await c.query(
        `INSERT INTO parents_quizpe_subscriptions
           (parent_id, plan_id, plan_end_date, quiz_time, reminder_time)
         VALUES ($1, $2, CURRENT_DATE + $3::int, $4::time, $5::time)
         RETURNING id, plan_end_date, quiz_time`,
        [parentId, trial.id, trial.duration, slot.quiz_time, slot.reminder_time])).rows[0];

      await c.query(`UPDATE signup_links SET used_at=now(), is_active=false WHERE id=$1`, [link.id]);
      if (link.session_id) {
        await c.query(`UPDATE whatsapp_sessions SET parent_id=$2, state='active', modified_at=now() WHERE id=$1`,
          [link.session_id, parentId]);
        await c.query(
          `INSERT INTO whatsapp_session_events (session_id, from_state, to_state, event, payload)
           VALUES ($1,'awaiting_form','active','trial_activated',$2)`,
          [link.session_id, JSON.stringify({ via: 'web_form', subscription_id: sub.id })]);
      }
      await c.query('COMMIT');

      // confirm on WhatsApp (never let a send failure roll back the signup)
      try {
        const wa = require('../whatsapp/client');
        const M = require('../whatsapp/messages');
        const gradeName = (await db.query(`SELECT grade_name FROM grades WHERE grade_code=$1`, [grade])).rows[0].grade_name;
        await wa.sendText(link.session_id, link.mobile_number, M.trialActivated({
          studentName: name, boardCode: board, gradeName,
          endDate: sub.plan_end_date, quizTime: sub.quiz_time, duration: trial.duration,
        }));
      } catch (e) {
        console.error('[trial] confirmation message failed:', e.message);
      }

      res.json({
        success: true,
        student_name: name,
        end_date: sub.plan_end_date,
        quiz_time: sub.quiz_time,
        // deep link back into the WhatsApp chat (no prefilled message)
        whatsapp_url: waDeepLink(),
      });
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    console.error('[trial] submit failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
module.exports.createSignupLink = createSignupLink;
