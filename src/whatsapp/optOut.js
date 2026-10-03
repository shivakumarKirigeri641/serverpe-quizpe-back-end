/**
 * src/whatsapp/optOut.js
 * ---------------------------------------------------------------------------
 * Deciding whether someone has asked us to stop messaging them.
 *
 * The old test was `/^(stop|unsubscribe|stop reminders|pause)$/i` — an exact
 * match on four English phrases. Production shows what that missed. Of the
 * people who asked to be left alone, only the ones who typed exactly "stop"
 * were heard. These were not:
 *
 *     "delete my number"
 *     "main paisa nahin per karna chahti hun ab yah band kar do tum message bhejna"
 *
 * The second is a woman saying she does not want to pay and we should stop
 * messaging her. She asked plainly, and we kept sending. That is the bar this
 * file exists to clear — not typo tolerance, though it handles that too.
 *
 * TWO KINDS OF MATCH, deliberately different:
 *
 *   A SHORT message is read as a command. "stp", "cancel", "band" on their own
 *   are unambiguous, so up to three words are matched against the bare words.
 *
 *   A LONG message is read for a PHRASE. "stop sending", "band kar do",
 *   "delete my number" mean the same thing inside a sentence of any length,
 *   while a bare "stop" inside a long sentence might not ("don't stop the
 *   quiz"), so bare words are not matched there.
 *
 * WHEN IN DOUBT, STOP. A false positive costs one person one pause they can
 * undo by typing START, and we say so in the reply. A false negative means
 * continuing to message someone who asked us not to, which costs their trust,
 * our quality rating, and is simply not a thing to get wrong.
 */

/** Lowercase, strip emoji and punctuation, collapse spaces. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Said alone (or in up to three words), these mean one thing. Includes the
   typos people actually make on a phone keyboard. */
const BARE = new Set([
  'stop', 'stp', 'sto', 'stopp', 'stoppp', 'srop', 'atop',
  'unsubscribe', 'unsub', 'unsubscribed',
  'pause', 'quit', 'exit', 'cancel', 'remove', 'delete', 'block',
  'band', 'bandh', 'bas', 'nahi', 'nahin', 'no',
]);

/* These mean "stop" wherever they appear in a sentence, in any of the
   languages QuizPe's parents actually write in. */
const PHRASES = [
  'stop sending', 'stop message', 'stop messages', 'stop msg', 'stop all',
  'stop this', 'stop it', 'please stop', 'stop sms', 'stop whatsapp',
  'do not send', 'dont send', 'don t send', 'no more message', 'no more msg',
  'remove my number', 'remove me', 'delete my number', 'delete my data',
  'unsubscribe me', 'opt out', 'not interested', 'no longer interested',
  'leave me alone', 'stop disturbing', 'stop bothering',
  // Hindi / Hinglish, as typed in Roman script
  'band karo', 'band kar do', 'band kardo', 'bandh karo', 'bandh kar do',
  'mat bhejo', 'mat bhejna', 'mat bheje', 'message mat', 'msg mat',
  'nahi chahiye', 'nahin chahiye', 'nahi chahie', 'pareshan mat',
];

/**
 * Has this person asked us to stop?
 * @returns {boolean}
 */
function wantsToStop(text) {
  const t = normalise(text);
  if (!t) return false;

  const words = t.split(' ');
  if (words.length <= 3 && words.some((w) => BARE.has(w))) return true;

  return PHRASES.some((p) => t.includes(p));
}

/* "START" has to be forgiving for the opposite reason: someone who paused
   everything has no other way back in. */
const RESUME = new Set([
  'start', 'resume', 'unpause', 'begin', 'restart', 'continue',
  'chalu', 'shuru', 'suru', 'on',
]);

function wantsToResume(text) {
  const t = normalise(text);
  if (!t) return false;
  const words = t.split(' ');
  if (words.length <= 3 && words.some((w) => RESUME.has(w))) return true;
  return /\b(start|resume|chalu kar|shuru kar)\b/.test(t);
}

module.exports = { wantsToStop, wantsToResume, normalise };
