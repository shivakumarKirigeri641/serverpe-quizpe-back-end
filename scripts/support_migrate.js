/**
 * Migrates support_tickets to the OPEN / IN_PROGRESS / CLOSED / CANCELLED
 * lifecycle, adds the resolution note + re-open tracking columns, and repairs
 * the status domain (which was rejecting 'in_progress' — the 500 on "Mark in
 * progress"). Handles both a CHECK-constrained text column and a Postgres enum.
 * Idempotent — safe to re-run.
 */
require('dotenv').config();
const db = require('../src/database/connectDB');
const STATUSES = ['open', 'in_progress', 'closed', 'cancelled'];

(async () => {
  // 1. columns used by the new flow
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution   text`);
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS modified_at  timestamptz DEFAULT now()`);
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at  timestamptz`);
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reopened_at  timestamptz`);
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reopen_count int NOT NULL DEFAULT 0`);
  console.log('  columns ensured (resolution, modified_at, resolved_at, reopened_at, reopen_count)');

  // 2. status domain — enum vs check-constrained text
  const { rows: [col] } = await db.query(
    `SELECT data_type, udt_name FROM information_schema.columns
      WHERE table_name='support_tickets' AND column_name='status'`);
  if (col.data_type === 'USER-DEFINED') {
    for (const v of STATUSES) {
      await db.query(`ALTER TYPE ${col.udt_name} ADD VALUE IF NOT EXISTS '${v}'`).catch((e) => console.log(`    enum add ${v}: ${e.message}`));
    }
    console.log(`  status is enum "${col.udt_name}" — values ensured: ${STATUSES.join(', ')}`);
  } else {
    const { rows: cons } = await db.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid='support_tickets'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'`);
    for (const c of cons) await db.query(`ALTER TABLE support_tickets DROP CONSTRAINT ${c.conname}`);
    await db.query(
      `ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_status_chk
         CHECK (status IN ('open','in_progress','closed','cancelled'))`);
    console.log(`  status is ${col.data_type} — check constraint reset to: ${STATUSES.join(', ')}`);
  }

  // 3. fold any legacy 'resolved' into 'closed'
  const r = await db.query(`UPDATE support_tickets SET status='closed' WHERE status='resolved'`);
  console.log(`  migrated resolved -> closed: ${r.rowCount}`);

  console.log('Done.');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
