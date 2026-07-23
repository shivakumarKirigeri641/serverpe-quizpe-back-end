/**
 * src/referrals/engine.js
 * ---------------------------------------------------------------------------
 * Parent-to-parent referral.
 *
 * WHY THE REWARD LANDS ON PAYMENT, NOT ON SIGNUP
 *
 * The trial is free and needs nothing but a WhatsApp number, so rewarding at
 * signup would pay out for twenty throwaway numbers. The reward is therefore
 * credited when the referred parent makes their FIRST PAYMENT — real money,
 * and hard to fake at any scale worth the trouble.
 *
 * The referrer is still told the moment someone joins through their link, so
 * the loop stays motivating without being exploitable:
 *
 *     joined    "Priya joined using your link!"        (no days yet)
 *     paid      "Priya subscribed — 7 free days added" (days to BOTH)
 *
 * Rewards are paid in DAYS, never cash or a discount. Days cost delivery
 * rather than margin, they deepen the habit on both sides, and they extend the
 * plan through the same stacking rule as any renewal.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const DEFAULTS = { enabled: true, rewardDays: 7, maxRewarded: 20 };

/**
 * Deliberately excludes 0/O/1/I/5/S and vowels: the code gets read aloud,
 * typed by a tired parent, and sometimes copied off a screenshot.
 */
const ALPHABET = '23456789BCDFGHJKLMNPQRTVWXYZ';

async function settings(client = db) {
  const { rows } = await client.query(
    `SELECT key, value FROM app_settings WHERE key LIKE 'referral%'`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: (m.referral_enabled ?? String(DEFAULTS.enabled)) === 'true',
    rewardDays: Number(m.referral_reward_days ?? DEFAULTS.rewardDays) || DEFAULTS.rewardDays,
    maxRewarded: Number(m.referral_max_rewarded ?? DEFAULTS.maxRewarded) || DEFAULTS.maxRewarded,
  };
}

function randomCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/**
 * The parent's own code, created on first use and never changed afterwards —
 * a code that moves would break every link already shared.
 */
async function codeFor(parentId, client = db) {
  const existing = (await client.query(
    `SELECT referral_code FROM parents WHERE id = $1`, [parentId])).rows[0];
  if (existing && existing.referral_code) return existing.referral_code;

  // Collisions are rare but not impossible, so claim-then-verify rather than
  // check-then-write, which would race between two parents signing up at once.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const done = await client.query(
      `UPDATE parents SET referral_code = $2, modified_at = now()
        WHERE id = $1 AND referral_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM parents WHERE referral_code = $2)
        RETURNING referral_code`, [parentId, code]);
    if (done.rowCount) return done.rows[0].referral_code;
    // Someone set a code for this parent between the read and the write.
    const now = (await client.query(
      `SELECT referral_code FROM parents WHERE id = $1`, [parentId])).rows[0];
    if (now && now.referral_code) return now.referral_code;
  }
  throw new Error('COULD_NOT_ALLOCATE_REFERRAL_CODE');
}

/** Who owns this code, or null. Case and spacing are forgiven. */
async function ownerOf(code, client = db) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 4) return null;
  const { rows } = await client.query(
    `SELECT id, parent_name, parent_mobile_number FROM parents
      WHERE referral_code = $1 AND is_active`, [c]);
  return rows[0] || null;
}

/**
 * Records that `refereeId` arrived through `code`.
 *
 * Called at signup, when nothing is owed yet. Every rejection is silent and
 * returns a reason rather than throwing: a bad or self-referred code must
 * never block someone from enrolling.
 */
async function capture(refereeId, code, client = db) {
  const s = await settings(client);
  if (!s.enabled) return { ok: false, reason: 'disabled' };

  const owner = await ownerOf(code, client);
  if (!owner) return { ok: false, reason: 'unknown_code' };
  if (owner.id === refereeId) return { ok: false, reason: 'self_referral' };

  // A parent who has already paid is an existing customer, not a new joiner.
  const established = await client.query(
    `SELECT 1 FROM parents_quizpe_subscriptions s
       JOIN quizpe_plans p ON p.id = s.plan_id
      WHERE s.parent_id = $1 AND COALESCE(p.is_trial,false) = false LIMIT 1`, [refereeId]);
  if (established.rowCount) return { ok: false, reason: 'already_a_customer' };

  const ins = await client.query(
    `INSERT INTO referrals (referrer_id, referee_id, code_used)
     VALUES ($1,$2,$3) ON CONFLICT (referee_id) DO NOTHING
     RETURNING id`, [owner.id, refereeId, owner.referral_code || String(code).toUpperCase()]);
  if (!ins.rowCount) return { ok: false, reason: 'already_referred' };

  return { ok: true, referrer: owner, rewardDays: s.rewardDays };
}

/**
 * Pays out a captured referral once the referee has actually paid.
 *
 * Idempotent — only a row still 'pending' is ever paid, so a retried payment
 * webhook cannot hand out the days twice. Returns null when there is nothing
 * to pay, which is the common case.
 */
async function creditOnPayment(refereeId, client = db) {
  const s = await settings(client);
  if (!s.enabled) return null;

  // FOR UPDATE so two concurrent verifies cannot both see it as pending.
  const { rows } = await client.query(
    `SELECT r.* FROM referrals r
      WHERE r.referee_id = $1 AND r.status = 'pending' FOR UPDATE`, [refereeId]);
  const ref = rows[0];
  if (!ref) return null;

  // Cap the payout per referrer. Without it one person with a large group can
  // earn unbounded free service, and unbounded is not a plan.
  const { rows: [{ n }] } = await client.query(
    `SELECT COUNT(*)::int n FROM referrals
      WHERE referrer_id = $1 AND status = 'rewarded'`, [ref.referrer_id]);
  if (n >= s.maxRewarded) {
    await client.query(
      `UPDATE referrals SET status='blocked', blocked_reason='referrer_cap_reached'
        WHERE id = $1`, [ref.id]);
    return null;
  }

  await client.query(
    `UPDATE referrals SET status='rewarded', reward_days=$2, rewarded_at=now()
      WHERE id = $1`, [ref.id, s.rewardDays]);

  // Extend both. extendPlan is a no-op for anyone with no active plan, so a
  // referrer whose own plan has lapsed simply gets nothing rather than an
  // orphaned subscription row appearing out of nowhere.
  const referrerNewEnd = await extendPlan(ref.referrer_id, s.rewardDays, client);
  const refereeNewEnd = await extendPlan(refereeId, s.rewardDays, client);

  return {
    referrerId: ref.referrer_id,
    days: s.rewardDays,
    referrerNewEnd,
    refereeNewEnd,
    referrerRewardedCount: n + 1,
  };
}

/**
 * Adds days to a parent's current cover.
 *
 * Moves plan_end_date on the existing row rather than inserting another
 * subscription: an extra row would look like a purchase in every report and
 * on the invoice trail, and this is a gift, not a sale.
 */
async function extendPlan(parentId, days, client = db) {
  const { rows } = await client.query(
    `UPDATE parents_quizpe_subscriptions
        SET plan_end_date = plan_end_date + $2::int, modified_at = now()
      WHERE id = (SELECT s.id FROM parents_quizpe_subscriptions s
                   WHERE s.parent_id = $1 AND s.is_active
                     AND s.plan_end_date >= CURRENT_DATE
                   ORDER BY s.plan_end_date DESC LIMIT 1)
      RETURNING to_char(plan_end_date, 'YYYY-MM-DD') AS ends`, [parentId, days]);
  return rows[0] ? rows[0].ends : null;
}

/** Everything a parent needs to see about their own referrals. */
async function summary(parentId, client = db) {
  const s = await settings(client);
  const code = await codeFor(parentId, client);
  const { rows: [c] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status='pending')::int  AS joined,
            COUNT(*) FILTER (WHERE status='rewarded')::int AS rewarded,
            COALESCE(SUM(reward_days) FILTER (WHERE status='rewarded'),0)::int AS days_earned
       FROM referrals WHERE referrer_id = $1`, [parentId]);
  return {
    code,
    link: shareLink(code),
    joined: c.joined,
    rewarded: c.rewarded,
    days_earned: c.days_earned,
    reward_days: s.rewardDays,
    remaining_slots: Math.max(0, s.maxRewarded - c.rewarded),
    enabled: s.enabled,
  };
}

/**
 * A wa.me link that pre-fills the joining message, so the friend only has to
 * press send. Asking someone to remember a code and type it is where most
 * referral schemes quietly die.
 */
function shareLink(code) {
  const num = String(process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(`JOIN ${code}`)}`;
}

/** Pulls a referral code out of whatever the parent actually typed. */
function parseCode(text) {
  const m = String(text || '').toUpperCase().match(/\bJOIN\s+([A-Z0-9]{4,12})\b/);
  return m ? m[1] : null;
}

module.exports = {
  settings, codeFor, ownerOf, capture, creditOnPayment, extendPlan,
  summary, shareLink, parseCode,
};
