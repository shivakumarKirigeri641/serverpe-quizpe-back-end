/**
 * src/admin/hq/notMe.js — KEEP THE OWNER'S OWN USE OUT OF THE ADMIN'S NUMBERS (user,
 * 2026-10-10: "ignore my (as admin) sign-ins, checks, test payments in admin"), as
 * GaadiPe's admin/notMe.js does.
 *
 * QuizPe has no "internal" flag on a parent, so the owner is the admin's own number(s):
 * ADMIN_MOBILES (the same list that may sign in to this admin; default the founder's).
 * A TEST-mode payment is any checkout paid with the Razorpay test keys
 * (checkout_sessions.razorpay_mode = 'test' — the owner's, paymentRouter.js).
 *
 * SQL fragments, each TRUE for a real family:
 *   mobile(col)    a mobile number column, any format
 *   payment(alias) a payments row (alias): not paid in test mode
 */

const OWNER = String(process.env.ADMIN_MOBILES || '9886122415')
  .split(',').map((m) => m.replace(/\D/g, '').slice(-10)).filter((m) => /^\d{10}$/.test(m));
// Digits only, so safe to inline.
const LIST = OWNER.length ? OWNER.map((m) => `'${m}'`).join(',') : `''`;

const mobile = (col) => `(${col} IS NULL OR right(regexp_replace(${col}, '\\D', '', 'g'), 10) NOT IN (${LIST}))`;
const TEST_ORDERS = `SELECT razorpay_order_id FROM checkout_sessions WHERE razorpay_mode = 'test' AND razorpay_order_id IS NOT NULL`;
const payment = (a) => `(${a}.order_id IS NULL OR ${a}.order_id NOT IN (${TEST_ORDERS}))`;

module.exports = { mobile, payment, OWNER };
