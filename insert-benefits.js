/**
 * insert-benefits.js
 * ---------------------------------------------------------------------------
 * Creates + seeds the `quizpe_benefits` master table in PostgreSQL.
 * DB creds read from .env via PG* env vars.
 *
 *   node insert-benefits.js
 *
 * Columns you asked for: id, benefit_title, benefit_description.
 * Added: benefit_code (stable key for idempotent upserts + future plan mapping),
 *        is_active, sort_order, created_at, modified_at.
 * Idempotent: ON CONFLICT (benefit_code) upserts.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const { Pool } = require('pg');

const CREATE = `
CREATE TABLE IF NOT EXISTS quizpe_benefits (
  id                  BIGSERIAL     PRIMARY KEY,
  benefit_code        VARCHAR(48)   NOT NULL UNIQUE,
  benefit_title       VARCHAR(80)   NOT NULL,
  benefit_description TEXT          NULL,
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  sort_order          INT           NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
`;

// [benefit_code, benefit_title, benefit_description, sort_order]
const BENEFITS = [
  ['daily_quiz', 'Daily Quiz',
    'A fresh daily quiz for your child, every day for the full duration of your plan.', 1],
  ['answers_explanations', 'Answers & Explanations',
    'Every question shows the correct answer with a simple, kid-friendly explanation.', 2],
  ['daily_summary_pdf', 'Daily Summary PDF',
    "A daily PDF summary of your child's quiz — questions attempted, score and explanations.", 3],
  ['weekly_report_pdf', 'Weekly Report PDF',
    'A weekly PDF report showing progress, strengths and areas to improve.', 4],
  ['final_report', 'Final Subscription Report',
    'A complete performance report at the end of your subscription, covering the whole period.', 5],
  // ---- "and more" ----
  ['whatsapp_delivery', 'On WhatsApp — No App Needed',
    'Quizzes and reports arrive right on WhatsApp; nothing to download or install.', 6],
  ['cbse_aligned', 'CBSE Syllabus Aligned',
    'Questions follow the CBSE Grade-1 monthly syllabus, month by month.', 7],
  ['spiral_revision', 'Built-in Revision',
    "Previous months' topics are mixed in so earlier learning stays sharp.", 8],
  // ---- recommended extras (engagement + parent trust) ----
  ['instant_score', 'Instant Score',
    'Your child sees their score the moment they finish the day’s quiz.', 9],
  ['progress_tracking', 'Progress Tracking',
    'Chapter-wise strengths and weak areas are tracked across the whole subscription.', 10],
  ['streaks_badges', 'Streaks & Badges',
    'Daily streaks and fun badges keep kids motivated to play every single day.', 11],
  ['daily_reminder', 'Daily Reminder',
    'A gentle WhatsApp reminder so your child never misses a day of practice.', 12],
  ['multi_child', 'Multiple Children',
    'Enrol more than one child on higher plans — each gets their own quizzes and reports.', 13],
  ['completion_certificate', '🎓 Personalized QuizPe Certificate of Completion',
    "Celebrate your child's learning journey with a personalized digital certificate after completing the subscription.", 14],
];

const UPSERT = `
INSERT INTO quizpe_benefits (benefit_code, benefit_title, benefit_description, sort_order)
VALUES ($1,$2,$3,$4)
ON CONFLICT (benefit_code) DO UPDATE SET
  benefit_title=EXCLUDED.benefit_title,
  benefit_description=EXCLUDED.benefit_description,
  sort_order=EXCLUDED.sort_order,
  modified_at=now();
`;

async function main() {
  const pool = new Pool();
  const client = await pool.connect();
  try {
    await client.query(CREATE);
    for (const b of BENEFITS) await client.query(UPSERT, b);
    const { rows } = await client.query(
      'SELECT id, benefit_code, benefit_title, is_active FROM quizpe_benefits ORDER BY sort_order');
    console.log('quizpe_benefits seeded:');
    console.table(rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
