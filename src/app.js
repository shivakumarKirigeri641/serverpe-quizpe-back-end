/**
 * src/app.js
 * ---------------------------------------------------------------------------
 * Express application entry point. Loads env, mounts the parent router, and
 * starts the HTTP server on PORT (from .env, default 5008).
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const parentRouter = require('./routers/parentRouter');
const whatsappRouter = require('./routers/whatsappRouter');
const trialRouter = require('./routers/trialRouter');
const reportsRouter = require('./routers/reportsRouter');
const paymentRouter = require('./routers/paymentRouter');
const quizWebRouter = require('./routers/quizWebRouter');
const feedbackWebRouter = require('./routers/feedbackWebRouter');
const supportWebRouter = require('./routers/supportWebRouter');
const adminRouter = require('./routers/adminRouter');

const app = express();

// The admin panel runs on its own dev server, so it needs CORS. Locked to an
// allow-list rather than '*' — this API serves children's and payment data.
const cors = require('cors');
const ADMIN_ORIGINS = String(process.env.ADMIN_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use('/admin', cors({
  origin: (origin, cb) => cb(null, !origin || ADMIN_ORIGINS.includes(origin)),
  credentials: true,
}));

// Body parsers — WhatsApp posts JSON.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static pages (public/trial.html — the free-trial signup form).
app.use(express.static(path.join(__dirname, '..', 'public')));

// Reports are served ONLY via unguessable tokens / OTP portal — never as
// static files — so one parent can't reach another child's report.

// Health check.
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'quizpe-back-end' }));

// WhatsApp Cloud API webhook — mounted at root so Meta's callback URL stays
// short: <PUBLIC_BASE_URL>/whatsapp/webhook

// Free-trial signup form APIs (backs public/trial.html).
app.use('/trial', trialRouter);

// Report PDFs — token download + OTP-gated portal (backs public/reports.html).
app.use('/reports', reportsRouter);

// Razorpay checkout for paid plans (backs public/pay.html).
app.use('/pay', paymentRouter);

// Web quiz — full option text, instant next question (backs public/quiz.html).
app.use('/quiz', quizWebRouter);

// Star rating + tags + comment (backs public/feedback.html).
app.use('/feedback', feedbackWebRouter);

// Support request form (backs public/support.html).
app.use('/support', supportWebRouter);

// Admin panel API (serverpe-quizpe-admin-front-end). Everything except
// /admin/api/login requires a bearer token.
app.use('/admin/api', adminRouter);

// All application routes.
app.use('/serverpe/platform/quizpe/v1/public/users', parentRouter);
app.use('/serverpe/platform/quizpe/v1/public/users', whatsappRouter);

// Report filename sequences — created once, seeded past existing reports.
require('./pdf/reportNumber').ensureSequences()
  .catch((e) => console.error('[startup] report sequences failed:', e.message));

// Invoice numbering sequence — atomic, so concurrent payments can never collide.
require('./pdf/invoice').ensureInvoiceSequence()
  .catch((e) => console.error('[startup] invoice sequence failed:', e.message));

// Durable background worker (report rendering, feedback asks). Survives a
// restart and is safe to run from several processes at once.
require('./jobs/handlers').registerAll();
require('./jobs/jobQueue').start();

// Daily reminder + quiz-trigger jobs (skips templates Meta hasn't approved).
require('./jobs/scheduler').startScheduler();

const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`✅quizpe-back-end listening on http://localhost:${PORT}`);
});

module.exports = app;
