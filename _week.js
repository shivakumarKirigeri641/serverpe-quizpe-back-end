require('dotenv').config();
const fs = require('fs');
const db = require('./src/database/connectDB');
const Q = require('./src/whatsapp/quiz');
const { generateDailyReport } = require('./src/pdf/dailyReport');
const { generateWeeklyReport } = require('./src/pdf/weeklyReport');

const MOB = '9000000903';
const SEND_TO = process.env.MYOWNNUMBERPERSONAL || '9886122415';

async function cleanup() {
  await db.query(`DELETE FROM parents WHERE parent_mobile_number=$1`, [MOB]);
}

// score targets per day — a clear improving trend for the charts
const DAY_ACCURACY = [0.4, 0.5, 0.5, 0.6, 0.7, 0.8, 0.9];

(async () => {
  try {
    await cleanup();
    const pid = (await db.query(
      `INSERT INTO parents (parent_name,parent_mobile_number,state_code)
       VALUES ('Shivakumar Kirigeri',$1,'29') RETURNING id`, [MOB])).rows[0].id;
    const sid = (await db.query(
      `INSERT INTO students (parent_id,board_id,grade_id,medium_id,student_name)
       VALUES ($1,(SELECT id FROM boards WHERE board_code='CBSE'),(SELECT id FROM grades WHERE grade_code='G1'),
               (SELECT id FROM mediums WHERE medium_code='ENGLISH'),'Aarav') RETURNING id`, [pid])).rows[0].id;
    await db.query(
      `INSERT INTO parents_quizpe_subscriptions (parent_id,plan_id,plan_start_date,plan_end_date)
       VALUES ($1,(SELECT id FROM quizpe_plans WHERE plan_code='PREMIUM99'), CURRENT_DATE-6, CURRENT_DATE+22)`, [pid]);

    console.log('════ 7-DAY SIMULATION (student', sid, ') ════\n');
    const o = console.log;

    for (let d = 0; d < 7; d++) {
      const offset = 6 - d;                     // 6 days ago → today
      const mathsSub = (await db.query(`SELECT id FROM subjects WHERE subject_code='MATHS'`)).rows[0].id;
      // create the tracker for that historical date
      const tid = (await db.query(
        `INSERT INTO quizpe_tracker (student_id, subject_id, status_id, quiz_date, question_count)
         VALUES ($1,$2,(SELECT id FROM quizpe_status WHERE status_code='scheduled'), CURRENT_DATE - ($3::int), 10)
         RETURNING id`, [sid, mathsSub, offset])).rows[0].id;

      console.log = () => {};
      const r = await Q.startQuiz(tid);           // fills 10 non-repeating questions
      // answer with the target accuracy for the day
      const target = Math.round(DAY_ACCURACY[d] * 10);
      for (let i = 1; i <= 10; i++) {
        const row = (await db.query(
          `SELECT h.serial_number, qb.answer FROM student_quizpe_histories h
             JOIN question_bank qb ON qb.id=h.question_id
            WHERE h.tracker_id=$1 AND h.serial_number=$2`, [tid, i])).rows[0];
        const correct = i <= target;
        await Q.submitAnswer(null, MOB, tid, i, correct ? row.answer : (row.answer === 'A' ? 'B' : 'A'));
      }
      // status cascade to completed
      await db.query(`UPDATE student_quizpe_histories SET status_id=(SELECT id FROM quizpe_status WHERE status_code='completed') WHERE tracker_id=$1`, [tid]);
      await db.query(`UPDATE quizpe_tracker SET status_id=(SELECT id FROM quizpe_status WHERE status_code='completed') WHERE id=$1`, [tid]);
      const rep = await generateDailyReport(tid);
      console.log = o;
      console.log(`  Day ${d + 1} (${rep.head.quiz_date.toISOString().slice(0, 10)}): ` +
        `${rep.score.correct}/${rep.score.total} (${rep.score.pct}%) grade ${rep.score.grade} · PDF ${fs.statSync(rep.filePath).size}b`);
    }

    console.log('\n════ WEEKLY REPORT ════');
    const wk = await generateWeeklyReport(sid, { subjectCode: 'MATHS', days: 7 });
    console.log('  summary:', JSON.stringify(wk.summary));
    console.log('  file   :', wk.relPath, `(${fs.statSync(wk.filePath).size} bytes)`);

    // send the weekly PDF to your WhatsApp
    if (process.env.SEND === '1') {
      const wa = require('./src/whatsapp/client');
      const id = await wa.sendDocument(null, SEND_TO, {
        filePath: wk.filePath, filename: 'QuizPe-Weekly-Report-Aarav.pdf',
        caption: `📊 *Weekly report* — ${wk.head.student_name}\nAvg ${wk.summary.avgPct}% · Accuracy ${wk.summary.overallAcc}% · Improvement ${wk.summary.improvement >= 0 ? '+' : ''}${wk.summary.improvement}% · Grade ${wk.summary.grade}`,
      });
      console.log('  sent to WhatsApp ✓', id.slice(0, 24));
    } else {
      console.log('  (set SEND=1 to also send it to your WhatsApp)');
    }

    if (process.env.KEEP !== '1') { await cleanup(); console.log('\n(test data cleaned — PDFs kept on disk)'); }
    else console.log('\n(KEEP=1 — data left in DB)');
  } catch (e) {
    console.error('FAILED:', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
