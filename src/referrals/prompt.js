/**
 * src/referrals/prompt.js
 * ---------------------------------------------------------------------------
 * Asking a parent to invite a friend — at a moment they're already pleased.
 *
 * WHY THIS EXISTS. The referral scheme has been live and reachable the whole
 * time, as one row in a ten-row menu. Nobody opens a menu looking for ways to
 * recommend something, so almost nobody found it. The feature was never the
 * problem; being invisible was.
 *
 * THE RULE THIS FILE IS BUILT AROUND: ask only after something good happened —
 * a strong score, or the weekly report showing progress — and then not again
 * for a fortnight. A parent who is asked to recommend us on the evening their
 * child scored 4/10 will not recommend us, and will think less of us for
 * asking. An ask is cheap once and expensive repeated.
 *
 * The cooldown is kept in notification_log alongside every other outbound
 * nudge, so "have we already bothered this family today?" has one answer in one
 * place rather than a second bespoke table that the anti-annoyance rules in the
 * scheduler know nothing about.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

const KIND = 'invite_prompt';

/** Nothing below a genuinely good quiz is worth interrupting a parent for. */
const MIN_PCT = Number(process.env.REFERRAL_PROMPT_MIN_PCT || 80);
/** A fortnight: often enough to catch a good week, rare enough not to nag. */
const COOLDOWN_DAYS = Number(process.env.REFERRAL_PROMPT_COOLDOWN_DAYS || 14);
/* OPT-IN, not opt-out.
   This sends unprompted messages to real parents, so deploying the code must
   not by itself start messaging anybody. It stays silent until
   REFERRAL_PROMPT=1 is set deliberately on the server. */
const ON = process.env.REFERRAL_PROMPT === '1';

/**
 * Has this family been asked recently?
 *
 * Keyed on the PARENT, not the child. A family with three children would
 * otherwise be asked three times in one evening — the same person, three
 * messages, because the quizzes finished minutes apart.
 */
async function askedRecently(parentId, client = db) {
  if (!parentId) return true;                    // unknown parent → never ask
  const { rows } = await client.query(
    `SELECT 1 FROM notification_log
      WHERE parent_id = $1 AND kind = $2
        AND send_date > CURRENT_DATE - ($3 || ' days')::interval
      LIMIT 1`, [parentId, KIND, String(COOLDOWN_DAYS)]);
  return rows.length > 0;
}

/**
 * Write down that we asked.
 *
 * ON CONFLICT DO NOTHING because the unique index is (student_id, kind,
 * send_date): two children finishing within the cooldown is exactly the case
 * above, and a collision here means "already asked", not an error.
 */
async function markAsked(parentId, studentId, mobile, client = db) {
  await client.query(
    `INSERT INTO notification_log (parent_id, student_id, mobile_number, kind, send_date, status)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, 'sent')
     ON CONFLICT DO NOTHING`, [parentId, studentId || null, mobile, KIND]);
}

/** The parent behind a child, since the callers all start from a student. */
async function parentOf(studentId, client = db) {
  const { rows } = await client.query(
    `SELECT pa.id FROM students st JOIN parents pa ON pa.id = st.parent_id
      WHERE st.id = $1`, [studentId]);
  return rows[0]?.id || null;
}

/**
 * One line carrying the invite link, for a message that is going out anyway.
 *
 * Returns '' rather than throwing on any failure. This rides along on the
 * weekly report: a missing referral code must cost a parent their report.
 */
async function inviteLine(parentId, { days } = {}) {
  if (!ON || !parentId) return '';
  try {
    const engine = require('./engine');
    const s = await engine.settings();
    if (!s.enabled) return '';
    const link = engine.shareLink(await engine.codeFor(parentId));
    if (!link) return '';
    const n = days || s.rewardDays;
    return `\n\n🎁 *Know another parent?* Send them this — you get *${n} free days* `
         + `when their child starts:\n${link}`;
  } catch (e) {
    console.error('[referral-prompt] invite line skipped:', e.message);
    return '';
  }
}

/**
 * Ask, if the moment and the cooldown allow it.
 *
 * Returns true only when a message actually went out, so the caller can decide
 * what else to say. Never throws: this is a nudge attached to a result that has
 * already been earned and stored.
 *
 * The ask is a single line plus a button rather than the full forwardable pack.
 * The pack is two messages and the parent has not asked for it yet — the button
 * hands them to the same menu flow they would have reached themselves, which is
 * already written, already translated, and already knows their code.
 */
async function maybeAsk({ sessionId, mobile, studentId, parentId, childName, pct }) {
  try {
    if (!ON) return false;
    if (typeof pct === 'number' && pct < MIN_PCT) return false;

    const pid = parentId || (studentId ? await parentOf(studentId) : null);
    if (!pid) return false;

    const engine = require('./engine');
    if (!(await engine.settings()).enabled) return false;
    if (await askedRecently(pid)) return false;

    const s = await engine.summary(pid);

    /* Someone already sharing does not need to be told about the scheme — and
       being asked to do the thing you have just done reads as not paying
       attention. They still get the reward; they just get no lecture. */
    if (s.joined > 0 || s.rewarded > 0) return false;

    const wa = require('../whatsapp/client');
    const first = String(childName || '').trim().split(/\s+/)[0];
    const praise = first
      ? (typeof pct === 'number' ? `${first} scored *${pct}%* today. 🎉` : `${first} is doing well. 🎉`)
      : 'Lovely progress this week. 🎉';

    await wa.sendButtons(sessionId, mobile,
      `${praise}\n\nKnow another parent whose child would like this? `
      + `Invite them and you get *${s.reward_days} free days* when their child starts.`,
      [{ id: 'refer_friend', title: '🎁 Invite a friend' }]);

    await markAsked(pid, studentId, mobile);
    return true;
  } catch (e) {
    console.error('[referral-prompt] ask skipped:', e.message);
    return false;
  }
}

module.exports = { maybeAsk, inviteLine, askedRecently, markAsked, KIND, MIN_PCT, COOLDOWN_DAYS };
