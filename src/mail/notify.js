/**
 * src/mail/notify.js
 * ---------------------------------------------------------------------------
 * The one call sites use to raise an operator alert.
 *
 *   notify.trial({ ... })   notify.payment({ ... })
 *   notify.feedback({ ... })  notify.support({ ... })
 *
 * Each queues an `admin_mail` job and returns immediately. Nothing here can
 * throw into the caller: an enrolment or a payment must complete whether or not
 * the founder's notification does. Callers may safely ignore the promise.
 * ---------------------------------------------------------------------------
 */

const jobs = require('../jobs/jobQueue');

/** Queue an alert. Never throws — a failure to notify must not fail the action. */
function queue(template, data, dedupeKey) {
  return jobs.push('admin_mail', { template, data }, { dedupeKey, maxAttempts: 3 })
    .catch((e) => console.error(`[notify] could not queue ${template}:`, e.message));
}

module.exports = {
  // dedupe keys stop a retried webhook or a double-tap sending two identical
  // alerts for the same real-world event
  trial: (data) => queue('trialStarted', data,
    data?.parent?.mobile ? `trial:${data.parent.mobile}:${new Date().toISOString().slice(0, 10)}` : null),

  payment: (data) => queue('paymentReceived', data,
    data?.payment?.paymentId ? `pay:${data.payment.paymentId}` : null),

  feedback: (data) => queue('feedbackReceived', data,
    data?.feedbackId ? `fb:${data.feedbackId}` : null),

  support: (data) => queue('supportRaised', data,
    data?.ticket ? `sup:${data.ticket}` : null),
};
