/**
 * scripts/why-no-quiz.js
 * ---------------------------------------------------------------------------
 * "It says all of today's quizzes are complete — why?"
 *
 * Answers it for one mobile number by printing the exact inputs the bot used to
 * decide, rather than leaving it to be guessed from the outside. Read-only:
 * nothing is created, changed or sent.
 *
 *   node scripts/why-no-quiz.js 9886122415
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const db = require('../src/database/connectDB');
const Q = require('../src/whatsapp/quiz');
const freeAccess = require('../src/whatsapp/freeAccess');
const { getUserContext, getStudents } = require('../src/whatsapp/userContext');

const mobile = String(process.argv[2] || '').replace(/\D/g, '').slice(-10);

(async () => {
  if (mobile.length !== 10) {
    console.error('usage: node scripts/why-no-quiz.js <10-digit mobile>');
    process.exit(1);
  }

  const ctx = await getUserContext(mobile);
  if (!ctx.exists) { console.log(`\n  ${mobile}: no parent on file.\n`); process.exit(0); }

  const students = await getStudents(ctx.parentId);
  console.log(`\n  ${ctx.parentName || '(no name)'} · ${mobile}`);
  console.log(`  status=${ctx.status}  isSubscribed=${ctx.isSubscribed}  freeAccess=${ctx.freeAccess ? 'YES' : 'no'}`);
  if (ctx.freeAccess) {
    const f = ctx.freeAccess;
    console.log(`    window ${String(f.start_date).slice(0, 10)} .. ${String(f.end_date).slice(0, 10)}`
      + `  ${f.slots_per_day}/day  (${f.reason || 'no reason given'})`);
  }

  const W = require('../src/whatsapp/quizWindow');
  console.log(`  quiz window right now: ${W.state()}`);

  for (const st of students) {
    const slots = await Q.entitledSlots(st.id);
    const subjects = await Q.subjectsForStudent(st.id);
    const prog = await Q.dailyQuizProgress(st.id);
    const pend = await Q.pendingTrackers(st.id);
    const win = await freeAccess.forStudent(st.id);

    const { rows: tr } = await db.query(
      `SELECT t.quiz_slot, qs.status_code, t.is_instant, t.is_free, s.subject_code
         FROM quizpe_tracker t
         JOIN quizpe_status qs ON qs.id = t.status_id
         JOIN subjects s ON s.id = t.subject_id
        WHERE t.student_id = $1 AND t.quiz_date = CURRENT_DATE
        ORDER BY s.subject_code, t.quiz_slot`, [st.id]);

    console.log(`\n  ── ${st.student_name} · ${st.grade_name} (student ${st.id})`);
    console.log(`     free access for this child: ${win ? `${win.slots_per_day}/day` : 'none'}`);
    console.log(`     subjects: ${subjects.map((s) => s.subject_code).join(', ') || 'NONE'}`);
    console.log(`     slots/day allowed: ${slots}`);
    console.log(`     today: ${tr.length ? tr.map((t) => `${t.subject_code} slot${t.quiz_slot}=${t.status_code}`
      + `${t.is_instant ? ' (instant)' : ''}${t.is_free ? ' (free)' : ''}`).join(', ') : 'no trackers'}`);
    console.log(`     done=${prog.done}/${prog.total}  pending=${pend.length}  hasNext=${prog.hasNext}`);

    if (!prog.hasNext) {
      /* The two ways "all complete" happens, named explicitly — the decision is
         MAX(quiz_slot) vs the allowance, not a count of finished quizzes, and
         those differ whenever a slot was closed unfinished. */
      for (const s of subjects) {
        const { rows: [u] } = await db.query(
          `SELECT COALESCE(MAX(quiz_slot),0)::int m FROM quizpe_tracker
            WHERE student_id=$1 AND subject_id=$2 AND quiz_date=CURRENT_DATE
              AND NOT COALESCE(is_instant,false)`, [st.id, s.id]);
        console.log(`     >> ${s.subject_code}: highest slot used today = ${u.m}, allowed = ${slots}`
          + `  ${u.m >= slots ? '← BLOCKED: the allowance is already used up' : '(under cap)'}`);
        if (u.m >= slots && win) {
          console.log(`        the free-access window sets ${win.slots_per_day}/day. Raise it above ${u.m}`);
          console.log(`        on the Free access page (close this window, open a new one) to allow more today.`);
        }
      }
    }
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
