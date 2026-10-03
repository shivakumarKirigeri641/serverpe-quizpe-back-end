#!/usr/bin/env node
/**
 * scripts/test-optout.js
 * ---------------------------------------------------------------------------
 * Does "stop" actually stop?
 *
 *   node scripts/test-optout.js
 *
 * The cases at the top are not invented. They are the real messages people
 * sent QuizPe asking to be left alone, taken from production — including the
 * two the old exact-match test silently ignored.
 *
 * The false-positive list matters just as much: a parent writing "don't stop
 * the quiz" must not be unsubscribed by a word search.
 * ---------------------------------------------------------------------------
 */

const { wantsToStop, wantsToResume } = require('../src/whatsapp/optOut');

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m/\x1b[0m ${m}`);
const no = (m) => { failures += 1; console.log(`  \x1b[31mX ${m}\x1b[0m`); };

const should = (text, want, why = '') => {
  const got = wantsToStop(text);
  const line = `${JSON.stringify(text).slice(0, 62).padEnd(64)} ${got ? 'STOP' : 'pass'}`;
  if (got === want) ok(line + (why ? `  (${why})` : ''));
  else no(`${line}  expected ${want ? 'STOP' : 'pass'}${why ? ` — ${why}` : ''}`);
};

console.log('\n\x1b[1mOpt-out — the real messages from production\x1b[0m\n');
should('stop', true, 'the only one the old test caught');
should('delete my number', true, 'IGNORED by the old test');
should('main paisa nahin per karna chahti hun ab yah band kar do tum message bhejna', true,
  'IGNORED by the old test — she asked plainly');

console.log('\n\x1b[1mTypos and punctuation people actually send\x1b[0m\n');
['stp', 'STOP', 'Stop.', 'stop!', ' stop ', 'stopp', 'Stop 🙏', 'UNSUBSCRIBE',
 'unsub', 'cancel', 'remove me', 'quit'].forEach((t) => should(t, true));

console.log('\n\x1b[1mHindi and Hinglish\x1b[0m\n');
['band karo', 'band kar do please', 'message mat bhejo', 'mujhe nahi chahiye',
 'bandh karo ye sab', 'pareshan mat karo'].forEach((t) => should(t, true));

console.log('\n\x1b[1mPhrases inside longer sentences\x1b[0m\n');
['please stop sending me these messages', 'can you remove my number from your list',
 'I am not interested, do not send again', 'stop disturbing me daily'].forEach((t) => should(t, true));

console.log('\n\x1b[1mMUST NOT trigger — ordinary messages\x1b[0m\n');
[
  'hi', 'hello', 'start quiz now', 'my son is in grade 5',
  "please don't stop the quiz, he loves it",
  'when does the quiz stop in the evening?',
  'I will pay tomorrow, do not cancel the plan before that',
  'the quiz stopped halfway, can you check',
  'thanks', 'how much is the fee',
].forEach((t) => should(t, false));

console.log('\n\x1b[1mSTART must stay forgiving\x1b[0m\n');
[['start', true], ['START', true], ['resume', true], ['chalu karo', true],
 ['begin', true], ['unpause', true], ['hi', false],
 // THE REGRESSION. These are real menu buttons. Reading them as "resume"
 // broke the product: a paying parent tapped Start quiz now seven times
 // and was told "Welcome back!" each time while no quiz ever came.
 ['\u25b6\ufe0f Start quiz now', false],
 ['Start quiz', false],
 ['start quiz now', false],
 ['\u26a1 Instant quiz @ \u20b99*', false],
 ['\ud83d\udcc5 Quiz schedule', false],
 ['how do I start the quiz for my daughter', false]]
  .forEach(([t, want]) => {
    const got = wantsToResume(t);
    if (got === want) ok(`${JSON.stringify(t).padEnd(42)} ${got ? 'RESUME' : 'pass'}`);
    else no(`${JSON.stringify(t).padEnd(42)} expected ${want ? 'RESUME' : 'pass'}`);
  });

console.log(
  failures
    ? `\n\x1b[31m${failures} case(s) wrong.\x1b[0m\n`
    : '\n\x1b[32mEvery case correct — including the two production missed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
