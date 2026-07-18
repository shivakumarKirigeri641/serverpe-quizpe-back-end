/**
 * insert-plans.js
 * ---------------------------------------------------------------------------
 * (Re)creates and seeds the `quizpe_plans` table in PostgreSQL.
 * DB creds read from .env via PG* env vars.
 *
 *   node insert-plans.js
 *
 * Schema changed from an earlier version, so the table is dropped & recreated.
 * (Nothing references it yet — quizpe_plan_benefits has not been created.)
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const { Pool } = require('pg');

const RECREATE = `DROP TABLE IF EXISTS quizpe_plans CASCADE;`;

const CREATE = `
CREATE TABLE quizpe_plans (
  id               BIGSERIAL     PRIMARY KEY,
  plan_code        VARCHAR(32)   NOT NULL UNIQUE,
  plan_name        VARCHAR(60)   NOT NULL,
  plan_description TEXT          NULL,
  price            NUMERIC(10,2) NOT NULL DEFAULT 0,
  comparable_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  student_count    INT           NOT NULL DEFAULT 1,
  duration         INT           NOT NULL,          -- days
  is_trial         BOOLEAN       NOT NULL DEFAULT false,
  is_active        BOOLEAN       NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
`;

// [plan_code, plan_name, plan_description, price, comparable_price, student_count, duration, is_trial, is_active]
const PLANS = [
  ['TRY0', 'Try',
    '7-day free trial for 1 child — a daily 10-question quiz with instant explanations.',
    0, 0, 1, 7, true, true],
  ['PREMIUM99', 'Premium solo',
    '28-day plan for 1 child — daily 10-question quiz with explanations, spiral revision, weekly progress & monthly PDF report card.',
    99, 249, 1, 28, false, true],
  ['PREMIUM169', 'Premium +',
    '28-day plan for 2 children — daily quizzes with explanations, spiral revision, weekly progress & monthly PDF report cards for both.',
    169, 429, 2, 28, false, true],
  ['PREMIUM249', 'Premium ultra',
    '28-day plan for 3 children — daily quizzes with explanations, spiral revision, weekly progress & monthly PDF report cards for all three.',
    249, 629, 3, 28, false, true],
];

const INSERT = `
INSERT INTO quizpe_plans
  (plan_code, plan_name, plan_description, price, comparable_price, student_count, duration, is_trial, is_active)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);
`;

async function main() {
  const pool = new Pool();
  const client = await pool.connect();
  try {
    await client.query(RECREATE);
    await client.query(CREATE);
    for (const p of PLANS) await client.query(INSERT, p);

    const { rows } = await client.query(
      `SELECT plan_code, plan_name, price, comparable_price, student_count, duration, is_trial, is_active
       FROM quizpe_plans ORDER BY price`);
    console.log('quizpe_plans seeded:');
    console.table(rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
