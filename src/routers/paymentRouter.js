/**
 * src/routers/paymentRouter.js
 * ---------------------------------------------------------------------------
 * Razorpay checkout for paid plans (backs public/pay.html).
 *
 *   GET  /pay/api/context?token=...   -> plan summary, GST, dropdowns, T&C
 *   POST /pay/api/create-order        -> validate students, create RZP order
 *   POST /pay/api/verify              -> verify signature, activate everything
 *
 * On success it: records the payment, creates parent + N students + a paid
 * subscription, generates the GST invoice, and sends the confirmation +
 * invoice PDF to the parent on WhatsApp.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database/connectDB');

const router = express.Router();
const TTL_MIN = 30;

const RZP = 'https://api.razorpay.com/v1';

/**
 * Razorpay keys, chosen by the admin-controlled mode in app_settings
 * ('test' | 'live'), falling back to the RAZORPAY_MODE env var, then 'test'.
 * The keys themselves always live in .env and are never stored in the DB.
 *
 * Resolved per request (the mode is a single indexed row, so this is cheap)
 * rather than once at load, so flipping the toggle in Settings takes effect
 * immediately without a restart. A specific mode can be forced — the /verify
 * step passes the mode the order was created in, so a switch mid-transaction
 * never verifies a payment against the wrong secret.
 */
async function razorpayCreds(forceMode = null) {
  let mode = forceMode;
  if (!mode) {
    const r = await db.query(`SELECT value FROM app_settings WHERE key='razorpay_mode'`).catch(() => null);
    mode = r?.rows[0]?.value || process.env.RAZORPAY_MODE || 'test';
  }
  mode = mode === 'live' ? 'live' : 'test';
  const id = mode === 'live' ? process.env.RAZORPAY_KEY_LIVE_ID : process.env.RAZORPAY_KEY_ID;
  const secret = mode === 'live' ? process.env.RAZORPAY_KEY_LIVE_SECRET : process.env.RAZORPAY_KEY_SECRET;
  return { mode, keyId: id, keySecret: secret, authHeader: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') };
}

const normMobile = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/** Create a checkout link for a WhatsApp session + plan. */
async function createCheckoutLink(sessionId, mobile, planCode) {
  const plan = (await db.query(`SELECT id FROM quizpe_plans WHERE plan_code=$1 AND is_active`, [planCode])).rows[0];
  if (!plan) throw new Error(`plan ${planCode} not active`);
  const token = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO checkout_sessions (token, whatsapp_session_id, mobile_number, plan_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5||' minutes')::interval)`,
    [token, sessionId, mobile, plan.id, String(TTL_MIN)]);
  const base = (process.env.PUBLIC_BASE_URL || process.env.HOST || '').replace(/\/$/, '');
  return { token, url: `${base}/pay.html?token=${token}` };
}

/**
 * Replaces the plan's list price with the price actually payable right now.
 *
 * Everything downstream — the GST breakup, the Razorpay order amount, the
 * invoice — reads `price`, so resolving it in one place here means the launch
 * offer cannot be applied inconsistently. The client never gets a say: it may
 * display a price, but this is the number that is charged.
 */
async function applyOfferPrice(row, client = db) {
  if (!row) return row;
  const { priceFor } = require('../utils/launchOffer');
  const offer = await priceFor(row, Number(row.student_count) || 1, client);
  row.list_price = offer.regular;          // what it costs without the offer
  row.price = offer.price;                 // what this parent pays
  row.offer = {
    is_launch: offer.isLaunch, saving: offer.saving,
    seats_left: offer.seatsLeft, label: offer.label,
  };
  return row;
}

async function loadCheckout(token) {
  const { rows } = await db.query(
    `SELECT c.*, pl.plan_code, pl.plan_name, pl.plan_description, pl.price, pl.comparable_price,
            pl.regular_price, pl.student_count, pl.duration
       FROM checkout_sessions c JOIN quizpe_plans pl ON pl.id = c.plan_id
      WHERE c.token=$1 AND c.used_at IS NULL AND c.expires_at > now()`, [token]);
  return applyOfferPrice(rows[0] || null);
}

/** Like loadCheckout but also returns a used/paid checkout (for idempotent replays). */
async function loadCheckoutAny(token) {
  const { rows } = await db.query(
    `SELECT c.*, pl.plan_code, pl.plan_name, pl.plan_description, pl.price, pl.comparable_price,
            pl.regular_price, pl.student_count, pl.duration
       FROM checkout_sessions c JOIN quizpe_plans pl ON pl.id = c.plan_id
      WHERE c.token=$1 AND c.expires_at > now() + interval '-1 day'`, [token]);
  return applyOfferPrice(rows[0] || null);
}

function gstBreakup(price, gstPct, intra) {
  const gross = Number(price);
  const base = +(gross * 100 / (100 + gstPct)).toFixed(2);
  const gst = +(gross - base).toFixed(2);
  return intra
    ? { base, cgst: +(gst / 2).toFixed(2), sgst: +(gst - gst / 2).toFixed(2), igst: 0, total: gross }
    : { base, cgst: 0, sgst: 0, igst: gst, total: gross };
}

/* --------------------------------------------------------------- context */
router.get('/api/context', async (req, res) => {
  try {
    const c = await loadCheckout(req.query.token);
    if (!c) return res.status(410).json({ success: false, error: 'This payment link has expired or was already used.' });

    const [boards, mediums, grades, states, gstRow, biz, pol, gradeSubs] = await Promise.all([
      db.query(`SELECT board_code, board_name FROM boards WHERE is_active ORDER BY display_order`),
      db.query(`SELECT m.medium_code, m.native_name, m.medium_name, b.board_code
                  FROM board_mediums bm JOIN boards b ON b.id=bm.board_id JOIN mediums m ON m.id=bm.medium_id
                 WHERE bm.is_active AND m.is_active AND b.is_active ORDER BY b.display_order, m.display_order`),
      db.query(`SELECT grade_code, grade_name FROM grades WHERE is_active ORDER BY display_order`),
      db.query(`SELECT state_code, state_name FROM states_unions WHERE is_active ORDER BY state_name`),
      db.query(`SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`),
      db.query(`SELECT product_name, product_tagline, company_name, support_email, gstin FROM business_details WHERE is_active LIMIT 1`),
      db.query(`SELECT title, url FROM policies WHERE policy_code='trial_conditions' AND is_active ORDER BY id DESC LIMIT 1`),
      // What we can ACTUALLY deliver: board/grade/medium/subject combos that
      // have questions. Drives the cascading dropdowns so nobody can buy an
      // empty subscription; new combos appear automatically as content lands.
      db.query(`SELECT b.board_code, g.grade_code, g.grade_name, m.medium_code,
                       m.native_name, m.medium_name, s.subject_code, s.subject_name,
                       a.price::numeric AS addon_price, COUNT(*)::int AS questions
                  FROM question_bank qb
                  JOIN boards   b ON b.id = qb.board_id  AND b.is_active
                  JOIN grades   g ON g.id = qb.grade_id  AND g.is_active
                  JOIN mediums  m ON m.id = qb.medium_id AND m.is_active
                  JOIN subjects s ON s.id = qb.subject_id AND s.is_active
                  JOIN grade_subjects gs ON gs.grade_id = qb.grade_id
                                        AND gs.subject_id = qb.subject_id AND gs.is_active
                  LEFT JOIN quizpe_addons a ON a.subject_id = s.id AND a.is_active
                 WHERE qb.is_active
                 GROUP BY b.board_code, g.grade_code, g.grade_name, g.display_order, m.medium_code,
                          m.native_name, m.medium_name, s.subject_code, s.subject_name,
                          a.price, gs.display_order
                 ORDER BY b.board_code, g.display_order, gs.display_order`),
    ]);
    const gstPct = gstRow.rows[0] ? Number(gstRow.rows[0].gst_value) : 18;
    const mediumsByBoard = {};
    mediums.rows.forEach(m => (mediumsByBoard[m.board_code] ||= []).push({ medium_code: m.medium_code, label: m.native_name || m.medium_name }));

    /* Build availability: board -> grade -> medium -> { addons[] }.
       A combo only appears if the BASE subject (Maths) has questions there. */
    const raw = {};
    gradeSubs.rows.forEach(r => {
      const b = (raw[r.board_code] ||= {});
      const g = (b[r.grade_code] ||= { grade_name: r.grade_name, mediums: {} });
      const m = (g.mediums[r.medium_code] ||= { label: r.native_name || r.medium_name, subjects: {} });
      m.subjects[r.subject_code] = { subject_name: r.subject_name, price: r.addon_price == null ? null : Number(r.addon_price), questions: r.questions };
    });
    const availability = {};
    for (const [board, grades] of Object.entries(raw)) {
      for (const [grade, gv] of Object.entries(grades)) {
        for (const [medium, mv] of Object.entries(gv.mediums)) {
          if (!mv.subjects.MATHS) continue;                     // no base content -> not sellable
          const addons = Object.entries(mv.subjects)
            .filter(([code, v]) => code !== 'MATHS' && v.price != null && v.questions > 0)
            .map(([code, v]) => ({ subject_code: code, subject_name: v.subject_name, price: v.price }));
          (((availability[board] ||= {})[grade] ||= { grade_name: gv.grade_name, mediums: {} }).mediums)[medium] =
            { label: mv.label, addons };
        }
      }
    }

    res.json({
      success: true, mobile: c.mobile_number,
      plan: { code: c.plan_code, name: c.plan_name, description: c.plan_description,
              price: Number(c.price), comparable_price: Number(c.comparable_price),
              student_count: c.student_count, duration: c.duration },
      gst: { pct: gstPct, ...gstBreakup(c.price, gstPct, true) },   // preview intra; recomputed on state
      boards: boards.rows, mediumsByBoard, grades: grades.rows, states: states.rows,
      availability, gst_pct: gstPct,
      business: biz.rows[0], policy: pol.rows[0], razorpay_key: (await razorpayCreds()).keyId,
    });
  } catch (e) {
    console.error('[pay] context failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
});

/**
 * Validate students + their chosen add-ons against grade_subjects & quizpe_addons,
 * and compute the authoritative amount server-side (never trust the client total).
 * Returns { cart, total } or { error }.
 */
async function buildCart(c, students, state) {
  if (!Array.isArray(students) || students.length !== c.student_count) {
    return { error: `Please enter details for all ${c.student_count} child(ren).` };
  }
  if (!(await db.query(`SELECT 1 FROM states_unions WHERE state_code=$1 AND is_active`, [state])).rowCount) {
    return { error: 'Please select your state.' };
  }

  const base = Number(c.price);
  let addonTotal = 0;
  const cartStudents = [];

  for (const s of students) {
    const ok = (await db.query(
      `SELECT (SELECT 1 FROM boards WHERE board_code=$1 AND is_active) b,
              (SELECT 1 FROM mediums WHERE medium_code=$2 AND is_active) m,
              (SELECT id FROM grades WHERE grade_code=$3 AND is_active) g`,
      [s.board, s.medium, s.grade])).rows[0];
    if (!s.name || String(s.name).trim().length < 2 || !ok.b || !ok.m || !ok.g) {
      return { error: 'Please check each child\'s name, board, medium and grade.' };
    }

    const chosen = Array.isArray(s.addons) ? [...new Set(s.addons)] : [];
    const addons = [];
    for (const code of chosen) {
      // must be a valid add-on subject for THIS grade and an active add-on
      const row = (await db.query(
        `SELECT s.subject_code, a.price::numeric price
           FROM grade_subjects gs
           JOIN subjects s ON s.id=gs.subject_id
           JOIN quizpe_addons a ON a.subject_id=s.id AND a.is_active
          WHERE gs.grade_id=$1 AND gs.is_active AND s.subject_code=$2 AND s.subject_code<>'MATHS'`,
        [ok.g, code])).rows[0];
      if (!row) return { error: `${code} is not available for grade ${s.grade}.` };
      addons.push({ subject_code: row.subject_code, price: Number(row.price) });
      addonTotal += Number(row.price);
    }
    cartStudents.push({ name: String(s.name).trim().slice(0, 60), board: s.board, medium: s.medium, grade: s.grade, addons });
  }

  const total = +(base + addonTotal).toFixed(2);
  return { cart: { students: cartStudents, base, addonTotal: +addonTotal.toFixed(2), total, state, parent_name: (students[0].parent_name || '').trim() }, total };
}

/* ------------------------------------------------------------ create order */
router.post('/api/create-order', async (req, res) => {
  try {
    const { token, students, state } = req.body || {};
    const c = await loadCheckout(token);
    if (!c) return res.status(410).json({ success: false, error: 'Link expired.' });

    const built = await buildCart(c, students, state);
    if (built.error) return res.status(400).json({ success: false, error: built.error });
    const amountPaise = Math.round(built.total * 100);
    const rzp = await razorpayCreds();   // current admin-selected mode

    // Reuse an existing order only if the amount still matches; if it was paid, reconcile.
    if (c.razorpay_order_id) {
      const oRes = await fetch(`${RZP}/orders/${c.razorpay_order_id}`, { headers: { Authorization: rzp.authHeader } });
      const existing = oRes.ok ? await oRes.json() : null;
      if (existing?.status === 'paid') {
        const pay = await capturedPaymentForOrder(c.razorpay_order_id, rzp.authHeader);
        if (pay) {
          await finalize(c, pay, { channel: 'Payment reconciled on revisit', at: new Date(), sessionId: c.whatsapp_session_id })
            .catch(e => console.error('[pay] reconcile failed:', e.message));
        }
        return res.json({ success: true, already_paid: true });
      }
      if (existing && ['created', 'attempted'].includes(existing.status) && existing.amount === amountPaise) {
        await db.query(`UPDATE checkout_sessions SET cart=$2 WHERE id=$1`, [c.id, JSON.stringify(built.cart)]);
        return res.json({ success: true, order_id: existing.id, amount: existing.amount, currency: 'INR', key: rzp.keyId });
      }
    }

    const rzpRes = await fetch(`${RZP}/orders`, {
      method: 'POST', headers: { Authorization: rzp.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: `qp_${c.id}`,
        notes: { plan: c.plan_code, mobile: c.mobile_number } }),
    });
    const order = await rzpRes.json();
    if (!rzpRes.ok) { console.error('[pay] order failed:', order); return res.status(502).json({ success: false, error: order?.error?.description || 'Could not start payment.' }); }

    // store the SERVER-VALIDATED cart AND the mode the order was created in, so
    // /verify checks the signature with the matching secret even if the admin
    // flips the toggle between order creation and payment.
    await db.query(`UPDATE checkout_sessions SET razorpay_order_id=$2, amount=$3, status='order_created', cart=$4, razorpay_mode=$5 WHERE id=$1`,
      [c.id, order.id, built.total, JSON.stringify(built.cart), rzp.mode]);

    res.json({ success: true, order_id: order.id, amount: amountPaise, currency: 'INR', key: rzp.keyId });
  } catch (e) {
    console.error('[pay] create-order failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

/**
 * Idempotently activate a paid checkout. Safe to call twice for the same
 * order/payment — if it's already been finalized, it returns the existing
 * invoice instead of creating a duplicate subscription or double-charging.
 */
async function finalize(c, pay, mailCtx = null) {
  // The server-validated cart is the single source of truth (never the client).
  const cart = c.cart || { students: [], base: Number(c.price), addonTotal: 0, total: Number(c.price), state: null, parent_name: 'Parent' };
  const students = cart.students;
  const state = cart.state;

  // Already finalized? Return the existing invoice.
  if (c.used_at || c.status === 'paid') {
    const prev = await db.query(
      `SELECT i.invoice_id, s.plan_end_date
         FROM checkout_sessions cs
         JOIN payments p ON p.order_id = cs.razorpay_order_id
         JOIN invoices i ON i.payment_id = p.id
         JOIN parents_quizpe_subscriptions s ON s.id = i.subscription_id
        WHERE cs.id = $1 ORDER BY i.id DESC LIMIT 1`, [c.id]);
    if (prev.rows[0]) return { already: true, invoice: prev.rows[0].invoice_id, end_date: prev.rows[0].plan_end_date };
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // lock the checkout row so two concurrent verifies can't both activate
    const locked = (await client.query(
      `SELECT id, used_at, status FROM checkout_sessions WHERE id=$1 FOR UPDATE`, [c.id])).rows[0];
    if (locked.used_at || locked.status === 'paid') {
      await client.query('ROLLBACK');
      return finalize({ ...c, used_at: locked.used_at, status: 'paid' }, pay);
    }

    const paymentDbId = (await client.query(
      `INSERT INTO payments (payment_id, entity, amount, currency, status, order_id, method, captured,
                             description, email, contact, notes, api_response)
       VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (payment_id) DO UPDATE SET status=EXCLUDED.status, modified_at=now()
       RETURNING id`,
      [pay.id, pay.amount / 100, pay.currency, pay.status, pay.order_id, pay.method, pay.captured === true,
       `${c.plan_name} subscription`, pay.email || null, pay.contact || c.mobile_number,
       JSON.stringify(pay.notes || {}), JSON.stringify(pay)])).rows[0].id;

    const parentId = (await client.query(
      `INSERT INTO parents (parent_name, parent_mobile_number, state_code)
       VALUES ($1,$2,$3)
       ON CONFLICT (parent_mobile_number) DO UPDATE
         SET parent_name=EXCLUDED.parent_name, state_code=EXCLUDED.state_code, modified_at=now()
       RETURNING id`, [String(cart.parent_name || 'Parent').trim().slice(0, 80) || 'Parent', c.mobile_number, state])).rows[0].id;

    await client.query(`UPDATE parents_quizpe_subscriptions SET is_active=false, modified_at=now() WHERE parent_id=$1 AND is_active`, [parentId]);

    // spread the evening load instead of putting everyone at 8 PM; a renewal
    // keeps whatever time the parent already had rather than being reshuffled
    const prev = (await client.query(
      `SELECT quiz_time, reminder_time FROM parents_quizpe_subscriptions
        WHERE parent_id=$1 ORDER BY id DESC LIMIT 1`, [parentId])).rows[0];
    const slot = prev
      ? { quiz_time: String(prev.quiz_time).slice(0, 5), reminder_time: String(prev.reminder_time).slice(0, 5) }
      : require('../whatsapp/quizSlot').slotFor(parentId);

    for (const s of students) {
      const studentId = (await client.query(
        `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name, school_name)
         VALUES ($1,(SELECT id FROM boards WHERE board_code=$2),(SELECT id FROM grades WHERE grade_code=$3),
                    (SELECT id FROM mediums WHERE medium_code=$4),$5,$6)
         ON CONFLICT (parent_id, student_name) DO UPDATE
           SET board_id=EXCLUDED.board_id, grade_id=EXCLUDED.grade_id, medium_id=EXCLUDED.medium_id,
               -- optional field: never wipe a stored school with a blank
               school_name=COALESCE(EXCLUDED.school_name, students.school_name),
               modified_at=now()
         RETURNING id`,
        [parentId, s.board, s.grade, s.medium, String(s.name).trim().slice(0, 60),
         String(s.school_name || '').trim().slice(0, 120) || null])).rows[0].id;

      // subject add-ons chosen for this child (refresh: deactivate old, add current)
      await client.query(`UPDATE student_addons_subscriptions SET is_active=false WHERE student_id=$1`, [studentId]);
      for (const ad of (s.addons || [])) {
        await client.query(
          `INSERT INTO student_addons_subscriptions (student_id, addon_id)
           VALUES ($1,(SELECT id FROM quizpe_addons WHERE subject_id=(SELECT id FROM subjects WHERE subject_code=$2) AND is_active))
           ON CONFLICT (student_id, addon_id) DO UPDATE SET is_active=true, modified_at=now()`,
          [studentId, ad.subject_code]);
      }
    }

    // A renewal picks up where the current cover ends, so paid days are never
    // thrown away. Deliberately computed BEFORE the deactivate above is relied
    // upon — it reads plan_end_date, which deactivating does not clear.
    const { computePeriod } = require('../utils/subscriptionPeriod');
    const period = await computePeriod(client, parentId, c.duration);

    const subId = (await client.query(
      `INSERT INTO parents_quizpe_subscriptions
         (parent_id, plan_id, plan_start_date, plan_end_date, quiz_time, reminder_time)
       VALUES ($1,$2,$3::date,$4::date,$5::time,$6::time)
       RETURNING id, plan_start_date, plan_end_date, quiz_time`,
      [parentId, c.plan_id, period.startDate, period.endDate,
       slot.quiz_time, slot.reminder_time])).rows[0];

    // If this parent arrived through someone's referral link, this is the
    // moment it pays out — real money has changed hands. Idempotent, so a
    // replayed webhook cannot hand out the days twice. Inside the transaction
    // because the days it grants must not survive a rolled-back payment.
    let referral = null;
    try {
      referral = await require('../referrals/engine').creditOnPayment(parentId, client);
    } catch (e) { console.error('[pay] referral credit skipped:', e.message); }

    const { generateInvoice } = require('../pdf/invoice');
    const inv = await generateInvoice(subId.id, paymentDbId, client, cart);

    await client.query(`UPDATE checkout_sessions SET used_at=now(), status='paid' WHERE id=$1`, [c.id]);
    if (c.whatsapp_session_id) {
      await client.query(`UPDATE whatsapp_sessions SET parent_id=$2, state='active', modified_at=now() WHERE id=$1`, [c.whatsapp_session_id, parentId]);
      await client.query(
        `INSERT INTO whatsapp_session_events (session_id, from_state, to_state, event, payload)
         VALUES ($1,'awaiting_payment','active','payment_success',$2)`,
        [c.whatsapp_session_id, JSON.stringify({ subscription_id: subId.id, payment_id: pay.id, invoice: inv.invoiceNo })]);
    }
    await client.query('COMMIT');

    try {
      const wa = require('../whatsapp/client');
      const M = require('../whatsapp/messages');
      const names = students.map(s => s.name).join(', ');

      // Formal confirmation first, then the detail below. Skipped silently
      // until Meta approves the template.
      await require('../whatsapp/lifecycle').sendEnrolment({
        sessionId: c.whatsapp_session_id, mobile: c.mobile_number,
        parentName: cart.parent_name || 'there',
        students: students.map((s) => s.name),
        planName: c.plan_name,
      });

      // A renewal that carried days forward says so explicitly. The whole point
      // of stacking is lost if the parent cannot see that it happened.
      const { stackedMessage } = require('../utils/subscriptionPeriod');
      const carried = stackedMessage(period, M.fmtDate);
      await wa.sendText(c.whatsapp_session_id, c.mobile_number,
`🎉 *Payment successful — welcome to ${c.plan_name}!*

👦 *Student${students.length > 1 ? 's' : ''}:* ${names}
📅 *Valid till:* ${M.fmtDate(subId.plan_end_date)}
⏰ *Quiz time:* ${M.fmtTime(subId.quiz_time)} daily
🧾 *Invoice:* ${inv.invoiceNo}
${carried ? `\n${carried}\n` : ''}
Your daily quizzes ${period.stacked ? 'continue' : 'start'} tonight at ${M.fmtTime(subId.quiz_time)}. 🚀`);
      await wa.sendDocument(c.whatsapp_session_id, c.mobile_number, {
        filePath: inv.filePath, filename: `QuizPe-Invoice-${inv.invoiceNo}.pdf`,
        caption: `🧾 Tax invoice ${inv.invoiceNo} · Total ${inv.amounts.total.toFixed(2)} (incl. GST)`,
      });
    } catch (e) { console.error('[pay] confirmation send failed:', e.message); }

    // Referral payout — told to BOTH sides, because a reward nobody notices
    // buys no goodwill and prompts no further sharing.
    if (referral) {
      try {
        const wa = require('../whatsapp/client');
        const M = require('../whatsapp/messages');
        if (referral.refereeNewEnd) {
          await wa.sendText(c.whatsapp_session_id, c.mobile_number,
`🎁 *Your invite bonus: +${referral.days} free days!*

Because you joined through a friend's link, we've added *${referral.days} days* to your plan.
📅 Now valid till *${M.fmtDate(referral.refereeNewEnd)}*`);
        }
        const ref = (await db.query(
          `SELECT p.parent_mobile_number AS mobile, p.parent_name AS name,
                  (SELECT id FROM whatsapp_sessions w
                    WHERE w.mobile_number = p.parent_mobile_number AND w.is_active
                    ORDER BY w.id DESC LIMIT 1) AS session_id
             FROM parents p WHERE p.id = $1`, [referral.referrerId])).rows[0];
        if (ref && referral.referrerNewEnd) {
          await wa.sendText(ref.session_id, ref.mobile,
`🎉 *Someone you invited just subscribed!*

We've added *${referral.days} free days* to your plan as a thank-you.
📅 Now valid till *${M.fmtDate(referral.referrerNewEnd)}*

You've earned free days from *${referral.referrerRewardedCount}* friend${referral.referrerRewardedCount === 1 ? '' : 's'} so far. Keep sharing! 💚`);
        }
      } catch (e) { console.error('[pay] referral notice failed:', e.message); }
    }

    // Operator alert. Queued after COMMIT and never awaited for success, so a
    // mail problem cannot undo a payment the customer has already made.
    try {
      const notify = require('../mail/notify');
      const M2 = require('../whatsapp/messages');
      const stateName = cart.state
        ? (await db.query(`SELECT state_name FROM states_unions WHERE state_code=$1`, [cart.state]))
            .rows[0]?.state_name || cart.state
        : null;
      notify.payment({
        parent: { name: cart.parent_name || c.mobile_number, mobile: c.mobile_number, state: stateName },
        children: students.map(s => ({
          name: s.name, board: s.board, grade: s.grade, medium: s.medium, school: s.school_name,
        })),
        plan: {
          name: c.plan_name, duration: c.duration,
          start: M2.fmtDate(new Date()), end: M2.fmtDate(subId.plan_end_date),
          quizTime: M2.fmtTime(subId.quiz_time), reminderTime: M2.fmtTime(slot.reminder_time),
        },
        payment: {
          amount: Number(pay.amount / 100).toFixed(2), method: pay.method, status: pay.status,
          paymentId: pay.id, orderId: pay.order_id, mode: c.razorpay_mode || 'test',
        },
        invoice: {
          number: inv.invoiceNo, base: inv.amounts?.base, cgst: inv.amounts?.cgst,
          sgst: inv.amounts?.sgst, igst: inv.amounts?.igst, total: inv.amounts?.total,
        },
        ctx: mailCtx || { channel: 'Checkout page', at: new Date(), sessionId: c.whatsapp_session_id },
      });
    } catch (e) { console.error('[pay] admin alert skipped:', e.message); }

    return { invoice: inv.invoiceNo, end_date: subId.plan_end_date };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Fetch a captured payment for an order (used to reconcile an already-paid order). */
async function capturedPaymentForOrder(orderId, auth) {
  const header = auth || (await razorpayCreds()).authHeader;
  const r = await fetch(`${RZP}/orders/${orderId}/payments`, { headers: { Authorization: header } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.items || []).find(p => ['captured', 'authorized'].includes(p.status)) || null;
}

/* ----------------------------------------------------------------- verify */
router.post('/api/verify', async (req, res) => {
  const { token, razorpay_order_id, razorpay_payment_id, razorpay_signature, students, state } = req.body || {};
  try {
    const c = await loadCheckoutAny(token);   // also loads a used/paid checkout, for idempotent replays
    if (!c) return res.status(410).json({ success: false, error: 'Link expired.' });

    // verify with the SAME mode the order was created in (stored on the checkout)
    const rzp = await razorpayCreds(c.razorpay_mode);

    const expected = crypto.createHmac('sha256', rzp.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Payment could not be verified.' });
    }

    const payRes = await fetch(`${RZP}/payments/${razorpay_payment_id}`, { headers: { Authorization: rzp.authHeader } });
    const pay = await payRes.json();
    if (!payRes.ok || !['captured', 'authorized'].includes(pay.status)) {
      return res.status(400).json({ success: false, error: 'Payment not completed.' });
    }

    // must have a server-validated cart (create-order ran) unless this is an
    // idempotent replay of an already-finalized checkout.
    if (!c.used_at && c.status !== 'paid' && (!c.cart || !Array.isArray(c.cart.students) || !c.cart.students.length)) {
      return res.status(400).json({ success: false, error: 'Please fill the form and start payment again.' });
    }
    // amount safety: what was captured must match the server-computed cart total
    if (c.cart && Math.round(Number(c.cart.total) * 100) !== pay.amount) {
      console.error(`[pay] amount mismatch: cart ${c.cart.total} vs paid ${pay.amount / 100}`);
      return res.status(400).json({ success: false, error: 'Amount mismatch. Contact support if money was deducted.' });
    }
    const { fromRequest } = require('../mail/context');
    const result = await finalize(c, pay, fromRequest(req, {
      channel: 'Checkout page (pay.html)', sessionId: c.whatsapp_session_id,
    }));
    res.json({ success: true, invoice: result.invoice, end_date: result.end_date, already_paid: !!result.already });
  } catch (e) {
    console.error('[pay] verify failed:', e.message);
    res.status(500).json({ success: false, error: 'Payment verification failed. If money was deducted, contact support.' });
  }
});

module.exports = router;
module.exports.createCheckoutLink = createCheckoutLink;
