/**
 * src/app.js
 * ---------------------------------------------------------------------------
 * Express application entry point. Loads env, mounts the parent router, and
 * starts the HTTP server on PORT (from .env, default 5009).
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const parentRouter = require('./routers/parentRouter');
const whatsappRouter = require('./routers/whatsappRouter');

const app = express();

// Body parsers — WhatsApp posts JSON.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check.
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'quizpe-back-end' }));

// WhatsApp Cloud API webhook — mounted at root so Meta's callback URL stays
// short: <PUBLIC_BASE_URL>/whatsapp/webhook
app.use('/', whatsappRouter);

// All application routes.
app.use('/serverpe/platform/quizpe/v1/public/users', parentRouter);

const PORT = process.env.PORT || 5009;
app.listen(PORT, () => {
  console.log(`quizpe-back-end listening on http://localhost:${PORT}`);
});

module.exports = app;
