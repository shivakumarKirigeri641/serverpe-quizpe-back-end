/**
 * src/mail/context.js
 * ---------------------------------------------------------------------------
 * Builds the "where it came from" block for an operator alert.
 *
 * One place, so every alert reports the same fields the same way. Only what the
 * request genuinely carries is captured — no geo-IP enrichment, no fingerprint
 * beyond the device cookie we already set for quiz links. Guessing a city from
 * an IP would look authoritative and often be wrong.
 * ---------------------------------------------------------------------------
 */

/**
 * @param {import('express').Request} req  the live request, when there is one
 * @param {object} extra  channel label plus anything the caller already knows
 */
function fromRequest(req, extra = {}) {
  const h = req?.headers || {};
  return {
    channel: extra.channel || 'Web',
    at: extra.at || new Date(),
    userAgent: h['user-agent'] || null,
    // req.ip is correct only because the app sets trust proxy behind nginx
    ip: req?.ip || h['x-forwarded-for'] || null,
    language: h['accept-language'] ? String(h['accept-language']).split(',')[0] : null,
    referer: h.referer || h.referrer || null,
    pageUrl: req ? `${req.protocol}://${h.host || ''}${req.originalUrl || ''}`.slice(0, 200) : null,
    ...extra,
  };
}

/** For events that arrive over WhatsApp, where there is no browser at all. */
function fromWhatsApp({ sessionId, mobile, at } = {}) {
  return {
    channel: 'WhatsApp chat',
    at: at || new Date(),
    sessionId: sessionId || null,
    // deliberately no device/browser fields: a chat message carries none, and
    // inventing them would be worse than leaving them out
    userAgent: null,
    ip: null,
    mobile: mobile || null,
  };
}

module.exports = { fromRequest, fromWhatsApp };
