/**
 * src/referrals/engine.js
 * ---------------------------------------------------------------------------
 * Parent-to-parent referral.
 *
 * THE MODEL — referrer-only, self-limiting, revenue-safe
 *
 * The referred friend gets NOTHING extra — just the normal 7-day trial. Only
 * the REFERRER earns, and only from real users: a referral "qualifies" when the
 * friend COMPLETES THEIR FIRST QUIZ (a throwaway number never will).
 *
 *   • The FIRST qualified referral in the referrer's current period (trial or
 *     paid) pays +7 immediately, onto their current plan.
 *   • Any FURTHER qualified referrals in the same period are BANKED, and release
 *     +7 each — one at a time — at the referrer's next RENEWALS.
 *
 * So a period can only stretch once for free; every extra referral rewards the
 * referrer at a future renewal. Because renewing means paying, the scheme is
 * funded by the referrer's own subscription and can never quietly run the
 * platform on free days. A per-referrer cap bounds the total either way.
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
 * Additive, idempotent schema for the referrer-only model. Safe to run at every
 * boot: ADD COLUMN IF NOT EXISTS never rewrites the table for a defaulted
 * boolean / nullable column, so it cannot lock a live table.
 *
 *   qualified_at  when the friend completed their first quiz (NULL until then)
 *   banked        qualified but awaiting a referrer renewal to release
 *   reward_kind   'immediate' (1st of a period) | 'renewal' (released later)
 */
async function ensureSchema(client = db) {
  await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS qualified_at timestamptz`);
  await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS banked boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS reward_kind text`);
  await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referee_rewarded_at timestamptz`);
}

/** Total already-rewarded referrals for a referrer (the per-referrer cap). */
async function rewardedCount(referrerId, client) {
  const { rows: [{ n }] } = await client.query(
    `SELECT COUNT(*)::int n FROM referrals WHERE referrer_id=$1 AND status='rewarded'`, [referrerId]);
  return n;
}

/** The start of the referrer's current cover, or null if they have none live. */
async function currentPeriodStart(parentId, client) {
  const { rows } = await client.query(
    `SELECT plan_start_date FROM parents_quizpe_subscriptions
      WHERE parent_id=$1 AND is_active AND plan_end_date >= CURRENT_DATE
      ORDER BY plan_end_date DESC LIMIT 1`, [parentId]);
  return rows[0] ? rows[0].plan_start_date : null;
}

/**
 * Called when a referred friend completes their FIRST quiz. Qualifies their
 * referral and rewards the REFERRER — immediately if this is the first
 * qualified referral of the referrer's current period, otherwise banked for a
 * future renewal. The friend gets nothing (they already have their trial).
 *
 * Idempotent: only a still-unqualified referral is ever acted on.
 */
async function qualifyOnFirstQuiz(refereeId, client = db) {
  const s = await settings(client);
  if (!s.enabled) return null;

  const { rows } = await client.query(
    `SELECT * FROM referrals
      WHERE referee_id=$1 AND status='pending' AND qualified_at IS NULL
      FOR UPDATE`, [refereeId]);
  const ref = rows[0];
  if (!ref) return null;

  await client.query(`UPDATE referrals SET qualified_at=now() WHERE id=$1`, [ref.id]);

  if (await rewardedCount(ref.referrer_id, client) >= s.maxRewarded) {
    await client.query(
      `UPDATE referrals SET status='blocked', banked=false, blocked_reason='referrer_cap_reached' WHERE id=$1`, [ref.id]);
    return null;
  }

  const periodStart = await currentPeriodStart(ref.referrer_id, client);
  let immediateUsed = true;
  if (periodStart) {
    const { rows: [{ m }] } = await client.query(
      `SELECT COUNT(*)::int m FROM referrals
        WHERE referrer_id=$1 AND reward_kind='immediate' AND rewarded_at >= $2::date`,
      [ref.referrer_id, periodStart]);
    immediateUsed = m > 0;
  }

  // Immediate only if the referrer has a live plan AND has not already taken
  // the one immediate bonus this period. Otherwise bank it for a renewal.
  if (periodStart && !immediateUsed) {
    const referrerNewEnd = await extendPlan(ref.referrer_id, s.rewardDays, client);
    await client.query(
      `UPDATE referrals SET status='rewarded', reward_kind='immediate', reward_days=$2, rewarded_at=now() WHERE id=$1`,
      [ref.id, s.rewardDays]);
    return { referrerId: ref.referrer_id, days: s.rewardDays, kind: 'immediate',
             referrerNewEnd, referrerRewardedCount: (await rewardedCount(ref.referrer_id, client)) };
  }

  await client.query(`UPDATE referrals SET banked=true WHERE id=$1`, [ref.id]);
  return { referrerId: ref.referrer_id, days: s.rewardDays, kind: 'banked' };
}

/**
 * Called when a referrer pays (a renewal or their first paid plan). Releases
 * ONE banked referral onto the freshly-created plan — "+7 per renewal". Returns
 * null when they have nothing banked, which is the common case.
 *
 * Must be called AFTER the new subscription row exists, so extendPlan lands the
 * days on the new period.
 */
async function releaseBankedOnRenewal(referrerId, client = db) {
  const s = await settings(client);
  if (!s.enabled) return null;

  const { rows } = await client.query(
    `SELECT * FROM referrals
      WHERE referrer_id=$1 AND banked=true AND status='pending'
      ORDER BY qualified_at NULLS LAST, id
      LIMIT 1 FOR UPDATE`, [referrerId]);
  const ref = rows[0];
  if (!ref) return null;

  if (await rewardedCount(referrerId, client) >= s.maxRewarded) {
    await client.query(
      `UPDATE referrals SET status='blocked', banked=false, blocked_reason='referrer_cap_reached' WHERE id=$1`, [ref.id]);
    return null;
  }

  const referrerNewEnd = await extendPlan(referrerId, s.rewardDays, client);
  await client.query(
    `UPDATE referrals SET status='rewarded', reward_kind='renewal', banked=false, reward_days=$2, rewarded_at=now() WHERE id=$1`,
    [ref.id, s.rewardDays]);

  const { rows: [{ b }] } = await client.query(
    `SELECT COUNT(*)::int b FROM referrals WHERE referrer_id=$1 AND banked=true AND status='pending'`, [referrerId]);
  return { referrerId, days: s.rewardDays, kind: 'renewal', referrerNewEnd,
           referrerRewardedCount: (await rewardedCount(referrerId, client)), remainingBanked: b };
}

/**
 * REFERRER-ONLY MODEL — the referred friend gets NO welcome bonus.
 *
 * A referred parent gets only the normal trial; only the REFERRER earns days
 * (see qualifyOnFirstQuiz / releaseBankedOnRenewal). This is intentionally a
 * no-op, kept so existing callers and the export stay valid without ever
 * granting the friend bonus days.
 */
async function creditRefereeOnFirstPayment(/* refereeId, client */) {
  return null;
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
    `SELECT COUNT(*) FILTER (WHERE status='pending' AND NOT banked)::int AS joined,
            COUNT(*) FILTER (WHERE banked AND status='pending')::int      AS banked,
            COUNT(*) FILTER (WHERE status='rewarded')::int                AS rewarded,
            COALESCE(SUM(reward_days) FILTER (WHERE status='rewarded'),0)::int AS days_earned
       FROM referrals WHERE referrer_id = $1`, [parentId]);
  return {
    code,
    link: shareLink(code),
    joined: c.joined,               // joined, first quiz still pending
    banked: c.banked,               // qualified, waiting for a renewal to release
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
  ensureSchema, settings, codeFor, ownerOf, capture, extendPlan,
  summary, shareLink, parseCode,
  qualifyOnFirstQuiz,          // friend's first quiz -> reward referrer (now or bank)
  releaseBankedOnRenewal,      // referrer pays -> release one banked +7
  creditRefereeOnFirstPayment, // no-op: referrer-only model, friend gets no bonus
};
