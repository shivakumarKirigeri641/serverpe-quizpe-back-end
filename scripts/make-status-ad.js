/**
 * scripts/make-status-ad.js — the WhatsApp Status / Instagram Stories creative.
 *
 *   node scripts/make-status-ad.js
 *
 * 1080x1920, written into the banners folder. Edit the words below and re-run
 * to produce a variant; the file is overwritten in place.
 *
 * This is the landscape banner (scooter-banner-a.png) turned upright. The
 * colours are sampled from that file rather than guessed, and the wording is
 * kept: a parent who sees the pamphlet and then the ad should recognise the
 * same product, and a second visual identity is a cost with no return.
 *
 * NO QR CODE, unlike the printed version. A status is watched on the same phone
 * that would have to scan it, so the code is unusable there. The ad's own Send
 * Message button does that work instead, opening the chat with "hi" already
 * typed — which is why the line below says to say exactly that, and why the
 * pre-filled message in Ads Manager must match it word for word.
 *
 * THE SAFE ZONE IS THE REAL CONSTRAINT. WhatsApp draws the sender and timestamp
 * over the top of a status, and the reply box and call-to-action over the
 * bottom, so roughly the top 15% and bottom 20% are never seen. Everything that
 * must be read lives between y=288 and y=1536; the emptiness below the last
 * line is deliberate, not an unfinished layout.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = 'C:/Users/shiva/OneDrive/Data/Docs/serverpe/quizpe/banners_and_pic';
const OUT = path.join(OUT_DIR, 'status-ad-portrait-1080x1920.png');
const LOGO = path.join(OUT_DIR, 'logo-mark.png');

const W = 1080, H = 1920;
const TOP = 288, BOTTOM = 1536;
const MID = W / 2;
const FONT = 'Segoe UI, Inter, Arial, sans-serif';

/* Sampled from scooter-banner-a.png, so the two pieces sit together rather
   than one looking like an approximation of the other. */
const GREEN_LIGHT = '#117859';
const GREEN_MID   = '#0E6148';
const GREEN_DARK  = '#0A4633';
const GOLD        = '#F7CE5B';
const AMBER       = '#F0A52A';
const MINT        = '#7CDCA8';

const logo = fs.existsSync(LOGO)
  ? `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}` : null;

/** A pill, centred on the frame. */
function pill({ y, w, h, label, filled, extra = '', dx = 0 }) {
  const x = MID - w / 2;
  return filled
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${AMBER}"/>
       <text x="${MID}" y="${y + h / 2 + 17}" font-family="${FONT}" font-size="48"
             font-weight="800" fill="#123024" text-anchor="middle" letter-spacing="1">${label}</text>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="none"
             stroke="${GOLD}" stroke-width="4"/>
       ${extra}
       <text x="${MID + dx}" y="${y + h / 2 + 16}" font-family="${FONT}" font-size="44"
             font-weight="700" fill="${GOLD}" text-anchor="middle">${label}</text>`;
}

/* A drawn bolt rather than the emoji: glyph coverage through SVG rendering is
   not dependable, and a missing character in the middle of a pill is the most
   visible failure on the page. */
const bolt = (x, y, s = 1) => `<polygon points="
  ${x},${y} ${x + 26 * s},${y} ${x + 12 * s},${y + 26 * s} ${x + 34 * s},${y + 26 * s}
  ${x + 2 * s},${y + 62 * s} ${x + 12 * s},${y + 34 * s} ${x - 8 * s},${y + 34 * s}"
  fill="#FF8A3D"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.75" y2="1">
      <stop offset="0%"   stop-color="${GREEN_LIGHT}"/>
      <stop offset="52%"  stop-color="${GREEN_MID}"/>
      <stop offset="100%" stop-color="${GREEN_DARK}"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="960" cy="420"  r="400" fill="#ffffff" opacity="0.035"/>
  <circle cx="90"  cy="1500" r="330" fill="#ffffff" opacity="0.030"/>

  <!-- ── identity ─────────────────────────────────────────────────────── -->
  ${logo ? `<image href="${logo}" x="${MID - 210}" y="${TOP + 4}" width="100" height="100"/>` : ''}
  <text x="${MID - 92}" y="${TOP + 60}" font-family="${FONT}" font-size="54"
        font-weight="800" fill="#ffffff">Quiz<tspan fill="${MINT}">Pe</tspan></text>
  <text x="${MID - 92}" y="${TOP + 96}" font-family="${FONT}" font-size="24"
        fill="#BFE6D2">Small quiz, Big progress</text>

  <!-- ── the claim ────────────────────────────────────────────────────── -->
  <text x="${MID}" y="${TOP + 272}" font-family="${FONT}" font-size="88" font-weight="800"
        fill="#ffffff" text-anchor="middle" letter-spacing="-1">Daily revision quiz</text>
  <text x="${MID}" y="${TOP + 374}" font-family="${FONT}" font-size="88" font-weight="800"
        fill="${GOLD}" text-anchor="middle" letter-spacing="-1">for your child</text>

  <text x="${MID}" y="${TOP + 462}" font-family="${FONT}" font-size="42"
        fill="#D8F0E2" text-anchor="middle">5 minutes a day, on WhatsApp</text>
  <text x="${MID}" y="${TOP + 518}" font-family="${FONT}" font-size="42"
        fill="#D8F0E2" text-anchor="middle">Classes 1 to 10</text>

  <!-- ── the two ways in ──────────────────────────────────────────────── -->
  ${pill({ y: TOP + 592, w: 520, h: 104, label: '7 DAYS FREE', filled: true })}
  ${pill({
    y: TOP + 724, w: 640, h: 104, label: 'Instant quiz @ ₹9*', filled: false, dx: 30,
    extra: bolt(MID - 248, TOP + 746, 0.85),
  })}

  <!-- ── what to do ───────────────────────────────────────────────────── -->
  <text x="${MID}" y="${TOP + 918}" font-family="${FONT}" font-size="46" font-weight="700"
        fill="${MINT}" text-anchor="middle">Say “Hi” on WhatsApp</text>

  <text x="${MID}" y="${TOP + 1024}" font-family="${FONT}" font-size="84" font-weight="800"
        fill="#ffffff" text-anchor="middle" letter-spacing="1">86185 92876</text>

  <text x="${MID}" y="${TOP + 1102}" font-family="${FONT}" font-size="40" font-weight="700"
        fill="${GOLD}" text-anchor="middle">www.quizpe.in</text>
</svg>`;

(async () => {
  await sharp(Buffer.from(svg)).png().toFile(OUT);
  const m = await sharp(OUT).metadata();
  const lowest = TOP + 1102;
  console.log(`written : ${OUT}`);
  console.log(`size    : ${m.width} x ${m.height}   ratio ${(m.width / m.height).toFixed(3)} (9:16 = 0.563)`);
  console.log(`safe    : lowest text at y=${lowest}, limit ${BOTTOM} — ${BOTTOM - lowest}px clear`);
})().catch((e) => { console.error(e.message); process.exit(1); });
