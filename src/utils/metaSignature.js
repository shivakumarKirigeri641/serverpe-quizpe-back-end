/**
 * src/utils/metaSignature.js
 * ---------------------------------------------------------------------------
 * Verify Meta's X-Hub-Signature-256 over the RAW request body.
 *
 * Meta HMAC-signs every webhook delivery with the app's App Secret and sends
 * the digest as `X-Hub-Signature-256: sha256=<hex>`. Checking it proves the
 * request genuinely came from Meta.
 *
 * Without it, anyone who learns the webhook URL can POST a forged inbound
 * message — a fake "hi" from any number, a fake button tap, a fake delivery
 * receipt. For QuizPe that means starting quizzes for children who never asked,
 * and writing junk sessions into the database.
 *
 * Requires the raw bytes, because the signature is over exactly what Meta sent:
 * re-serialising the parsed JSON produces different bytes and would never match.
 * app.js captures them via the express.json() `verify` hook into req.rawBody.
 *
 * Returns one of:
 *   "unset"   — no secret configured; verification disabled (local dev)
 *   "missing" — secret set but the request carried no signature header
 *   "bad"     — signature present but does not match (forged, or wrong secret)
 *   "ok"      — signature present and valid
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

function checkSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return 'unset';
  if (!signatureHeader) return 'missing';

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');

  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so compare lengths first —
  // and a differing length is already a failed match.
  if (a.length !== b.length) return 'bad';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

module.exports = { checkSignature };
