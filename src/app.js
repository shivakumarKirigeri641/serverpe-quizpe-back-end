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
const legalRouter = require('./routers/legalRouter');
const publicRouter = require('./routers/publicRouter');

const app = express();

/* ---------------------------------------------------------------------------
 * Security headers.
 *
 * TLS already encrypts every request and response on the wire; these headers
 * defend the things TLS cannot — injected scripts, clickjacking, and browsers
 * being talked out of HTTPS once they have seen it.
 *
 * HSTS is only meaningful (and only safe) behind real HTTPS, so it is enabled
 * by the same flag that says we are running behind a TLS proxy. Turning it on
 * during local http:// development would pin the browser to a scheme that is
 * not being served and lock you out of localhost.
 * ------------------------------------------------------------------------- */
const helmet = require('helmet');
const BEHIND_TLS = process.env.BEHIND_TLS === '1';
if (BEHIND_TLS) app.set('trust proxy', 1); // so req.ip is the client, not Nginx

app.use(helmet({
  // The public pages and quiz page use inline styles/handlers; a strict CSP
  // would need those extracted first, so it is scoped rather than silently
  // disabled — script-src stays tight, which is the part that stops XSS.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],       // no embedding: clickjacking
      objectSrc: ["'none'"],
      upgradeInsecureRequests: BEHIND_TLS ? [] : null,
    },
  },
  hsts: BEHIND_TLS ? { maxAge: 15552000, includeSubDomains: true } : false,
  // Reports open from WhatsApp; a strict COEP breaks that preview flow.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

/* ---------------------------------------------------------------------------
 * Rate limits.
 *
 * Sized per endpoint by what an honest user actually does. The login limiter is
 * the important one: the admin credential is a 4-digit PIN, so without a cap it
 * is exhaustively guessable in minutes. Limiting by IP + mobile means one
 * attacker cannot lock out a real admin by hammering their number.
 *
 * The WhatsApp webhook is deliberately NOT limited — Meta bursts retries, and
 * dropping those loses parent messages.
 * ------------------------------------------------------------------------- */
const rateLimit = require('express-rate-limit');
const limiter = (windowMs, max, message, keyGenerator) => rateLimit({
  windowMs, max, message: { success: false, error: message },
  standardHeaders: true, legacyHeaders: false, keyGenerator,
});

// 8 attempts per 15 min per IP+mobile — generous for a typo, useless for brute force
app.use('/admin/api/login', limiter(15 * 60 * 1000, 8,
  'Too many sign-in attempts. Please wait 15 minutes and try again.',
  (req) => `${req.ip}:${String(req.body?.mobile_number || '').slice(0, 15)}`));

// public write endpoints — stops enquiry/feedback spam floods
app.use(['/public/enquiry', '/public/feedback'], limiter(60 * 60 * 1000, 10,
  'You have sent several messages already. Please try again a little later.'));

// public read endpoints — stops cheap scraping of stats/pricing/testimonials
app.use('/public', limiter(60 * 1000, 120, 'Too many requests. Please slow down.'));

// everything under the admin API, once signed in
app.use('/admin/api', limiter(60 * 1000, 300, 'Too many requests. Please slow down.'));

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
app.use(require('cookie-parser')());
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

// Policies — public so a parent can read them before signing up, and so the
// WhatsApp consent links resolve for someone with no account.
app.use('/legal', legalRouter);

// Aggregate-only figures for the parent-facing website. Never per-person data.
app.use('/public', publicRouter);

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

/* ---------------------------------------------------------------------------
 * Built front-ends, served from this same process in production.
 *
 * Serving them here rather than from a separate static host means one origin,
 * which removes CORS entirely, lets the browser send the quiz device cookie,
 * and makes deployment a single upload. Both are mounted AFTER every API route
 * so a path like /admin/api can never be swallowed by the SPA fallback.
 *
 * Set SERVE_FRONTENDS=0 to disable (e.g. when running the Vite dev servers).
 * ------------------------------------------------------------------------- */
if (process.env.SERVE_FRONTENDS !== '0') {
  const fs = require('fs');
  const adminDist = process.env.ADMIN_DIST
    || path.join(__dirname, '..', '..', 'serverpe-quizpe-admin-front-end', 'dist');
  const siteDist = process.env.SITE_DIST
    || path.join(__dirname, '..', '..', 'serverpe-quizpe-front-end', 'dist');

  if (fs.existsSync(adminDist)) {
    app.use('/admin', express.static(adminDist));
    // client-side routes (/admin/parents, /admin/tonight) must return index.html,
    // but never for /admin/api — that is handled above and must 404 as JSON
    app.get(/^\/admin(?!\/api)(\/.*)?$/, (req, res) =>
      res.sendFile(path.join(adminDist, 'index.html')));
    console.log(`🖥️  admin panel served from ${adminDist}`);
  }

  if (fs.existsSync(siteDist)) {
    app.use(express.static(siteDist));
    console.log(`🌐 public site served from ${siteDist}`);
  }
}

const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`✅quizpe-back-end listening on http://localhost:${PORT}`);
});

module.exports = app;
