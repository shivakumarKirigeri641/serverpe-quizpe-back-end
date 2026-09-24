/**
 * src/whatsapp/freeAccess.js
 * ---------------------------------------------------------------------------
 * Free access for a date range — the entitlement half of the admin's
 * "Free access" page.
 *
 * WHAT THIS IS NOT. It is not a subscription and it never becomes one: no plan
 * row, no invoice, no GST record, nothing to cancel or refund. A family inside
 * a window is simply allowed to take quizzes, and when the window closes they
 * are exactly where they were before it opened. That matters — writing a fake
 * subscription to grant free access would put a row in the table the finance
 * page, the GST return and the renewal reminders all read from.
 *
 * It also does NOT grant a free trial. The trial is once per number and is
 * tracked separately; a school demo in March must not spend the trial a family
 * might want in April.
 *
 * WHY THE WHOLE-DAY CHECK IS `BETWEEN`. A window runs to the END of its last
 * day. An admin who types 1–15 means the 15th is included, and a family taking
 * their quiz at 9 PM on the 15th would be surprised to find it already shut.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

/**
 * The live window covering this child today, or null.
 *
 * A campaign with no student_id covers every child of that parent — the common
 * case, because an admin granting free access is thinking about a family, not
 * about one of their children. A campaign naming a student covers only that
 * child, and wins when both exist: the narrower grant is the more deliberate one.
 */
async function forStudent(studentId, exec = db) {
  if (!studentId) return null;
  const { rows } = await exec.query(
    `SELECT c.id, c.start_date, c.end_date, c.slots_per_day, c.reason
       FROM free_quiz_campaigns c
       JOIN students st ON st.id = $1 AND st.parent_id = c.parent_id
      WHERE c.is_active
        AND CURRENT_DATE BETWEEN c.start_date AND c.end_date
        AND (c.student_id IS NULL OR c.student_id = $1)
      ORDER BY c.student_id NULLS LAST, c.slots_per_day DESC
      LIMIT 1`, [studentId]);
  return rows[0] || null;
}

/** Is any child of this parent inside a live window right now? */
async function forParent(parentId, exec = db) {
  if (!parentId) return null;
  const { rows } = await exec.query(
    `SELECT id, start_date, end_date, slots_per_day, reason
       FROM free_quiz_campaigns
      WHERE is_active AND parent_id = $1
        AND CURRENT_DATE BETWEEN start_date AND end_date
      ORDER BY slots_per_day DESC
      LIMIT 1`, [parentId]);
  return rows[0] || null;
}

module.exports = { forStudent, forParent };
