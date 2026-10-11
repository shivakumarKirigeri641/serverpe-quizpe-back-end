#!/usr/bin/env node
/**
 * scripts/report-check.js — WHY IS A QUIZ REPORT NOT READY? (2026-10-11). READ-ONLY.
 *
 *   node scripts/report-check.js            the last 5 finished quizzes and their reports
 *   node scripts/report-check.js 9886122415 the same for one parent's number
 *
 * For each finished quiz: its report job (queued / running / done / failed, and the
 * error), the report row, and whether the PDF file is on disk — plus whether the
 * report folder can be written by this user (EACCES is the usual reason a PDF fails).
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const db = require('../src/database/connectDB');

const UPLOADS = path.join(__dirname, '..', 'src', 'uploads');

(async () => {
  const m10 = String(process.argv[2] || '').replace(/\D/g, '').slice(-10);
  const { rows } = await db.query(
    `SELECT t.id AS tracker, t.quiz_date::text AS day, st.student_name AS child, qs.status_code AS quiz,
            t.modified_at AS finished_at,
            j.status AS job, j.attempts, left(coalesce(j.last_error, ''), 160) AS error, j.created_at AS job_at, j.completed_at AS job_done,
            r.id AS report_id, r.file_path, r.created_at AS report_at
       FROM quizpe_tracker t
       JOIN students st ON st.id = t.student_id
       JOIN parents p ON p.id = st.parent_id
       JOIN quizpe_status qs ON qs.id = t.status_id
       LEFT JOIN LATERAL (SELECT * FROM job_queue q WHERE q.kind = 'daily_report' AND (q.payload->>'trackerId')::text = t.id::text
                           ORDER BY q.id DESC LIMIT 1) j ON true
       LEFT JOIN LATERAL (SELECT * FROM quiz_reports q WHERE q.tracker_id = t.id ORDER BY q.id DESC LIMIT 1) r ON true
      WHERE qs.status_code IN ('completed', 'closed')
        AND ($1 = '' OR right(regexp_replace(p.parent_mobile_number, '\\D', '', 'g'), 10) = $1)
      ORDER BY t.modified_at DESC NULLS LAST, t.id DESC LIMIT 5`, [m10]);

  if (!rows.length) console.log('No finished quizzes found.');
  for (const r of rows) {
    // Report files live under uploads/reports (pdf/dailyReport.js REPORTS_ROOT).
    const file = r.file_path ? path.join(UPLOADS, 'reports', r.file_path) : null;
    const onDisk = file ? fs.existsSync(file) : false;
    console.log(`\nQuiz ${r.tracker} · ${r.child} · ${r.day} · ${r.quiz} · finished ${r.finished_at ? new Date(r.finished_at).toISOString() : '?'}`);
    console.log(`  report job : ${r.job || 'NOT QUEUED'}${r.attempts ? ` (tries ${r.attempts})` : ''}${r.job_done ? ` · done ${new Date(r.job_done).toISOString()}` : ''}`);
    if (r.error) console.log(`  job error  : ${r.error}`);
    console.log(`  report row : ${r.report_id ? `#${r.report_id} · ${r.file_path}` : 'NONE'}`);
    if (file) console.log(`  PDF on disk: ${onDisk ? 'yes' : 'MISSING'} (${file})`);
  }

  const { rows: [q] } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'failed')::int AS failed, max(completed_at) AS last_done FROM job_queue`);
  console.log(`\nJob queue: ${q.queued} queued · ${q.running} running · ${q.failed} failed · last job finished ${q.last_done ? new Date(q.last_done).toISOString() : 'never'}`);

  const dir = path.join(UPLOADS, 'reports', 'daily_reports');
  try { fs.accessSync(dir, fs.constants.W_OK); console.log(`Report folder writable: yes (${dir})`); }
  catch (e) { console.log(`Report folder writable: NO — ${e.code} (${dir})`); }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
