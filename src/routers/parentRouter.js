/**
 * src/routers/parentRouter.js
 * ---------------------------------------------------------------------------
 * Top-level router. Everything the API exposes is mounted here, then app.js
 * mounts this single router. Add new feature routers with router.use(...).
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const { getQuizpePlans } = require('../get/quizpePlans');
const { getQuizpeAddons } = require('../get/quizpeAddons');

const router = express.Router();

// GET /quizpe-plans -> active subscription plans
router.get('/quizpe-plans', async (req, res) => {
  try {
    const plans = await getQuizpePlans();
    res.json({ success: true, count: plans.length, data: plans });
  } catch (e) {
    console.error('[quizpe-plans] query failed:', e.message);
    res.status(500).json({ success: false, error: 'Failed to load plans' });
  }
});

// GET /quizpe-addons -> active subject add-ons (extra subjects beyond Maths)
router.get('/quizpe-addons', async (req, res) => {
  try {
    const addons = await getQuizpeAddons();
    res.json({ success: true, count: addons.length, data: addons });
  } catch (e) {
    console.error('[quizpe-addons] query failed:', e.message);
    res.status(500).json({ success: false, error: 'Failed to load add-ons' });
  }
});

module.exports = router;
