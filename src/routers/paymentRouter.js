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

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RZP = 'https://api.razorpay.com/v1';
const authHeader = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

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

async function loadCheckout(token) {
  const { rows } = await db.query(
    `SELECT c.*, pl.plan_code, pl.plan_name, pl.plan_description, pl.price, pl.comparable_price,
            pl.student_count, pl.duration
       FROM checkout_sessions c JOIN quizpe_plans pl ON pl.id = c.plan_id
      WHERE c.token=$1 AND c.used_at IS NULL AND c.expires_at > now()`, [token]);
  return rows[0] || null;
}

/** Like loadCheckout but also returns a used/paid checkout (for idempotent replays). */
async function loadCheckoutAny(token) {
  const { rows } = await db.query(
    `SELECT c.*, pl.plan_code, pl.plan_name, pl.plan_description, pl.price, pl.comparable_price,
            pl.student_count, pl.duration
       FROM checkout_sessions c JOIN quizpe_plans pl ON pl.id = c.plan_id
      WHERE c.token=$1 AND c.expires_at > now() + interval '-1 day'`, [token]);
  return rows[0] || null;
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

    const [boards, mediums, grades, states, gstRow, biz, pol] = await Promise.all([
      db.query(`SELECT board_code, board_name FROM boards WHERE is_active ORDER BY display_order`),
      db.query(`SELECT m.medium_code, m.native_name, m.medium_name, b.board_code
                  FROM board_mediums bm JOIN boards b ON b.id=bm.board_id JOIN mediums m ON m.id=bm.medium_id
                 WHERE bm.is_active AND m.is_active AND b.is_active ORDER BY b.display_order, m.display_order`),
      db.query(`SELECT grade_code, grade_name FROM grades WHERE is_active ORDER BY display_order`),
      db.query(`SELECT state_code, state_name FROM states_unions WHERE is_active ORDER BY state_name`),
      db.query(`SELECT gst_value FROM gst_percent WHERE is_active ORDER BY id DESC LIMIT 1`),
      db.query(`SELECT product_name, product_tagline, company_name, support_email, gstin FROM business_details WHERE is_active LIMIT 1`),
      db.query(`SELECT title, url FROM policies WHERE policy_code='trial_conditions' AND is_active ORDER BY id DESC LIMIT 1`),
    ]);
    const gstPct = gstRow.rows[0] ? Number(gstRow.rows[0].gst_value) : 18;
    const mediumsByBoard = {};
    mediums.rows.forEach(m => (mediumsByBoard[m.board_code] ||= []).push({ medium_code: m.medium_code, label: m.native_name || m.medium_name }));

    res.json({
      success: true, mobile: c.mobile_number,
      plan: { code: c.plan_code, name: c.plan_name, description: c.plan_description,
              price: Number(c.price), comparable_price: Number(c.comparable_price),
              student_count: c.student_count, duration: c.duration },
      gst: { pct: gstPct, ...gstBreakup(c.price, gstPct, true) },   // preview intra; recomputed on state
      boards: boards.rows, mediumsByBoard, grades: grades.rows, states: states.rows,
      business: biz.rows[0], policy: pol.rows[0], razorpay_key: KEY_ID,
    });
  } catch (e) {
    console.error('[pay] context failed:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
});

/* ------------------------------------------------------------ create order */
router.post('/api/create-order', async (req, res) => {
  try {
    const { token, students, state } = req.body || {};
    const c = await loadCheckout(token);
    if (!c) return res.status(410).json({ success: false, error: 'Link expired.' });
    if (!Array.isArray(students) || students.length !== c.student_count) {
      return res.status(400).json({ success: false, error: `Please enter details for all ${c.student_count} child(ren).` });
    }
    // validate each student + state
    for (const s of students) {
      const ok = await db.query(
        `SELECT (SELECT 1 FROM boards WHERE board_code=$1 AND is_active) b,
                (SELECT 1 FROM mediums WHERE medium_code=$2 AND is_active) m,
                (SELECT 1 FROM grades WHERE grade_code=$3 AND is_active) g`,
        [s.board, s.medium, s.grade]);
      if (!s.name || String(s.name).trim().length < 2 || !ok.rows[0].b || !ok.rows[0].m || !ok.rows[0].g) {
        return res.status(400).json({ success: false, error: 'Please check each child\'s name, board, medium and grade.' });
      }
    }
    if (!(await db.query(`SELECT 1 FROM states_unions WHERE state_code=$1 AND is_active`, [state])).rowCount) {
      return res.status(400).json({ success: false, error: 'Please select your state.' });
    }

    const amountPaise = Math.round(Number(c.price) * 100);

    // Reuse an existing order for this checkout instead of minting a new one on
    // every click — and if it was already paid, reconcile rather than error.
    if (c.razorpay_order_id) {
      const oRes = await fetch(`${RZP}/orders/${c.razorpay_order_id}`, { headers: { Authorization: authHeader } });
      const existing = oRes.ok ? await oRes.json() : null;
      if (existing?.status === 'paid') {
        const pay = await capturedPaymentForOrder(c.razorpay_order_id);
        if (pay) { await finalize(c, pay, students, state).catch(e => console.error('[pay] reconcile failed:', e.message)); }
        return res.json({ success: true, already_paid: true });
      }
      if (existing && ['created', 'attempted'].includes(existing.status)) {
        return res.json({ success: true, order_id: existing.id, amount: existing.amount, currency: 'INR', key: KEY_ID });
      }
    }

    const rzpRes = await fetch(`${RZP}/orders`, {
      method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: `qp_${c.id}`,
        notes: { plan: c.plan_code, mobile: c.mobile_number } }),
    });
    const order = await rzpRes.json();
    if (!rzpRes.ok) { console.error('[pay] order failed:', order); return res.status(502).json({ success: false, error: order?.error?.description || 'Could not start payment.' }); }

    await db.query(`UPDATE checkout_sessions SET razorpay_order_id=$2, amount=$3, status='order_created' WHERE id=$1`,
      [c.id, order.id, Number(c.price)]);

    res.json({ success: true, order_id: order.id, amount: amountPaise, currency: 'INR', key: KEY_ID });
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
async function finalize(c, pay, students, state) {
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
      return finalize({ ...c, used_at: locked.used_at, status: 'paid' }, pay, students, state);
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
       RETURNING id`, [String(students[0].parent_name || 'Parent').trim().slice(0, 80), c.mobile_number, state])).rows[0].id;

    await client.query(`UPDATE parents_quizpe_subscriptions SET is_active=false, modified_at=now() WHERE parent_id=$1 AND is_active`, [parentId]);

    for (const s of students) {
      await client.query(
        `INSERT INTO students (parent_id, board_id, grade_id, medium_id, student_name)
         VALUES ($1,(SELECT id FROM boards WHERE board_code=$2),(SELECT id FROM grades WHERE grade_code=$3),
                    (SELECT id FROM mediums WHERE medium_code=$4),$5)
         ON CONFLICT (parent_id, student_name) DO UPDATE
           SET board_id=EXCLUDED.board_id, grade_id=EXCLUDED.grade_id, medium_id=EXCLUDED.medium_id, modified_at=now()`,
        [parentId, s.board, s.grade, s.medium, String(s.name).trim().slice(0, 60)]);
    }

    const subId = (await client.query(
      `INSERT INTO parents_quizpe_subscriptions (parent_id, plan_id, plan_end_date)
       VALUES ($1,$2, CURRENT_DATE + $3::int) RETURNING id, plan_end_date, quiz_time`,
      [parentId, c.plan_id, c.duration])).rows[0];

    const { generateInvoice } = require('../pdf/invoice');
    const inv = await generateInvoice(subId.id, paymentDbId, client);

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
      await wa.sendText(c.whatsapp_session_id, c.mobile_number,
`🎉 *Payment successful — welcome to ${c.plan_name}!*

👦 *Student${students.length > 1 ? 's' : ''}:* ${names}
📅 *Valid till:* ${M.fmtDate(subId.plan_end_date)}
⏰ *Quiz time:* ${M.fmtTime(subId.quiz_time)} daily
🧾 *Invoice:* ${inv.invoiceNo}

Your daily quizzes start tonight at ${M.fmtTime(subId.quiz_time)}. 🚀`);
      await wa.sendDocument(c.whatsapp_session_id, c.mobile_number, {
        filePath: inv.filePath, filename: `QuizPe-Invoice-${inv.invoiceNo}.pdf`,
        caption: `🧾 Tax invoice ${inv.invoiceNo} · Total ${inv.amounts.total.toFixed(2)} (incl. GST)`,
      });
    } catch (e) { console.error('[pay] confirmation send failed:', e.message); }

    return { invoice: inv.invoiceNo, end_date: subId.plan_end_date };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Fetch a captured payment for an order (used to reconcile an already-paid order). */
async function capturedPaymentForOrder(orderId) {
  const r = await fetch(`${RZP}/orders/${orderId}/payments`, { headers: { Authorization: authHeader } });
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

    const expected = crypto.createHmac('sha256', KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Payment could not be verified.' });
    }

    const payRes = await fetch(`${RZP}/payments/${razorpay_payment_id}`, { headers: { Authorization: authHeader } });
    const pay = await payRes.json();
    if (!payRes.ok || !['captured', 'authorized'].includes(pay.status)) {
      return res.status(400).json({ success: false, error: 'Payment not completed.' });
    }

    const result = await finalize(c, pay, students, state);
    res.json({ success: true, invoice: result.invoice, end_date: result.end_date, already_paid: !!result.already });
  } catch (e) {
    console.error('[pay] verify failed:', e.message);
    res.status(500).json({ success: false, error: 'Payment verification failed. If money was deducted, contact support.' });
  }
});

module.exports = router;
module.exports.createCheckoutLink = createCheckoutLink;
