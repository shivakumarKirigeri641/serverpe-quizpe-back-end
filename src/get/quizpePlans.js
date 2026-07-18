/**
 * src/get/quizpePlans.js
 * ---------------------------------------------------------------------------
 * Read query for the public plans list. Returns active plans, cheapest first.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

async function getQuizpePlans() {
  const { rows } = await db.query(
    `SELECT id, plan_code, plan_name, plan_description,
            price, comparable_price, student_count, duration,
            is_trial, is_active
       FROM quizpe_plans
      WHERE is_active = true
      ORDER BY price ASC`,
  );
  return rows;
}

module.exports = { getQuizpePlans };
