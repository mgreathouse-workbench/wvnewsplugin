// GENERATED FILE — DO NOT EDIT.
//
// how a liner is typeset — the one spec the plugin SETS and the platform estimates section depth from
//
// Source of truth: wvnews-platform/src/lib/liner-type-spec.js
// Regenerate:      node scripts/generate-plugin-modules.mjs   (in wvnews-platform)
// Verify:          node scripts/generate-plugin-modules.mjs --check
//
// The plugin has no build step, so this is a CommonJS transform of Platform's
// ESM module: identical function bodies, different wrapper. Edit the Platform
// module and regenerate — never edit this file directly, or the plugin will
// disagree with the rest of the system.
//
// sourceSha256: f0d3f0e741e1455a

// How a liner is actually typeset: classifieds, legal notices, obituaries.
//
// ZERO IMPORTS, and that is load-bearing: this module is generated into the
// plugin by scripts/generate-plugin-modules.mjs, which only strips the
// `export` keyword and cannot resolve one Platform module from another. So
// every function here takes the column WIDTH as a number rather than looking
// it up from a format — the platform resolves it with columnWidthIn, the
// plugin with its own generated copy of the same grid, and both get the same
// answer from the same arithmetic.
//
// One source of truth, because two things depend on these numbers and they
// have to agree:
//
//   1. the plugin, which SETS the type (indesign.js CONTENT_BLOCK)
//   2. the platform, which has to say how much paper a section will need
//      BEFORE anyone lays it out (liner-space.js)
//
// A space estimate computed from different numbers than the typesetter uses is
// a wrong page count, and a wrong page count is either a section that does not
// fit or a wasted page.
//
// ── Where these came from ───────────────────────────────────────────
//
// Read out of the plugin, which is where the type is applied:
//
//   indesign.js:734
//     CONTENT_BLOCK = { widthIn: columnWidthIn(PAGE_FORMAT, 1),
//                       font: 'Helvetica Neue', pointSize: 8, leading: 8.5 }
//     "Standard 1-column content block for manually-placed marketplace
//      content (legals / classifieds / obits)"
//
// All three kinds share it — placeMarketplaceBlock builds one `fmt` from
// CONTENT_BLOCK and uses it for every kind.
//
// ── This is NOT the billing measurement ─────────────────────────────
//
// legal-rates.js measures a notice at 30 chars/line and **12 lines per inch**
// ("the standard for 7pt body") because legals and obits are billed by the
// agate line. The type is actually set at 8pt on 8.5pt leading, which is
// 8.47 lines per inch — so a notice occupies about 42% MORE paper than the
// billing figure's `columnInches` claims.
//
// Both numbers are kept, deliberately. Billing is a contract and is not
// changed here. But anything about PAPER uses this module, and if a
// publication is configured to bill legals by the column inch rather than by
// the line, its inch figure is low by that 42% and is worth a look.

// The one spec, shared by all three liner kinds.
const LINER_TYPE = {
  font: 'Helvetica Neue',
  pointSize: 8,
  leading: 8.5,
};

// Points per inch. Not a preference.
const PT_PER_IN = 72;

// Average character advance as a fraction of the point size, for Helvetica
// Neue regular set in mixed-case English.
//
// THE ONE ESTIMATED INPUT HERE. The font's real metrics are not in this repo —
// everything else on this page (point size, leading, column width) is exact.
// 0.52 em is the usual figure for Helvetica-family text with ordinary
// lowercase distribution; it is an argument on charsPerLine so a single
// measured correction from a printed section fixes every derived number.
const AVG_CHAR_EM = 0.52;

// Lines of set type per vertical inch. 72 / 8.5 = 8.47.
//
// This is the number that matters most and the one the billing spec gets
// wrong: it is what turns a line count into paper.
const LINES_PER_INCH = PT_PER_IN / LINER_TYPE.leading;

/**
 * How many characters fit on one line in a block `widthIn` inches wide.
 *
 * Takes the width as a number, not a format — see the note at the top about
 * why this module cannot import the grid. Derived rather than tabulated, so a
 * tab's narrower column and a 2-column legal both come out right without
 * anyone maintaining a table.
 */
function charsPerLineForWidth(widthIn, { avgCharEm = AVG_CHAR_EM } = {}) {
  const w = Number(widthIn);
  if (!Number.isFinite(w) || w <= 0) return null;
  const charPt = LINER_TYPE.pointSize * (Number(avgCharEm) || AVG_CHAR_EM);
  if (charPt <= 0) return null;
  return Math.max(8, Math.floor((w * PT_PER_IN) / charPt));
}

/** Vertical inches a given number of set lines occupies. */
function inchesForLines(lines, { linesPerInch = LINES_PER_INCH } = {}) {
  const n = Number(lines);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const lpi = Number(linesPerInch) || LINES_PER_INCH;
  return n / lpi;
}

// An obituary's portrait, from the plugin's own geometry:
//   indesign.js  OBIT_PHOTO_ASPECT = 1.2   // height = width * 1.2 (portrait)
// Column-wide, so its depth follows the column width exactly.
const OBIT_PHOTO_ASPECT = 1.2;

function obitPhotoDepthIn(widthIn) {
  const w = Number(widthIn);
  return Number.isFinite(w) && w > 0 ? w * OBIT_PHOTO_ASPECT : 0;
}

// A CLASSIFIED's photo add-on does not print.
//
// classified-presentation.js, which the plugin also has a generated copy of,
// is explicit: "photo — an image on the ad. WEB ONLY — a classified prints as
// a text line in a stacked column, and an image cannot be placed in one
// without geometry the print grid does not have for it."
//
// So a classified billed for a photo takes no extra paper, and a space
// estimate that allowed for one would over-reserve the section.
const CLASSIFIED_PHOTO_PRINTS = false;

// The whole resolved spec for a publication format, for a UI that wants to
// show its workings rather than assert a number.
function linerTypeSpecForWidth(widthIn, { avgCharEm = AVG_CHAR_EM, columns = 1 } = {}) {
  return {
    font: LINER_TYPE.font,
    pointSize: LINER_TYPE.pointSize,
    leading: LINER_TYPE.leading,
    linesPerInch: Math.round(LINES_PER_INCH * 100) / 100,
    columnWidthIn: Number(widthIn) || null,
    charsPerLine: charsPerLineForWidth(widthIn, { avgCharEm }),
    avgCharEm,
    columns,
  };
}

module.exports = {
  LINER_TYPE,
  AVG_CHAR_EM,
  LINES_PER_INCH,
  charsPerLineForWidth,
  inchesForLines,
  OBIT_PHOTO_ASPECT,
  obitPhotoDepthIn,
  CLASSIFIED_PHOTO_PRINTS,
  linerTypeSpecForWidth,
};
