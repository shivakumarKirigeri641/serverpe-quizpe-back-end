/**
 * src/routers/reportsRouter.js
 * ---------------------------------------------------------------------------
 * Secured access to report PDFs.
 *
 *   GET  /reports/dl/:token          -> stream a PDF by its unguessable token
 *                                       (used by the direct WhatsApp push and
 *                                       by verified portal links)
 *
 *   Portal (backs public/reports.html) — OTP-gated browsing of past reports:
 *   POST /reports/api/request-otp     -> { mobile }         -> OTP to WhatsApp
 *   POST /reports/api/verify-otp      -> { mobile, otp }    -> session token
 *   GET  /reports/api/list?token=...  -> that parent's reports
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../database/connectDB');
const { REPORTS_ROOT } = require('../pdf/dailyReport');

const router = express.Router();
const OTP_TTL_MIN = 10;
const SESSION_TTL_MIN = 30;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normMobile = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/* --------------------------------------------------------- token file serve */

router.get('/dl/:token', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT file_path, file_name FROM quiz_reports WHERE access_token=$1 AND is_active`,
      [req.params.token]);
    if (!rows.length) return res.status(404).send('Report not found.');

    const abs = path.join(REPORTS_ROOT, rows[0].file_path);
    if (!abs.startsWith(REPORTS_ROOT) || !fs.existsSync(abs)) return res.status(404).send('File missing.');

    await db.query(`UPDATE quiz_reports SET download_count = download_count + 1 WHERE access_token=$1`,
      [req.params.token]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].file_name}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    console.error('[reports] dl failed:', e.message);
    res.status(500).send('Something went wrong.');
  }
});

/* ------------------------------------------------------------- OTP: request */

router.post('/api/request-otp', async (req, res) => {
  try {
    const mobile = normMobile(req.body?.mobile);
    if (mobile.length !== 10) return res.status(400).json({ success: false, error: 'Enter a valid 10-digit mobile number.' });

    // must be a known parent, else we'd leak whether a number is registered
    const known = await db.query(`SELECT 1 FROM parents WHERE parent_mobile_number=$1 AND is_active`, [mobile]);
    if (!known.rowCount) {
      // same response either way — don't reveal registration status
      return res.json({ success: true, message: 'If this number is registered, an OTP has been sent on WhatsApp.' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await db.query(`UPDATE otps SET is_active=false WHERE mobile_number=$1 AND purpose='report_access' AND is_active`, [mobile]);
    await db.query(
      `INSERT INTO otps (mobile_number, purpose, otp_hash, expires_at)
       VALUES ($1,'report_access',$2, now() + ($3 || ' minutes')::interval)`,
      [mobile, sha(otp), String(OTP_TTL_MIN)]);

    try {
      const wa = require('../whatsapp/client');
      await wa.sendText(null, mobile,
        `🔐 Your QuizPe report access code is *${otp}*.\n\nIt is valid for ${OTP_TTL_MIN} minutes. Do not share it with anyone.`);
    } catch (e) { console.error('[reports] OTP send failed:', e.message); }

    res.json({ success: true, message: 'OTP sent on WhatsApp.' });
  } catch (e) {
    console.error('[reports] request-otp failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

/* -------------------------------------------------------------- OTP: verify */

router.post('/api/verify-otp', async (req, res) => {
  try {
    const mobile = normMobile(req.body?.mobile);
    const otp = String(req.body?.otp || '').trim();

    const { rows } = await db.query(
      `SELECT * FROM otps
        WHERE mobile_number=$1 AND purpose='report_access' AND is_active AND verified_at IS NULL
        ORDER BY id DESC LIMIT 1`, [mobile]);
    const rec = rows[0];
    if (!rec) return res.status(400).json({ success: false, error: 'Please request an OTP first.' });
    if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ success: false, error: 'OTP expired. Please request a new one.' });
    if (rec.attempts >= rec.max_attempts) {
      await db.query(`UPDATE otps SET is_active=false WHERE id=$1`, [rec.id]);
      return res.status(429).json({ success: false, error: 'Too many attempts. Please request a new OTP.' });
    }
    if (sha(otp) !== rec.otp_hash) {
      await db.query(`UPDATE otps SET attempts = attempts + 1 WHERE id=$1`, [rec.id]);
      return res.status(400).json({ success: false, error: 'Incorrect OTP.' });
    }

    await db.query(`UPDATE otps SET verified_at=now(), is_active=false WHERE id=$1`, [rec.id]);
    const token = crypto.randomBytes(24).toString('base64url');
    await db.query(
      `INSERT INTO report_sessions (token, mobile_number, expires_at)
       VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
      [token, mobile, String(SESSION_TTL_MIN)]);

    res.json({ success: true, token });
  } catch (e) {
    console.error('[reports] verify-otp failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

/* -------------------------------------------------------- list past reports */

router.get('/api/list', async (req, res) => {
  try {
    const sess = (await db.query(
      `SELECT mobile_number FROM report_sessions WHERE token=$1 AND expires_at > now()`,
      [req.query.token])).rows[0];
    if (!sess) return res.status(401).json({ success: false, error: 'Session expired. Please verify again.' });

    const { rows } = await db.query(
      `SELECT r.quiz_date, r.report_type, sub.subject_name, st.student_name,
              r.score_correct, r.score_total, r.score_pct, r.grade, r.access_token
         FROM quiz_reports r
         JOIN students st ON st.id = r.student_id
         JOIN parents  p  ON p.id = st.parent_id
         LEFT JOIN quizpe_tracker t ON t.id = r.tracker_id
         LEFT JOIN subjects sub     ON sub.id = t.subject_id
        WHERE p.parent_mobile_number = $1 AND r.is_active
        ORDER BY r.quiz_date DESC, r.id DESC`, [sess.mobile_number]);

    const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
    res.json({
      success: true,
      reports: rows.map(r => ({
        quiz_date: r.quiz_date, report_type: r.report_type,
        student_name: r.student_name, subject_name: r.subject_name,
        score: `${r.score_correct}/${r.score_total}`, pct: r.score_pct, grade: r.grade,
        url: `${base}/reports/dl/${r.access_token}`,
      })),
    });
  } catch (e) {
    console.error('[reports] list failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
});

module.exports = router;
