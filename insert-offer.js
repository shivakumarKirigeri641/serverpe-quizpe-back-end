/**
 * insert-offer.js
 * ---------------------------------------------------------------------------
 * Creates + seeds the `quizpe_offers` lookup table (a single active launch
 * offer). The headline discount is CALCULATED from quizpe_plans:
 *   discount% = avg( (comparable_price - price) / comparable_price ) over paid plans.
 *
 *   node insert-offer.js        (run insert-plans.js first)
 * Idempotent: ON CONFLICT (offer_code) upserts.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const { Pool } = require('pg');

const CREATE = `
CREATE TABLE IF NOT EXISTS quizpe_offers (
  id                  BIGSERIAL     PRIMARY KEY,
  offer_code          VARCHAR(32)   NOT NULL UNIQUE,
  title               VARCHAR(120)  NOT NULL,
  description         TEXT          NULL,
  discount_percentage NUMERIC(5,2)  NULL,        -- calculated from plans
  valid_from          TIMESTAMPTZ   NULL,
  valid_till          TIMESTAMPTZ   NULL,
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
`;

// average % off across PAID plans, rounded — calculated from the plans table
const CALC_DISCOUNT = `
SELECT ROUND(AVG( (comparable_price - price) / NULLIF(comparable_price,0) ) * 100)::int AS pct
FROM quizpe_plans
WHERE is_active = true AND price > 0;
`;

const UPSERT = `
INSERT INTO quizpe_offers
  (offer_code, title, description, discount_percentage, valid_from, valid_till, is_active)
VALUES ($1,$2,$3,$4, now(), now() + interval '30 days', true)
ON CONFLICT (offer_code) DO UPDATE SET
  title=EXCLUDED.title, description=EXCLUDED.description,
  discount_percentage=EXCLUDED.discount_percentage,
  valid_till=EXCLUDED.valid_till, is_active=EXCLUDED.is_active, modified_at=now();
`;

async function main() {
  const pool = new Pool();
  const client = await pool.connect();
  try {
    await client.query(CREATE);

    const { rows: [{ pct }] } = await client.query(CALC_DISCOUNT);
    const title = `Launch offer @ ~${pct}% off`;
    const description =
      `Grand launch offer — flat ~${pct}% off across all QuizPe premium plans for a limited time. ` +
      `Start your child's daily learning habit today!`;

    await client.query(UPSERT, ['LAUNCH60', title, description, pct]);

    const { rows } = await client.query(
      'SELECT offer_code, title, discount_percentage, is_active, valid_from::date, valid_till::date FROM quizpe_offers ORDER BY id');
    console.log(`Calculated discount from plans = ${pct}%`);
    console.table(rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
