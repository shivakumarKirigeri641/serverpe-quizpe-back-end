/**
 * scripts/check-pages.js
 * ---------------------------------------------------------------------------
 * Parse-check the inline <script> in every page under public/.
 *
 * Why this exists: a single stray brace in an inline script is a PARSE error,
 * so the whole script never runs — the page renders its empty shell and looks
 * like a backend problem ("questions not loading") while the API is perfectly
 * healthy. Node syntax-checks .js files but nothing was checking these.
 *
 *   node scripts/check-pages.js        # exits non-zero if any page is broken
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public');
// inline scripts only — <script src="..."> has nothing to parse here
const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

let broken = 0, checked = 0;
for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(DIR, file), 'utf8');
  const scripts = [...html.matchAll(INLINE)].map(m => m[1]);
  let error = null;
  for (const src of scripts) {
    try { new Function(src); } catch (e) { error = e.message; }
  }
  checked++;
  if (error) { broken++; console.error(`❌ ${file} — ${error}`); }
  else console.log(`✅ ${file}${scripts.length ? '' : '  (no inline script)'}`);
}

console.log(`\n${checked} page(s) checked, ${broken} broken.`);
process.exit(broken ? 1 : 0);
