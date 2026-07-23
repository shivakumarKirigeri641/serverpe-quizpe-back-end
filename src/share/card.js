/**
 * src/share/card.js
 * ---------------------------------------------------------------------------
 * Square achievement cards a parent can forward.
 *
 * When a child hits a streak milestone or scores full marks, the parent gets a
 * 1080×1080 PNG they can drop straight into a family or school WhatsApp group.
 * Parents share their children's wins already; this simply makes the thing they
 * would share look good and carry our name — which is the cheapest distribution
 * available to us.
 *
 * Built as SVG and rasterised with sharp, which is already a dependency. No
 * headless browser, no canvas build step: a few milliseconds per card.
 *
 * PRIVACY: first name and last initial only, exactly as the leaderboard does.
 * These images travel further than any other thing we produce — often into
 * groups of forty strangers — so a full name, school or mobile number must
 * never appear on one.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SIZE = 1080;
const OUT_DIR = path.join(__dirname, '..', 'uploads', 'share');

/** XML-safe. A child called "Sam & Co" must not break the document. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** "Shivam Kumar" -> "Shivam K." — see the privacy note above. */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Your child';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

/** Long names must not run off the card, so shrink the type instead. */
const fitSize = (text, max, ideal, min) => {
  const n = String(text).length;
  return n <= max ? ideal : Math.max(min, Math.round(ideal * (max / n)));
};

/**
 * Icons are drawn as vector paths, NOT as emoji.
 *
 * The renderer (librsvg, via sharp) has no colour-emoji font, so a 🔥 in the
 * markup rasterises as a solid black silhouette — which looks like a broken
 * image, on the one asset designed to be shown to strangers. Paths render
 * identically everywhere and take their colour from the theme.
 */
const ICONS = {
  // flame
  streak: `<path d="M0,-62 C24,-30 46,-20 46,10 C46,40 24,58 0,58 C-24,58 -46,40 -46,10
                    C-46,-14 -30,-22 -22,-40 C-16,-20 -6,-16 0,-30 Z" fill="#ffb703"/>
           <path d="M0,-14 C12,2 20,10 20,24 C20,40 10,50 0,50 C-10,50 -20,40 -20,24
                    C-20,10 -8,4 0,-14 Z" fill="#fff3b0"/>`,
  // star
  perfect: `<path d="M0,-60 L17,-19 L62,-19 L26,7 L39,50 L0,24 L-39,50 L-26,7 L-62,-19
                     L-17,-19 Z" fill="#ffd166"/>`,
  // medal on a ribbon
  badge: `<path d="M-26,-62 L-8,-10 L8,-10 L26,-62 L10,-62 L0,-32 L-10,-62 Z" fill="#e9c46a"/>
          <circle cx="0" cy="20" r="38" fill="#f4a261"/>
          <circle cx="0" cy="20" r="26" fill="#ffe8a3"/>`,
  // trophy
  milestone: `<path d="M-30,-52 L30,-52 L30,-14 C30,6 16,20 0,20 C-16,20 -30,6 -30,-14 Z" fill="#ffd166"/>
              <path d="M-30,-44 C-52,-44 -52,-14 -34,-10 L-34,-24 C-42,-26 -42,-36 -30,-36 Z" fill="#ffd166"/>
              <path d="M30,-44 C52,-44 52,-14 34,-10 L34,-24 C42,-26 42,-36 30,-36 Z" fill="#ffd166"/>
              <rect x="-7" y="18" width="14" height="26" fill="#e9c46a"/>
              <rect x="-24" y="42" width="48" height="14" rx="5" fill="#e9c46a"/>`,
};

const THEMES = {
  streak:   { bg1: '#075e54', bg2: '#00a884', accent: '#ffd166' },
  perfect:  { bg1: '#0b3d2e', bg2: '#12805f', accent: '#ffd166' },
  badge:    { bg1: '#1d3557', bg2: '#457b9d', accent: '#f4a261' },
  milestone:{ bg1: '#5f0f40', bg2: '#9a1750', accent: '#ffd166' },
};

/**
 * @param kind      streak | perfect | badge | milestone
 * @param name      the child's name (shortened before drawing)
 * @param headline  the big number or short phrase, e.g. "30" or "10/10"
 * @param unit      small word under the headline, e.g. "DAY STREAK"
 * @param subtitle  one line of context, e.g. "CBSE Grade 5 · Mathematics"
 */
function buildSvg({ kind = 'streak', name, headline, unit, subtitle, footer }) {
  const t = THEMES[kind] || THEMES.streak;
  const icon = ICONS[kind] || ICONS.streak;
  const who = esc(shortName(name));
  // Strip any emoji from the headline for the same reason the icons are drawn:
  // it would rasterise as a black blob. Falls back to the unit text.
  const cleaned = String(headline ?? '').replace(/[^\x20-\x7E]/g, '').trim();
  const head = esc(cleaned || unit || '');
  const headSize = fitSize(head, 4, 300, 110);
  const whoSize = fitSize(who, 16, 62, 38);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${t.bg1}"/><stop offset="100%" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>

  <!-- soft rings, so the card is not a flat rectangle of colour -->
  <circle cx="920" cy="170" r="260" fill="#ffffff" opacity="0.05"/>
  <circle cx="150" cy="930" r="300" fill="#ffffff" opacity="0.04"/>

  <text x="${SIZE / 2}" y="150" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="34" font-weight="700" fill="#ffffff" opacity="0.75"
        letter-spacing="7">Q U I Z P E</text>

  <!-- lifted clear of the headline: at 300px the numerals rise to about y=325,
       so the icon has to finish above that or its base sits on the digits -->
  <g transform="translate(${SIZE / 2}, 245) scale(0.92)">${icon}</g>

  <text x="${SIZE / 2}" y="${head.length > 3 ? 520 : 545}" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-size="${headSize}"
        font-weight="800" fill="${t.accent}">${head}</text>

  <text x="${SIZE / 2}" y="610" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="46" font-weight="700" fill="#ffffff" letter-spacing="5">${esc(unit || '')}</text>

  <line x1="340" y1="668" x2="740" y2="668" stroke="#ffffff" stroke-opacity="0.25" stroke-width="3"/>

  <text x="${SIZE / 2}" y="760" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="${whoSize}" font-weight="800" fill="#ffffff">${who}</text>

  ${subtitle ? `<text x="${SIZE / 2}" y="820" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#ffffff"
        opacity="0.8">${esc(subtitle)}</text>` : ''}

  <rect x="240" y="920" width="600" height="86" rx="43" fill="#ffffff" opacity="0.14"/>
  <text x="${SIZE / 2}" y="975" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="32" font-weight="700" fill="#ffffff">${esc(footer || 'Daily quizzes on WhatsApp · quizpe.in')}</text>
</svg>`;
}

/**
 * Renders a card and returns its path.
 *
 * Cards are disposable — regenerating one is cheaper than tracking it — so
 * they are written under a per-day folder that a cleanup job can drop wholesale.
 */
async function renderCard(opts) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(OUT_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opts.kind || 'card'}-${opts.studentId || 'x'}-${Date.now()}.png`);
  await sharp(Buffer.from(buildSvg(opts))).png({ compressionLevel: 9 }).toFile(file);
  return file;
}

/**
 * Decides whether a finished quiz deserves a card, and what it should say.
 *
 * Deliberately stingy. A card for every quiz is spam that gets muted; a card
 * for a genuine milestone gets forwarded. Only round streaks, full marks and
 * gold badges qualify.
 */
function cardFor({ streak, stats, newBadges = [], student }) {
  const base = {
    studentId: student?.id,
    name: student?.name,
    subtitle: [student?.board, student?.grade].filter(Boolean).join(' · ') || null,
  };

  // 28 is a full plan period; 30, 60, 90 and 100 are the round numbers people
  // actually say out loud. Below 7 nothing fires — a 3-day streak is a nice
  // nudge in chat but not something a parent forwards to forty people.
  const MILESTONES = [7, 14, 21, 28, 30, 50, 60, 75, 90, 100, 150, 200, 365];
  if (streak && MILESTONES.includes(streak.current)) {
    return { ...base, kind: 'streak', headline: String(streak.current), unit: 'DAY STREAK',
             footer: 'Every evening on WhatsApp · quizpe.in' };
  }

  // The badge's own emoji is not used as the headline — it would rasterise as
  // a black blob. The drawn medal carries the visual, the name carries meaning.
  const gold = newBadges.find((b) => b.tier === 'gold');
  if (gold) {
    return { ...base, kind: 'badge', headline: 'BADGE', unit: String(gold.badge_name).toUpperCase(),
             footer: 'Earned on QuizPe · quizpe.in' };
  }

  if (stats && stats.lastWasPerfect) {
    return { ...base, kind: 'perfect', headline: '10/10', unit: 'FULL MARKS',
             footer: 'Daily maths quizzes · quizpe.in' };
  }

  const QUIZ_MILESTONES = [25, 50, 100, 200, 365, 500];
  if (stats && QUIZ_MILESTONES.includes(stats.quizzes_done)) {
    return { ...base, kind: 'milestone', headline: String(stats.quizzes_done), unit: 'QUIZZES DONE',
             footer: 'Daily maths quizzes · quizpe.in' };
  }

  return null;      // nothing worth interrupting a parent for
}

module.exports = { renderCard, buildSvg, cardFor, shortName, OUT_DIR };
