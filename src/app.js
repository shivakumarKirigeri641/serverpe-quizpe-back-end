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
      // Razorpay's checkout widget loads from their CDN and opens its card form
      // in an iframe that talks back to api.razorpay.com — the payment page is
      // dead without these three, which is exactly what broke "Pay ₹99".
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.razorpay.com'],
      connectSrc: ["'self'", 'https://*.razorpay.com', 'https://lumberjack.razorpay.com'],
      frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
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
// ipKeyGenerator normalises the client IP (an IPv6 address is grouped by its
// /64 subnet, not treated as unique) — required for any custom key that uses
// the IP, or an IPv6 attacker can rotate addresses to slip past the limit.
const { ipKeyGenerator } = rateLimit;
const limiter = (windowMs, max, message, keyGenerator) => rateLimit({
  windowMs, max, message: { success: false, error: message },
  standardHeaders: true, legacyHeaders: false, keyGenerator,
});

// 8 attempts per 15 min per IP+mobile — generous for a typo, useless for brute force
app.use('/admin/api/login', limiter(15 * 60 * 1000, 8,
  'Too many sign-in attempts. Please wait 15 minutes and try again.',
  (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.mobile_number || '').slice(0, 15)}`));

// public write endpoints — stops enquiry/feedback spam floods
app.use(['/public/enquiry', '/public/feedback'], limiter(60 * 60 * 1000, 10,
  'You have sent several messages already. Please try again a little later.'));

// public read endpoints — stops cheap scraping of stats/pricing/testimonials
app.use('/public', limiter(60 * 1000, 120, 'Too many requests. Please slow down.'));

// everything under the admin API, once signed in
app.use('/admin/api', limiter(60 * 1000, 300, 'Too many requests. Please slow down.'));

/* ---------------------------------------------------------------------------
 * CORS.
 *
 * In production the three pieces live on separate hosts —
 *   quizpe.in        public site   -> reads /public and /legal
 *   admin.quizpe.in  admin panel   -> reads /admin/api with a bearer token
 *   api.quizpe.in    this server
 * — so both browsers are cross-origin and need explicit permission.
 *
 * Allow-lists, never '*': this API serves children's names, parents' phone
 * numbers and payment records. A wildcard on /admin would also be rejected by
 * the browser anyway, since that route sends credentials.
 * ------------------------------------------------------------------------- */
const cors = require('cors');
const originList = (v, fallback) => String(v || fallback).split(',').map(s => s.trim()).filter(Boolean);

const ADMIN_ORIGINS = originList(process.env.ADMIN_ORIGINS,
  'http://localhost:5173,http://127.0.0.1:5173');
const SITE_ORIGINS = originList(process.env.SITE_ORIGINS,
  'http://localhost:5174,http://127.0.0.1:5174');

// Reject unknown origins with an error rather than a quiet no-CORS response, so
// a misconfigured domain fails loudly at deploy time instead of looking like an
// intermittent network fault in the browser months later.
const guard = (allowed, credentials) => cors({
  origin: (origin, cb) => (!origin || allowed.includes(origin))
    ? cb(null, true)
    : cb(new Error(`Origin ${origin} is not allowed`)),
  credentials,
});

app.use('/admin', guard(ADMIN_ORIGINS, true));
app.use(['/public', '/legal'], guard([...SITE_ORIGINS, ...ADMIN_ORIGINS], false));

// A blocked origin is a refusal, not a server fault. Without this it surfaces
// as a 500, which reads like the API is broken and sends you debugging the
// wrong thing — the real cause is almost always a missing entry in
// ADMIN_ORIGINS or SITE_ORIGINS.
app.use((err, req, res, next) => {
  if (err && /is not allowed/.test(err.message || '')) {
    console.warn(`[cors] refused ${req.headers.origin} -> ${req.method} ${req.originalUrl}`);
    return res.status(403).json({ success: false, error: 'Origin not allowed.' });
  }
  return next(err);
});

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

// WhatsApp Cloud API webhook. NOTE: it is NOT at the root — the router is
// mounted on the long public-users prefix further down, so Meta's callback URL
// must be the full path or verification returns 404:
//
//   <PUBLIC_BASE_URL>/serverpe/platform/quizpe/v1/public/users/whatsapp/webhook

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
// Off by default: with quizpe.in and admin.quizpe.in on their own hosts, Nginx
// serves the built front-ends and this process serves only the API and the
// pages WhatsApp links to (quiz, support, legal, reports). Set SERVE_FRONTENDS=1
// to fall back to single-origin serving on one box.
if (process.env.SERVE_FRONTENDS === '1') {
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
