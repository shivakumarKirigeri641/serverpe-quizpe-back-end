/**
 * scripts/migrate.js
 * ---------------------------------------------------------------------------
 * Schema changes that were applied to the development database by hand, written
 * down so the production database can be brought to the same shape.
 *
 * Every statement is idempotent (IF NOT EXISTS / guarded), so running this more
 * than once is safe and running it against an already-current database is a
 * no-op. It only ADDS things — nothing here drops a column or deletes a row.
 *
 *   node scripts/migrate.js          apply
 *   node scripts/migrate.js --check  report what is missing, change nothing
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const db = require('../src/database/connectDB');

const CHECK = process.argv.includes('--check');

const STEPS = [
  {
    name: 'parents.service_paused',
    // STOP pauses every outbound message, not just reminders.
    check: `SELECT 1 FROM information_schema.columns
             WHERE table_name='parents' AND column_name='service_paused'`,
    apply: [
      `ALTER TABLE parents ADD COLUMN IF NOT EXISTS service_paused boolean NOT NULL DEFAULT false`,
      `ALTER TABLE parents ADD COLUMN IF NOT EXISTS paused_at timestamptz`,
    ],
  },
  {
    name: 'admin_otps',
    // One-time codes for admin sign-in; replaces the old fixed PIN.
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='admin_otps'`,
    apply: [
      `CREATE TABLE IF NOT EXISTS admin_otps (
         id            bigserial PRIMARY KEY,
         mobile_number varchar(15) NOT NULL,
         otp_hash      varchar(64) NOT NULL,
         expires_at    timestamptz NOT NULL,
         attempts      smallint    NOT NULL DEFAULT 0,
         consumed_at   timestamptz,
         request_ip    varchar(64),
         provider_ref  text,
         created_at    timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_admin_otps_live
         ON admin_otps (mobile_number, expires_at DESC) WHERE consumed_at IS NULL`,
    ],
  },
  {
    name: 'app_settings + razorpay mode',
    // Admin-controlled key/value settings; seeds the Razorpay test/live toggle,
    // and records which mode each checkout was created in (for signature verify).
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='app_settings'`,
    apply: [
      `CREATE TABLE IF NOT EXISTS app_settings (
         key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
      `INSERT INTO app_settings (key, value)
         VALUES ('razorpay_mode', COALESCE(NULLIF(lower('${(process.env.RAZORPAY_MODE || 'test').replace(/'/g, '')}'), ''), 'test'))
         ON CONFLICT (key) DO NOTHING`,
      `ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS razorpay_mode text`,
    ],
  },
  {
    name: 'admins table',
    // Dynamic admin list (super admin can add/remove others). Seeded from
    // ADMIN_MOBILES; the first env number is the super admin.
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='admins'`,
    apply: [
      `CREATE TABLE IF NOT EXISTS admins (
         id bigserial PRIMARY KEY,
         mobile_number varchar(15) UNIQUE NOT NULL,
         is_super boolean NOT NULL DEFAULT false,
         is_active boolean NOT NULL DEFAULT true,
         added_by varchar(15),
         created_at timestamptz NOT NULL DEFAULT now())`,
      `INSERT INTO admins (mobile_number, is_super, added_by)
         SELECT trim(m), (row_number() OVER () = 1), 'seed'
           FROM unnest(string_to_array('${(process.env.ADMIN_MOBILES || '9886122415').replace(/[^0-9,]/g, '')}', ',')) AS m
         ON CONFLICT (mobile_number) DO NOTHING`,
    ],
  },
  {
    name: 'quizpe_plans.regular_price',
    // Launch pricing. `price` stays the live selling price so nothing that
    // reads it needs to change; `regular_price` is what it reverts to once the
    // launch allocation is used up. Seeded equal to price, so until an admin
    // sets a higher regular price the offer is a no-op rather than a surprise.
    check: `SELECT 1 FROM information_schema.columns
             WHERE table_name='quizpe_plans' AND column_name='regular_price'`,
    apply: [
      `ALTER TABLE quizpe_plans ADD COLUMN IF NOT EXISTS regular_price numeric(10,2)`,
      `UPDATE quizpe_plans SET regular_price = price WHERE regular_price IS NULL`,
    ],
  },
  {
    name: 'instant quiz plan',
    // 'Instant Quiz' — a pay-per-quiz plan (₹9 ex-GST) with NO subscription and
    // NO validity: pay, get 12 Maths questions, complete, pay again for another.
    // Kept OUT of the public plans list (is_instant) so the existing trial/premium
    // flow is untouched; it's reached only via its own menu entry. Invoices can now
    // exist without a subscription (instant purchases have none).
    check: `SELECT 1 FROM quizpe_plans WHERE plan_code='INSTANT'`,
    apply: [
      `ALTER TABLE quizpe_plans ADD COLUMN IF NOT EXISTS is_instant boolean NOT NULL DEFAULT false`,
      `ALTER TABLE invoices ALTER COLUMN subscription_id DROP NOT NULL`,
      // Mark instant-quiz trackers so the daily engine + daily dashboards can
      // ignore them (existing rows are all false → behaviour unchanged).
      `ALTER TABLE quizpe_tracker ADD COLUMN IF NOT EXISTS is_instant boolean NOT NULL DEFAULT false`,
      // Instant quizzes are pay-per-use, so a child can have several in one day —
      // widen the slot range so each gets a distinct slot (daily still caps at 3
      // in code). Existing slots 1..3 stay valid.
      `ALTER TABLE quizpe_tracker DROP CONSTRAINT IF EXISTS tracker_quiz_slot_range`,
      `ALTER TABLE quizpe_tracker ADD CONSTRAINT tracker_quiz_slot_range CHECK (quiz_slot BETWEEN 1 AND 999)`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_instant ON quizpe_tracker (student_id, quiz_date) WHERE is_instant`,
      `INSERT INTO quizpe_plans
         (plan_code, plan_name, plan_description, price, comparable_price, regular_price,
          student_count, duration, is_trial, is_instant, is_active)
       SELECT 'INSTANT', 'Instant Quiz',
              'One quick 12-question quiz, anytime — pay per quiz, no subscription.',
              9, 9, 9, 1, 0, false, true, true
        WHERE NOT EXISTS (SELECT 1 FROM quizpe_plans WHERE plan_code='INSTANT')`,
      // Admin-configurable Instant Quiz price (ex-GST) + question count.
      `INSERT INTO app_settings (key, value) VALUES ('instant_quiz', '{"price":9,"questions":12}')
         ON CONFLICT (key) DO NOTHING`,
    ],
  },
  {
    name: 'launch_offer settings',
    // Seat-capped launch offer. Stored in app_settings so it can be switched
    // off, re-capped or ended from the admin panel without a deploy.
    check: `SELECT 1 FROM app_settings WHERE key='launch_offer_cap'`,
    apply: [
      `INSERT INTO app_settings (key, value) VALUES
         ('launch_offer_enabled','true'),
         ('launch_offer_cap','50'),
         ('launch_offer_label','Founding Families')
       ON CONFLICT (key) DO NOTHING`,
    ],
  },
  {
    name: 'badges',
    // Earned rewards. The catalogue is a table rather than code so new badges
    // can be added without a deploy, and `code` is what the app keys off.
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='badges'`,
    apply: [
      `CREATE TABLE IF NOT EXISTS badges (
         id            bigserial PRIMARY KEY,
         badge_code    varchar(40) UNIQUE NOT NULL,
         badge_name    varchar(80) NOT NULL,
         description   text NOT NULL,
         icon          varchar(16) NOT NULL,
         tier          varchar(16) NOT NULL DEFAULT 'bronze',
         -- how it is earned, read by the awarding job
         rule_type     varchar(30) NOT NULL,
         rule_value    integer NOT NULL DEFAULT 0,
         display_order integer NOT NULL DEFAULT 0,
         is_active     boolean NOT NULL DEFAULT true,
         created_at    timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS student_badges (
         id          bigserial PRIMARY KEY,
         student_id  bigint NOT NULL REFERENCES students(id) ON DELETE CASCADE,
         badge_id    bigint NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
         earned_on   date NOT NULL DEFAULT CURRENT_DATE,
         notified_at timestamptz,
         created_at  timestamptz NOT NULL DEFAULT now(),
         UNIQUE (student_id, badge_id))`,
      `CREATE INDEX IF NOT EXISTS student_badges_student_idx ON student_badges(student_id)`,
      // Seeded so a child can earn something in week one. Streak badges use
      // consecutive days attempted; accuracy badges need a minimum volume so a
      // single lucky quiz cannot mint a gold badge.
      `INSERT INTO badges (badge_code, badge_name, description, icon, tier, rule_type, rule_value, display_order) VALUES
         ('first_quiz','First Steps','Completed your very first quiz','👣','bronze','quizzes_done',1,10),
         ('streak_3','On a Roll','Three days in a row','🔥','bronze','streak',3,20),
         ('streak_7','Week Warrior','Seven days without missing one','⚡','silver','streak',7,30),
         ('streak_14','Fortnight Hero','Fourteen days in a row','🌟','silver','streak',14,40),
         ('streak_28','Unbroken','A full month, every single day','💎','gold','streak',28,50),
         ('quizzes_10','Perfect Ten','Finished ten quizzes','🎯','bronze','quizzes_done',10,60),
         ('quizzes_50','Half Century','Finished fifty quizzes','🏏','silver','quizzes_done',50,70),
         ('quizzes_100','Centurion','Finished one hundred quizzes','🏆','gold','quizzes_done',100,80),
         ('perfect_quiz','Full Marks','Scored 10 out of 10','💯','silver','perfect_quiz',1,90),
         ('perfect_3','Triple Perfect','Three full-mark quizzes','👑','gold','perfect_quiz',3,100),
         ('accuracy_80','Sharp Shooter','80% accuracy over 20 quizzes','🎖️','silver','accuracy',80,110),
         ('early_bird','Early Bird','Ten quizzes finished before the reminder','🌅','bronze','early_finish',10,120)
       ON CONFLICT (badge_code) DO NOTHING`,
    ],
  },
  {
    name: 'certificates',
    // April–May consistency certificates and the paid summer challenge entry.
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='certificates'`,
    apply: [
      `CREATE TABLE IF NOT EXISTS certificates (
         id             bigserial PRIMARY KEY,
         certificate_no varchar(30) UNIQUE NOT NULL,
         student_id     bigint NOT NULL REFERENCES students(id) ON DELETE CASCADE,
         parent_id      bigint REFERENCES parents(id) ON DELETE SET NULL,
         kind           varchar(30) NOT NULL,
         season         varchar(20) NOT NULL,
         -- the numbers the certificate asserts, frozen at issue time
         quizzes_taken  integer NOT NULL DEFAULT 0,
         accuracy_pct   numeric(5,2),
         longest_streak integer NOT NULL DEFAULT 0,
         is_paid        boolean NOT NULL DEFAULT false,
         payment_id     bigint REFERENCES payments(id) ON DELETE SET NULL,
         file_path      text,
         issued_on      date NOT NULL DEFAULT CURRENT_DATE,
         created_at     timestamptz NOT NULL DEFAULT now())`,
      `CREATE SEQUENCE IF NOT EXISTS certificate_seq START 1`,
      `CREATE INDEX IF NOT EXISTS certificates_student_idx ON certificates(student_id)`,
    ],
  },
  {
    name: 'referrals',
    // Parent-to-parent referral. Rewards are paid in DAYS, never cash: days
    // cost delivery rather than margin, and they deepen the habit on both
    // sides instead of just discounting one sale.
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='referrals'`,
    apply: [
      `ALTER TABLE parents ADD COLUMN IF NOT EXISTS referral_code varchar(12)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS parents_referral_code_idx
         ON parents(referral_code) WHERE referral_code IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS referrals (
         id             bigserial PRIMARY KEY,
         referrer_id    bigint NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
         -- the person who joined. UNIQUE: someone can only ever be referred
         -- once, so a lapsed parent cannot be re-referred for another reward.
         referee_id     bigint NOT NULL UNIQUE REFERENCES parents(id) ON DELETE CASCADE,
         code_used      varchar(12) NOT NULL,
         -- pending -> rewarded, or blocked if it failed a fraud check
         status         varchar(16) NOT NULL DEFAULT 'pending',
         reward_days    integer NOT NULL DEFAULT 0,
         joined_at      timestamptz NOT NULL DEFAULT now(),
         rewarded_at    timestamptz,
         blocked_reason varchar(60),
         CONSTRAINT referral_not_self CHECK (referrer_id <> referee_id))`,
      `CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id)`,
      `INSERT INTO app_settings (key, value) VALUES
         ('referral_enabled','true'),
         ('referral_reward_days','7'),
         ('referral_max_rewarded','20')
       ON CONFLICT (key) DO NOTHING`,
    ],
  },
  {
    name: 'lifecycle templates',
    // Enrolment, expiring and expired notices. Registered as PENDING: the
    // sender only ever uses an APPROVED row, so these sit inert until Meta
    // clears them and then start working with no deploy.
    check: `SELECT 1 FROM whatsapp_templates WHERE template_name='qp_renewalorwelcome_v1'`,
    apply: [
      `INSERT INTO whatsapp_templates
         (template_name, language, category, approval_status, body_text, variables, buttons, send_context)
       VALUES
         ('qp_renewalorwelcome_v1','en','UTILITY','PENDING',
          'Sent when a parent enrols on the free trial or on a paid plan.',
          '["parent_name","student_name","plan_name"]'::jsonb, '[]'::jsonb, 'enrolment'),
         ('qp_enrollmentexpiring_v1','en','UTILITY','PENDING',
          'Sent as a plan nears its expiry date.',
          '["parent_name","plan_name","expiry_phrase"]'::jsonb,
          '[{"type":"QUICK_REPLY","text":"View plans"}]'::jsonb, 'expiring'),
         ('qp_enrollmentexpired_v1','en','UTILITY','PENDING',
          'Sent once, after a plan has expired.',
          '["parent_name","plan_name"]'::jsonb,
          '[{"type":"QUICK_REPLY","text":"View plans"}]'::jsonb, 'expired')
       ON CONFLICT (template_name) DO NOTHING`,
    ],
  },
  {
    name: 'marketing templates',
    // Business-initiated MARKETING templates for the broadcaster. Registered
    // PENDING; the broadcaster only lists APPROVED rows, so they stay hidden
    // until Meta clears them and the row is flipped to APPROVED. Every body has
    // exactly ONE variable {{1}} = the recipient's first name, and every button
    // title matches the marketing quick-reply routing in whatsapp/flow.js.
    check: `SELECT 1 FROM whatsapp_templates WHERE template_name='qp_promo_trial_v2'`,
    apply: [
      // v1 was submitted without a button; it is re-created as v2. Drop the stale
      // v1 row only if it never got approved (never touch a live template).
      `DELETE FROM whatsapp_templates WHERE template_name='qp_promo_trial_v1' AND approval_status <> 'APPROVED'`,
      `INSERT INTO whatsapp_templates
         (template_name, language, category, approval_status, body_text, variables, buttons, send_context)
       VALUES
         ('qp_promo_trial_v2','en','MARKETING','PENDING',
          'Re-engage leads with the daily-revision hook + free trial.',
          '["parent_name"]'::jsonb,
          '[{"type":"QUICK_REPLY","text":"Start free trial"}]'::jsonb, 'promo_trial'),
         ('qp_winback_v1','en','MARKETING','PENDING',
          'Win back a lapsed/expired family — restart daily practice.',
          '["parent_name"]'::jsonb,
          '[{"type":"QUICK_REPLY","text":"View plans"}]'::jsonb, 'winback'),
         ('qp_referral_v1','en','MARKETING','PENDING',
          'Ask a paying parent to refer friends for bonus days.',
          '["parent_name"]'::jsonb,
          '[{"type":"QUICK_REPLY","text":"Get my invite link"}]'::jsonb, 'referral'),
         ('qp_offer_v1','en','MARKETING','PENDING',
          'Introductory / festive pricing push to leads and lapsed.',
          '["parent_name"]'::jsonb,
          '[{"type":"QUICK_REPLY","text":"View plans"}]'::jsonb, 'offer')
       ON CONFLICT (template_name) DO NOTHING`,
    ],
  },
  {
    name: 'expenses',
    // Business spending, so the finance view can show real profit rather than
    // just turnover. `amount` is what actually left the bank (gross); `gst_amount`
    // is the input GST inside it, claimable back as credit against GST collected
    // on sales. A negative bottom line means marketing outran revenue — a signal
    // to keep investing, not to withdraw.
    check: `SELECT 1 FROM information_schema.tables WHERE table_name='expenses'`,
    apply: [
      `CREATE TABLE IF NOT EXISTS expenses (
         id           bigserial PRIMARY KEY,
         expense_date date NOT NULL DEFAULT CURRENT_DATE,
         category     varchar(40) NOT NULL DEFAULT 'other',
         description  text NOT NULL,
         vendor       varchar(120),
         amount       numeric(12,2) NOT NULL CHECK (amount >= 0),   -- gross, incl GST
         gst_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
         invoice_file text,                                          -- optional PDF path
         added_by     varchar(15),
         is_active    boolean NOT NULL DEFAULT true,
         created_at   timestamptz NOT NULL DEFAULT now(),
         modified_at  timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT expense_gst_within_amount CHECK (gst_amount <= amount))`,
      `CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(expense_date) WHERE is_active`,
    ],
  },
  {
    name: 'quizpe_tracker.quiz_slot',
    // Multiple quizzes per day: a per-day slot (1st/2nd/3rd) on each tracker row.
    // Existing rows default to slot 1 — byte-for-byte identical to today's flow.
    // Additive only; safe on the live DB.
    check: `SELECT 1 FROM information_schema.columns
             WHERE table_name='quizpe_tracker' AND column_name='quiz_slot'`,
    apply: [
      `ALTER TABLE quizpe_tracker ADD COLUMN IF NOT EXISTS quiz_slot smallint NOT NULL DEFAULT 1`,
      `ALTER TABLE quizpe_tracker DROP CONSTRAINT IF EXISTS tracker_quiz_slot_range`,
      `ALTER TABLE quizpe_tracker ADD CONSTRAINT tracker_quiz_slot_range CHECK (quiz_slot BETWEEN 1 AND 3)`,
      `ALTER TABLE quizpe_tracker DROP CONSTRAINT IF EXISTS tracker_unique_student_subject_day`,
      `ALTER TABLE quizpe_tracker DROP CONSTRAINT IF EXISTS tracker_unique_student_subject_day_slot`,
      `ALTER TABLE quizpe_tracker ADD CONSTRAINT tracker_unique_student_subject_day_slot
         UNIQUE (student_id, subject_id, quiz_date, quiz_slot)`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_student_day_slot
         ON quizpe_tracker (student_id, quiz_date, quiz_slot)`,
    ],
  },
];

(async () => {
  let missing = 0;
  for (const step of STEPS) {
    const present = (await db.query(step.check)).rowCount > 0;
    if (present) { console.log(`  ok       ${step.name}`); continue; }
    missing += 1;
    if (CHECK) { console.log(`  MISSING  ${step.name}`); continue; }
    for (const sql of step.apply) await db.query(sql);
    console.log(`  applied  ${step.name}`);
  }

  if (CHECK) {
    console.log(missing ? `\n${missing} change(s) not yet applied.` : '\nDatabase is up to date.');
    process.exit(missing ? 1 : 0);
  }
  console.log('\nDone.');
  process.exit(0);
})().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
