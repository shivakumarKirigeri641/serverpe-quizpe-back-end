/**
 * src/web/sms.js — the parents' sign-in code by SMS (quizpe.in/app, 2026-10-08).
 *
 * Fast2SMS, DLT route, the same sender (SRVRPE) and the same registered OTP
 * template GaadiPe's website sign-in uses (PARENT_SMS_DLT_MESSAGE_ID, default
 * 223298). That template has THREE placeholders, filled in order: the code,
 * the product name ("QuizPe") and how long the code lasts ("10 minutes"). A
 * different count is rejected by the operator and the SMS never arrives.
 *
 * The admin template (FAST2SMS_DLT_MESSAGE_ID, src/admin/otp.js) is not used
 * here: its wording is for the admin sign-in.
 *
 * The key goes in the `authorization` HEADER — sent in the body Fast2SMS
 * answers 401, which reads exactly like a wrong key.
 */

const IS_PROD = process.env.NODE_ENV === 'production';

async function sendSignInCode(mobile, code, validMin) {
  const key = process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY || '';
  const sender = process.env.FAST2SMS_SENDER_ID || 'SRVRPE';
  const messageId = process.env.PARENT_SMS_DLT_MESSAGE_ID || '223298';
  if (!key) {
    if (IS_PROD) throw Object.assign(new Error('We could not send the code right now. Please try again shortly.'), { status: 503 });
    console.warn(`[parent-sms] no FAST2SMSAPIKEY — dev fallback, code for ${mobile} is ${code}`);
    return null;
  }
  const values = [code, 'QuizPe', `${validMin} minutes`].map((v) => String(v).replace(/\|/g, ' ')).join('|');
  let res; let body;
  try {
    res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        route: process.env.FAST2SMS_ROUTE || 'dlt',
        sender_id: sender,
        message: messageId,
        variables_values: values,
        numbers: mobile,
        flash: '0',
        ...(process.env.FAST2SMS_ENTITY_ID ? { entity_id: process.env.FAST2SMS_ENTITY_ID } : {}),
      }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    console.error('[parent-sms] Fast2SMS unreachable:', e.message);
    throw Object.assign(new Error('We could not send the code right now. Please try again shortly.'), { status: 503 });
  }
  if (!res.ok || !(body.return === true || body.return === 'true')) {
    // Never echo the provider's text to the browser — it can carry the balance.
    console.error('[parent-sms] Fast2SMS refused:', res.status, JSON.stringify(body).slice(0, 300));
    throw Object.assign(new Error('We could not send the code right now. Please try again shortly.'), { status: 503 });
  }
  return Array.isArray(body.request_id) ? body.request_id[0] : (body.request_id || null);
}

module.exports = { sendSignInCode };
