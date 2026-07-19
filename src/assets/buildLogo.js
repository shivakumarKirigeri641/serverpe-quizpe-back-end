/**
 * src/assets/buildLogo.js
 * ---------------------------------------------------------------------------
 * QuizPe logo family — clean, flat, typographic. A rounded badge holds a
 * two-tone "QP" monogram (real letterforms, tightly kerned so they read as one
 * mark); the wordmark pairs "Quiz" (ink) with "Pe" (accent), PhonePe-style.
 *
 *   node src/assets/buildLogo.js
 *
 *   logo-mark.png     512×512    badge / app icon
 *   logo-full.png     1080×320   lockup for light backgrounds
 *   logo-white.png    1080×320   lockup for dark/green backgrounds (PDF header)
 *   logo-banner.png   1080×1080  welcome card for WhatsApp
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = __dirname;
const FONT = 'Segoe UI, Arial, Helvetica, sans-serif';
const BRAND_DK = '#064b43', BRAND = '#075e54', BRAND_LT = '#13b48f';
const INK = '#0f1e1b', ACCENT = '#00b283', MINT = '#8ff0dd';
const TAGLINE = 'Small quiz, Big progress';

function wrap(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
}

/* ---- badge + "P nested inside the Q's counter" monogram (concept B) ----
 * A clean Q ring with a diagonal tail, holding a small two-tone P in its hole.
 * Coordinates are in a 512 grid, scaled to `size`. ---- */
function markSVG(size = 512, { flat = false } = {}) {
  const s = size, k = s / 512, r = s * 0.225;
  const qFill = flat ? BRAND : '#ffffff';
  const pFill = flat ? ACCENT : MINT;
  const badge = flat ? '#ffffff' : 'url(#bg)';
  const P = (n) => n * k;                 // scale a 512-grid value
  const tQ = P(42), tP = P(30);           // stroke weights for Q and P
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BRAND_LT}"/>
      <stop offset="1" stop-color="${BRAND}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${s}" height="${s}" rx="${r}" ry="${r}" fill="${badge}"
        ${flat ? `stroke="#e2e6e9" stroke-width="${s*0.01}"` : ''}/>

  <!-- Q: ring -->
  <circle cx="${P(256)}" cy="${P(250)}" r="${P(158)}" fill="none" stroke="${qFill}" stroke-width="${tQ}"/>
  <!-- Q: tail -->
  <path d="M ${P(338)} ${P(330)} L ${P(400)} ${P(392)}" stroke="${qFill}" stroke-width="${tQ}" stroke-linecap="round"/>

  <!-- P nested in the counter: stem + bowl -->
  <rect x="${P(212)}" y="${P(168)}" width="${tP}" height="${P(164)}" rx="${tP*0.4}" fill="${pFill}"/>
  <path d="M ${P(226)} ${P(168)} a ${P(52)} ${P(52)} 0 0 1 0 ${P(104)}"
        fill="none" stroke="${pFill}" stroke-width="${tP}" stroke-linecap="round"/>
  `;
}

/* ---- horizontal lockup ---- */
function lockup(dark) {
  const w = 1080, h = 320, pad = h * 0.16, mark = h - pad * 2;
  const quiz = dark ? '#ffffff' : INK;
  const pe = dark ? MINT : ACCENT;
  const tag = dark ? '#bfe3da' : '#5c6b73';
  const tx = pad + mark + 40;
  return wrap(w, h, `
    <g transform="translate(${pad},${pad})">
      <svg width="${mark}" height="${mark}" viewBox="0 0 512 512">${markSVG(512, { flat: dark })}</svg>
    </g>
    <text x="${tx}" y="${h*0.50}" font-family="${FONT}" font-weight="800" font-size="132" letter-spacing="-3">
      <tspan fill="${quiz}">Quiz</tspan><tspan fill="${pe}">Pe</tspan>
    </text>
    <text x="${tx+3}" y="${h*0.75}" font-family="${FONT}" font-weight="500" font-size="42"
          letter-spacing="0.5" fill="${tag}">${TAGLINE}</text>
  `);
}

/* ---- welcome banner ---- */
function banner() {
  const s = 1080;
  return wrap(s, s, `
    <defs>
      <linearGradient id="card" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${BRAND_LT}"/><stop offset="0.55" stop-color="${BRAND}"/>
        <stop offset="1" stop-color="${BRAND_DK}"/>
      </linearGradient>
    </defs>
    <rect width="${s}" height="${s}" fill="url(#card)"/>
    <circle cx="${s*0.85}" cy="${s*0.14}" r="${s*0.28}" fill="#ffffff" opacity="0.05"/>
    <circle cx="${s*0.12}" cy="${s*0.9}" r="${s*0.22}" fill="#ffffff" opacity="0.05"/>

    <g transform="translate(${s/2-165},${s*0.20})">
      <rect x="0" y="0" width="330" height="330" rx="74" fill="#ffffff" opacity="0.10"/>
      <svg x="25" y="25" width="280" height="280" viewBox="0 0 512 512">${markSVG(512)}</svg>
    </g>
    <text x="${s/2}" y="${s*0.68}" font-family="${FONT}" font-weight="800" font-size="168"
          text-anchor="middle" letter-spacing="-4">
      <tspan fill="#ffffff">Quiz</tspan><tspan fill="${MINT}">Pe</tspan>
    </text>
    <text x="${s/2}" y="${s*0.76}" font-family="${FONT}" font-weight="500" font-size="50"
          fill="#d7fff5" text-anchor="middle" letter-spacing="1">${TAGLINE}</text>
    <rect x="${s/2-235}" y="${s*0.855}" width="470" height="66" rx="33" fill="#ffffff" opacity="0.12"/>
    <text x="${s/2}" y="${s*0.888}" font-family="${FONT}" font-weight="600" font-size="33"
          fill="#eafff9" text-anchor="middle" dominant-baseline="central">Daily learning on WhatsApp · Grades 1–10</text>
  `);
}

async function render(svg, file, w, h) {
  const out = path.join(DIR, file);
  await sharp(Buffer.from(svg)).resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(out);
  console.log(`  ${file.padEnd(18)} ${w}×${h}  ${(fs.statSync(out).size/1024).toFixed(1)} KB`);
}

async function main() {
  console.log('Generating QuizPe logo family:');
  await render(wrap(512, 512, markSVG(512)), 'logo-mark.png', 512, 512);
  await render(lockup(false), 'logo-full.png', 1080, 320);
  await render(lockup(true), 'logo-white.png', 1080, 320);
  await render(banner(), 'logo-banner.png', 1080, 1080);
  console.log('Done →', DIR);
}

if (require.main === module) main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

module.exports = {
  markSVG, lockup, banner,
  paths: {
    mark: path.join(DIR, 'logo-mark.png'),
    full: path.join(DIR, 'logo-full.png'),
    white: path.join(DIR, 'logo-white.png'),
    banner: path.join(DIR, 'logo-banner.png'),
  },
};
