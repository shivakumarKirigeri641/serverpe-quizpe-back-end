/**
 * src/get/quizpeAddons.js
 * ---------------------------------------------------------------------------
 * Read query for subject add-ons (extra subjects on top of the base Maths
 * plan). Joins `subjects` so callers get the subject name/code, not just an id.
 *
 * Only active add-ons are returned — an add-on is activated once its subject
 * actually has questions in question_bank.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

async function getQuizpeAddons() {
  const { rows } = await db.query(
    `SELECT a.id,
            a.subject_id,
            s.subject_code,
            s.subject_name,
            s.subject_description,
            a.price,
            a.comparable_price,
            ROUND((a.comparable_price - a.price)
                  / NULLIF(a.comparable_price, 0) * 100)::int AS discount_percentage,
            a.is_active
       FROM quizpe_addons a
       JOIN subjects s ON s.id = a.subject_id
      WHERE a.is_active = true
      ORDER BY s.display_order`,
  );
  return rows;
}

module.exports = { getQuizpeAddons };
