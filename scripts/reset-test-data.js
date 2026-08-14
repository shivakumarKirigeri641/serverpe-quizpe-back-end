/**
 * scripts/reset-test-data.js
 * ---------------------------------------------------------------------------
 * Puts the app back into a clean state for another test run: clears every
 * quiz-side row AND the report PDFs those rows pointed at, so the two can
 * never drift apart and leave orphaned files on disk.
 *
 *   node scripts/reset-test-data.js            # quiz data + report files
 *   node scripts/reset-test-data.js --billing  # also payments/invoices/GST
 *   node scripts/reset-test-data.js --accounts # also parents/students/subs
 *   node scripts/reset-test-data.js --dry-run  # show what would go, delete nothing
 *
 * Lookup and content tables (boards, grades, subjects, plans, question_bank,
 * templates, policies, business_details, …) are NEVER touched.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const db = require('../src/database/connectDB');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const BILLING = args.includes('--billing');
const ACCOUNTS = args.includes('--accounts');

// Ordered child -> parent so foreign keys never block a delete.
const QUIZ_TABLES = [
  'student_quizpe_histories', 'quiz_links', 'quiz_reports', 'feedbacks',
  'notification_log', 'student_subject_progress', 'quizpe_tracker',
  'report_sessions', 'otps',
];
const BILLING_TABLES = ['gstr1_filing', 'invoices', 'payments', 'checkout_sessions'];
const ACCOUNT_TABLES = [
  'policy_consents', 'student_addons_subscriptions', 'parents_quizpe_subscriptions',
  'students', 'parents', 'signup_links',
  'whatsapp_session_events', 'whatsapp_messages', 'whatsapp_sessions',
];

const REPORT_DIRS = [
  'src/uploads/reports/daily_reports',
  'src/uploads/reports/weekly_reports',
  'src/uploads/reports/final_reports',
  'src/uploads/reports/certificates',
];
const INVOICE_DIR = 'src/uploads/invoices';

/** Delete everything inside `dir` but keep `dir` itself — the app writes there. */
function emptyDir(rel) {
  const dir = path.join(__dirname, '..', rel);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
    if (!DRY) fs.rmSync(p, { recursive: true, force: true });
  }
  return n;
}

function countFiles(dir) {
  return fs.readdirSync(dir).reduce((sum, e) => {
    const p = path.join(dir, e);
    return sum + (fs.statSync(p).isDirectory() ? countFiles(p) : 1);
  }, 0);
}

(async () => {
  const tables = [
    ...QUIZ_TABLES,
    ...(BILLING ? BILLING_TABLES : []),
    ...(ACCOUNTS ? ACCOUNT_TABLES : []),
  ];

  const rows = {};
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    for (const t of tables) {
      rows[t] = DRY
        ? (await c.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n
        : (await c.query(`DELETE FROM ${t}`)).rowCount;
    }
    // Sessions survive unless --accounts, but must not point at a dead quiz.
    if (!ACCOUNTS && !DRY) {
      rows['whatsapp_sessions (reset)'] = (await c.query(
        `UPDATE whatsapp_sessions
            SET state='main_menu', context = context - 'tracker_id', modified_at=now()`)).rowCount;
    }
    if (DRY) await c.query('ROLLBACK'); else await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\n❌ Nothing was deleted —', e.message);
    c.release(); await db.close();
    process.exit(1);
  } finally {
    c.release();
  }

  const files = {};
  for (const d of REPORT_DIRS) files[d] = emptyDir(d);
  if (BILLING) files[INVOICE_DIR] = emptyDir(INVOICE_DIR);

  console.log(DRY ? '\n🔍 DRY RUN — nothing deleted\n' : '\n🧹 Reset complete\n');
  console.log('Database rows:'); console.table(rows);
  console.log('Files:');         console.table(files);
  console.log(`Kept: all lookup/content tables${ACCOUNTS ? '' : ', parents, students and subscriptions'}.`);
  await db.close();
})();
