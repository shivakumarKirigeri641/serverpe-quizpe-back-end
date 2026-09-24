/**
 * scripts/test-free-access.js — a free-access window really does open the quiz
 * for a family with no subscription, really does set the quizzes-per-day, and
 * really does close again.
 *
 * Runs against whatever database .env points at, inside a transaction that is
 * ALWAYS rolled back, so it can be pointed at a restored copy of production
 * without leaving anything behind. Nothing is sent to anybody.
 *
 *   node scripts/test-free-access.js
 */

require('dotenv').config();
const db = require('../src/database/connectDB');
const freeAccess = require('../src/whatsapp/freeAccess');

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

(async () => {
  const c = await db.getClient();
  console.log(`\nFree access — against ${process.env.PGDATABASE} (rolled back at the end)\n`);
  try {
    await c.query('BEGIN');

    /* A real family whose plan has expired — exactly who this feature is for. */
    const { rows: [fam] } = await c.query(
      `SELECT p.id AS parent_id, p.parent_name, st.id AS student_id
         FROM parents p JOIN students st ON st.parent_id = p.id AND st.is_active
        WHERE NOT EXISTS (
          SELECT 1 FROM parents_quizpe_subscriptions s
           WHERE s.parent_id = p.id AND s.is_active
             AND CURRENT_DATE BETWEEN s.plan_start_date AND s.plan_end_date)
        ORDER BY p.id LIMIT 1`);
    if (!fam) { console.log('  (no unsubscribed family in this database — nothing to test)'); process.exit(0); }
    console.log(`  using ${fam.parent_name} (parent ${fam.parent_id}, student ${fam.student_id})\n`);

    check(!(await freeAccess.forStudent(fam.student_id, c)),
      'with no window, the child has no free access');

    /* A window that has not started yet must not open anything. */
    await c.query(
      `INSERT INTO free_quiz_campaigns (parent_id, start_date, end_date, slots_per_day, reason)
       VALUES ($1, CURRENT_DATE + 5, CURRENT_DATE + 9, 3, 'future')`, [fam.parent_id]);
    check(!(await freeAccess.forStudent(fam.student_id, c)),
      'a window starting next week does not open the quiz today');

    /* A window covering today does. */
    const { rows: [live] } = await c.query(
      `INSERT INTO free_quiz_campaigns (parent_id, start_date, end_date, slots_per_day, reason)
       VALUES ($1, CURRENT_DATE - 1, CURRENT_DATE + 1, 3, 'test') RETURNING id`, [fam.parent_id]);
    const w = await freeAccess.forStudent(fam.student_id, c);
    check(!!w && Number(w.slots_per_day) === 3, 'a window covering today opens it, at 3 a day');

    /* The LAST day is included — a family taking their quiz at 9 PM on the end
       date must not find it already shut. */
    await c.query(`UPDATE free_quiz_campaigns SET end_date = CURRENT_DATE WHERE id=$1`, [live.id]);
    check(!!(await freeAccess.forStudent(fam.student_id, c)),
      'the final day of the window still counts');

    /* Yesterday's window is over. */
    await c.query(`UPDATE free_quiz_campaigns SET end_date = CURRENT_DATE - 1 WHERE id=$1`, [live.id]);
    check(!(await freeAccess.forStudent(fam.student_id, c)),
      'the day after the end date, access is gone');

    /* Cancelling closes it even while the dates still cover today. */
    await c.query(
      `UPDATE free_quiz_campaigns SET end_date = CURRENT_DATE + 3, is_active = false WHERE id=$1`,
      [live.id]);
    check(!(await freeAccess.forStudent(fam.student_id, c)),
      'a cancelled window is closed even though its dates still cover today');

    /* A window naming one child must not reach a sibling. */
    await c.query(`UPDATE free_quiz_campaigns SET is_active = true, student_id = $2 WHERE id=$1`,
      [live.id, fam.student_id]);
    check(!!(await freeAccess.forStudent(fam.student_id, c)), 'a per-child window reaches that child');
    const { rows: [sibling] } = await c.query(
      `SELECT id FROM students WHERE parent_id=$1 AND id <> $2 AND is_active LIMIT 1`,
      [fam.parent_id, fam.student_id]);
    if (sibling) {
      check(!(await freeAccess.forStudent(sibling.id, c)), 'and does NOT reach their sibling');
    } else {
      console.log('  SKIP  sibling check — this family has one child');
    }

    /* A window must never TAKE quizzes away. For a family with no live plan the
       admin's number is the whole entitlement; for one already paying or on
       trial it may only raise the ceiling — a gift that quietly halved a paying
       family's quizzes would be a bug dressed as generosity. */
    const Q = require('../src/whatsapp/quiz');
    await c.query(`UPDATE free_quiz_campaigns SET is_active=true, student_id=NULL,
                      start_date=CURRENT_DATE, end_date=CURRENT_DATE, slots_per_day=1
                    WHERE id=$1`, [live.id]);
    const granted = await Q.entitledSlots(fam.student_id, c);
    check(granted === 1, `no live plan: the admin's 1/day stands exactly as typed (got ${granted})`);

    /* Reactivate the family's EXISTING subscription rather than inserting a
       second one: production carries a unique-active-subscription-per-parent
       constraint that the repo's migrations never created, so an INSERT here
       passes locally and fails on a restored copy of live. */
    const { rows: [plan] } = await c.query(
      `SELECT id FROM quizpe_plans WHERE NOT COALESCE(is_trial,false) AND is_active LIMIT 1`);
    const { rows: [existing] } = await c.query(
      `SELECT id FROM parents_quizpe_subscriptions WHERE parent_id=$1
        ORDER BY plan_end_date DESC LIMIT 1`, [fam.parent_id]);
    if (plan && existing) {
      await c.query(
        `UPDATE parents_quizpe_subscriptions
            SET plan_id=$2, plan_start_date=CURRENT_DATE - 1,
                plan_end_date=CURRENT_DATE + 20, is_active=true
          WHERE id=$1`, [existing.id, plan.id]);
      const paid = await Q.entitledSlots(fam.student_id, c);
      check(paid >= 2, `a PAYING family is NOT cut to 1 by a 1/day window (got ${paid})`);
    } else {
      console.log('  SKIP  paying-family check — this family has never had a subscription');
    }

    await c.query('ROLLBACK');
    console.log(`\n  rolled back — nothing written\n`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\n  ERROR', e.message, '\n');
    fails++;
  } finally { c.release(); }

  console.log(fails ? `  ${fails} FAILURE(S)\n` : '  all checks passed\n');
  process.exit(fails ? 1 : 0);
})();
