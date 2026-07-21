/**
 * src/pdf/fonts.js
 * ---------------------------------------------------------------------------
 * Picks the PDF font family for a student's medium.
 *
 * WHY THIS EXISTS: PDFKit's built-in Helvetica is WinAnsi-encoded and has no
 * Indic glyphs. Kannada text measures ZERO WIDTH in it — the PDF generates
 * fine, the send succeeds, nothing appears in the logs, and the parent opens a
 * report with every question blank. It fails silently, which is the worst way
 * to fail. So any non-Latin medium must use an embedded Unicode font.
 *
 * Noto fonts are SIL Open Font License 1.1 — free to embed and redistribute
 * commercially. Bundled in src/assets/fonts/ rather than relying on system
 * fonts, because the production Linux box will not have Windows' Tunga.
 *
 * ADDING A MEDIUM: drop NotoSans<Script>-Regular.ttf and -Bold.ttf into
 * src/assets/fonts/ and add a line to FAMILIES. Nothing else changes.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'fonts');

// medium_code -> bundled font basename (null = Latin, use built-in Helvetica)
const FAMILIES = {
  ENGLISH: null,
  KANNADA: 'NotoSansKannada',
  HINDI:   'NotoSansDevanagari',
  MARATHI: 'NotoSansDevanagari',
  TAMIL:   'NotoSansTamil',
  TELUGU:  'NotoSansTelugu',
  URDU:    'NotoNastaliqUrdu',
};

const LATIN = { regular: 'Helvetica', bold: 'Helvetica-Bold', oblique: 'Helvetica-Oblique' };

/**
 * Register the right fonts on a document and return the names to use.
 * Falls back to Helvetica when a medium has no bundled font yet — the report
 * still renders, just without native script, and the caller is warned once.
 *
 * @returns {{regular:string, bold:string, oblique:string, unicode:boolean}}
 */
function useFontsFor(doc, mediumCode) {
  const base = FAMILIES[String(mediumCode || 'ENGLISH').toUpperCase()];
  if (!base) return { ...LATIN, unicode: false };

  const reg = path.join(DIR, `${base}-Regular.ttf`);
  const bold = path.join(DIR, `${base}-Bold.ttf`);
  if (!fs.existsSync(reg)) {
    console.error(`[pdf] no bundled font for medium ${mediumCode} (${base}) — ` +
                  `falling back to Helvetica, native script WILL NOT render`);
    return { ...LATIN, unicode: false };
  }

  doc.registerFont('body', reg);
  doc.registerFont('bodyBold', fs.existsSync(bold) ? bold : reg);
  // no true italic in Noto Sans — reuse regular rather than silently dropping text
  doc.registerFont('bodyOblique', reg);
  return { regular: 'body', bold: 'bodyBold', oblique: 'bodyOblique', unicode: true };
}

/** Which mediums can we actually typeset today? Used by content gating. */
function supportedMediums() {
  return Object.entries(FAMILIES)
    .filter(([, base]) => base === null || fs.existsSync(path.join(DIR, `${base}-Regular.ttf`)))
    .map(([code]) => code);
}

module.exports = { useFontsFor, supportedMediums, FAMILIES, DIR };
