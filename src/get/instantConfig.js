/**
 * src/get/instantConfig.js
 * ---------------------------------------------------------------------------
 * Admin-configurable Instant Quiz settings: the ex-GST price and the number of
 * questions. Stored as JSON in app_settings.instant_quiz and editable from the
 * admin panel. Falls back to ₹9 / 12 questions if unset or malformed, so the
 * feature never breaks on a bad value.
 * ---------------------------------------------------------------------------
 */
const db = require('../database/connectDB');

async function instantConfig(exec = db) {
  try {
    const { rows } = await exec.query(`SELECT value FROM app_settings WHERE key='instant_quiz'`);
    const v = rows[0]?.value ? JSON.parse(rows[0].value) : {};
    const price = Number(v.price);
    const questions = Number(v.questions);
    return {
      price: price > 0 ? price : 9,
      questions: (Number.isInteger(questions) && questions >= 4 && questions <= 50) ? questions : 12,
    };
  } catch {
    return { price: 9, questions: 12 };
  }
}

module.exports = { instantConfig };
