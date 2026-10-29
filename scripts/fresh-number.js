/**
 * scripts/fresh-number.js — make the OWNER's number look brand new, to test the new-family journey (user,
 * 2026-10-29: "make my number as fresh one to test"). Nothing is deleted: every row holding the number is PARKED
 * (its first digit becomes 1, e.g. 9886122415 -> 1886122415) and comes back with --restore. A number starting
 * with 1 is not a real Indian mobile, so nothing parked can ever be sent to anyone.
 *
 *   node scripts/fresh-number.js                 dry run: which tables hold the number, how many rows
 *   node scripts/fresh-number.js --park          park them all (one transaction) -> the number is fresh
 *   node scripts/fresh-number.js --restore       rows made while testing move to 2886122415 (kept, never sent
 *                                                to), then the parked rows come back as 9886122415
 *   --mobile 9xxxxxxxxx                          only the owner's numbers (ADMIN_MOBILE, MYOWNNUMBERPERSONAL,
 *                                                ADMIN_MOBILES, RAZORPAY_TEST_MOBILES; default 9886122415)
 *
 * Every text column named like mobile / phone / wa_id / contact / msisdn in the public schema is covered, so a
 * table added later is not missed. Children (students, MCQ lots, subscriptions) follow their parent row by id.
 * Restart the app after --park and after --restore (pm2 restart serverpe-quizpe) so no cached session lingers.
 */
require('dotenv').config({ quiet: true });
const db = require('../src/database/connectDB');

const args = process.argv.slice(2);
const PARK = args.includes('--park');
const RESTORE = args.includes('--restore');
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const OWNERS = [process.env.ADMIN_MOBILE, process.env.MYOWNNUMBERPERSONAL, process.env.ADMIN_MOBILES,
  process.env.RAZORPAY_TEST_MOBILES, '9886122415'].filter(Boolean).join(',').split(',').map(ten).filter((m) => m.length === 10);
const MOBILE = ten(arg('--mobile') || '9886122415');
const PARKED = `1${MOBILE.slice(1)}`;
const LEFTOVER = `2${MOBILE.slice(1)}`;

/** Every (table, column) that can hold a phone number, and how many rows end in `num`. */
async function holders(c, num) {
  const cols = (await c.query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'character')
        AND c.column_name ~* '(mobile|phone|wa_id|contact|msisdn)'
      ORDER BY 1, 2`)).rows;
  const out = [];
  for (const { table_name: t, column_name: col } of cols) {
    const n = (await c.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "${col}" LIKE '%' || $1`, [num])).rows[0].n;
    if (n) out.push({ table: t, column: col, rows: n });
  }
  return out;
}

async function swap(c, list, from, to) {
  let total = 0;
  for (const h of list) {
    total += (await c.query(`UPDATE "${h.table}" SET "${h.column}" = replace("${h.column}", $1, $2) WHERE "${h.column}" LIKE '%' || $1`,
      [from, to])).rowCount;
  }
  return total;
}

(async () => {
  if (MOBILE.length !== 10 || !OWNERS.includes(MOBILE)) {
    console.error(`\n${MOBILE || '(none)'} is not one of the owner's numbers — refusing. Customers are never touched.\n`);
    process.exit(1);
  }
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const live = await holders(c, MOBILE);
    const parked = await holders(c, PARKED);

    if (!PARK && !RESTORE) {
      console.log(`\nDRY RUN — ${MOBILE}. Nothing changed.\n\nRows holding ${MOBILE} now:`);
      console.table(live.length ? live : [{ table: '(none)' }]);
      console.log(`Already parked as ${PARKED}: ${parked.reduce((s, h) => s + h.rows, 0)} rows.`);
      console.log('\nRun with --park to make the number fresh, --restore to bring the old data back.\n');
      await c.query('ROLLBACK');
    } else if (PARK) {
      if (parked.length) throw new Error(`rows are already parked as ${PARKED} — run --restore first, or nothing would come back cleanly`);
      if (!live.length) throw new Error(`nothing holds ${MOBILE} — it is already fresh`);
      const n = await swap(c, live, MOBILE, PARKED);
      await c.query('COMMIT');
      console.log(`\n✅ ${MOBILE} is FRESH. ${n} rows parked as ${PARKED}:`);
      console.table(live);
      console.log('Now: pm2 restart serverpe-quizpe, then send Hi from your phone. Afterwards: --restore.\n');
    } else {
      if (!parked.length) throw new Error(`nothing is parked as ${PARKED} — nothing to restore`);
      const left = await holders(c, LEFTOVER);
      if (left.length && live.length) throw new Error(`old test rows already sit at ${LEFTOVER}; move them by hand first`);
      const t = live.length ? await swap(c, live, MOBILE, LEFTOVER) : 0;
      const n = await swap(c, parked, PARKED, MOBILE);
      await c.query('COMMIT');
      console.log(`\n✅ Restored ${n} rows to ${MOBILE}.`);
      if (t) { console.log(`The ${t} rows made while testing now sit at ${LEFTOVER} (not a real number, never sent to):`); console.table(live); }
      console.log('Now: pm2 restart serverpe-quizpe.\n');
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`\n❌ Nothing changed — ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    c.release();
    await db.close?.();
  }
})();
