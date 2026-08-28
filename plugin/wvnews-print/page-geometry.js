// GENERATED FILE — DO NOT EDIT.
//
// column grids, gutters and page sizes per publication format
//
// Source of truth: wvnews-platform/src/lib/publication-geometry.js
// Regenerate:      node scripts/generate-plugin-modules.mjs   (in wvnews-platform)
// Verify:          node scripts/generate-plugin-modules.mjs --check
//
// The plugin has no build step, so this is a CommonJS transform of Platform's
// ESM module: identical function bodies, different wrapper. Edit the Platform
// module and regenerate — never edit this file directly, or the plugin will
// disagree with the rest of the system.
//
// sourceSha256: a06f881b100ad2d8

// Page geometry: column grids per publication format.
//
// Source: pubcodes-colsizes.xlsx (2026-08-06), the first authoritative
// column-width table WV News has produced. Before this module the grid
// existed in exactly two places, both hardcoded to the Exponent Telegram
// broadsheet and both duplicated rather than shared:
//
//   src/app/admin/legals/[id]/LegalDetailClient.js  COLUMN_WIDTHS_IN
//   wvnewsplugin/plugin/wvnews-print/indesign.js    ET_COL_W / LEGAL_COLUMN_WIDTHS_IN
//
// Every tabloid publication was therefore laid out and priced on broadsheet
// math. This module is the single source of truth; those call sites should
// migrate to it (the plugin lives in another repo, so it needs a generated
// copy rather than an import — see scripts/audit-publication-codes.mjs).
//
// ── Why this is a THIRD axis, not a replacement for `format` ──────────
//
// The publication/section records already carry two enums that are easy to
// confuse with this one, and neither can drive geometry:
//
//   publications.format          broadsheet | tabloid | magazine | digital | pamphlet
//   specialSections.format       in-paper | inserted | glossy | premium | pamphlet | digital
//   specialSections.type         tab | broadsheet | other | magazine | flip-tab | ...
//
// The first is a masthead classification, the second is a DELIVERY method
// (how the section reaches the reader). Neither says how wide a column is.
// Critically, `tabloid` is ambiguous — WV News runs 6-, 5- and 4-column
// tabloids with different column widths on the same physical page. So this
// module introduces `pageFormat` alongside them rather than overloading
// either. normalizePageFormat() deliberately refuses to guess on 'tabloid'.
//
// ── Pricing ──────────────────────────────────────────────────────────
//
// Rates are quoted per column inch, and a column inch is columns × depth.
// The same ad depth costs a different amount in a 6-col tab than a
// broadsheet because the columns are narrower, which is exactly why the
// rate card cannot be built until this table exists. See columnInches().

// Gutter between columns. Column N is NOT simply N × single-column width —
// it also absorbs the N-1 gutters between them.
//
// The gutter is NOT uniform across formats. Broadsheet and the 6/4-column
// tabs run 0.125" (9pt, the standard newspaper gutter). The 5-column tab
// runs 0.1405". Assuming one global gutter was the original error in this
// module and it produced a wrong 5-column grid — always read `gutterIn`
// off the format, never this constant.
const DEFAULT_GUTTER_IN = 0.125;

// Column widths are stored explicitly rather than computed from width+gutter.
// The stated figures are what production and the ad staff already work from;
// recomputing would silently shift long-standing values in the 4th decimal
// place.
//
// Everything below is the spreadsheet's figures verbatim except three items
// the user corrected on 2026-08-06, each noted at its entry:
//   - tab-5's gutter (0.1405, not 0.125) and its 2-4 column widths
//   - the magazine half-page vertical (3.9375, not 5.9375)
//   - the magazine column grid, which the spreadsheet omitted entirely
const PAGE_FORMATS = {
  broadsheet: {
    id: 'broadsheet',
    label: 'Broadsheet',
    columnCount: 6,
    gutterIn: 0.125,
    // index 0 = 1 column, index 5 = 6 columns (full page)
    columnWidthsIn: [1.6458, 3.4167, 5.1875, 6.9583, 8.7292, 10.5],
    pageWidthIn: 10.5,
    pageDepthIn: 20.42,
    doubleTruckWidthIn: 21.5,
    doubleTruckDepthIn: 20.42,
  },
  'tab-6': {
    id: 'tab-6',
    label: '6 Column Tabloid',
    columnCount: 6,
    gutterIn: 0.125,
    columnWidthsIn: [1.5521, 3.2292, 4.9063, 6.5833, 8.2604, 9.937],
    pageWidthIn: 9.937,
    pageDepthIn: 10,
    doubleTruckWidthIn: 20.5,
    doubleTruckDepthIn: 10,
  },
  'tab-5': {
    id: 'tab-5',
    label: '5 Column Tabloid',
    columnCount: 5,
    // FINAL figures, confirmed by the user 2026-08-06 after two revisions.
    // A 1.875" column on a 0.1405" gutter, reconciling exactly to the
    // spreadsheet's stated 9.937" full page:
    //   5 x 1.875 + 4 x 0.1405 = 9.937"
    //
    // The spreadsheet's COLUMN width was right all along; its 2-4 column
    // figures ([3.875, 5.875, 7.875]) were the wrong part, computed against a
    // 0.125" gutter. That 0.062" shortfall was the original discrepancy.
    //
    // The gutter is unique to this format — every other grid runs 0.125".
    // Never assume a global gutter; read `gutterIn` off the format.
    gutterIn: 0.1405,
    columnWidthsIn: [1.875, 3.8905, 5.906, 7.9215, 9.937],
    pageWidthIn: 9.937,
    pageDepthIn: 10,
    doubleTruckWidthIn: 20.5,
    doubleTruckDepthIn: 10,
  },
  'tab-4': {
    id: 'tab-4',
    label: '4 Column Tabloid',
    columnCount: 4,
    gutterIn: 0.125,
    columnWidthsIn: [2.3906, 4.9063, 7.4219, 9.937],
    pageWidthIn: 9.937,
    pageDepthIn: 10,
    doubleTruckWidthIn: 20.5,
    doubleTruckDepthIn: 10,
  },
  magazine: {
    id: 'magazine',
    label: 'Glossy Magazine',
    // The magazine DOES have a column grid — a 1.2292" column on the standard
    // 0.125" gutter, six columns to the 8" live area (added 2026-08-06; this
    // entry was previously marked gridless, which was wrong).
    //
    // The grid and the named units are the same geometry expressed two ways,
    // and they cross-check exactly:
    //     3 columns = 3.9376" = quarter-vert / half-vert width
    //     6 columns = 8.0002" = full-page / half-horiz width
    // That is also independent confirmation that half-vert is 3.9375" and not
    // the spreadsheet's 5.9375", which falls between columns 4 and 5 and so
    // could not be a real ad width.
    columnCount: 6,
    gutterIn: 0.125,
    columnWidthsIn: [1.2292, 2.5834, 3.9376, 5.2918, 6.646, 8],
    pageWidthIn: 8,      // trim / no-bleed live area
    pageDepthIn: 10.5,
    bleedWidthIn: 9,     // image area, full bleed
    bleedDepthIn: 11.5,
    safeWidthIn: 8,
    safeDepthIn: 10.5,
    namedUnits: {
      'full-page':   { widthIn: 8,      depthIn: 10.5 },
      'half-vert':   { widthIn: 3.9375, depthIn: 10.5 },
      'half-horiz':  { widthIn: 8,      depthIn: 5    },
      'quarter-vert':{ widthIn: 3.9375, depthIn: 5    },
    },
    // half-vert was stated as 5.9375" in the spreadsheet — 3/4 of the live
    // area, not half. Corrected to 3.9375" x 10.5" by the user 2026-08-06:
    // a true vertical half, and exactly 3 columns on the grid above.
  },
  booklet: {
    id: 'booklet',
    label: 'Booklet',
    // Replaced the former 'pamphlet' entry on 2026-08-06. That entry carried
    // the spreadsheet's "Glossy Pamplet" row (9" x 11.5" full page) and no
    // column grid; the real product is a 2-column booklet on a 5" x 8" live
    // area. The 9 x 11.5 figure is superseded — if a product that size still
    // exists it needs its own format, not this one.
    //
    // Third distinct gutter in the table (0.125 / 0.1405 / 0.1667), which is
    // why gutterIn is per-format.
    //   2 x 2.4167 + 0.1667 = 5.0001"
    columnCount: 2,
    gutterIn: 0.1667,
    columnWidthsIn: [2.4167, 5],
    pageWidthIn: 5,
    pageDepthIn: 8,
    namedUnits: {
      'full-page': { widthIn: 5, depthIn: 8 },
    },
  },
};

// Spreadsheet labels and the legacy enums both map in here. Anything that
// cannot be resolved to a single grid returns null — callers must handle it
// rather than receive a plausible guess.
const FORMAT_ALIASES = new Map(Object.entries({
  // canonical
  broadsheet: 'broadsheet',
  'tab-6': 'tab-6', 'tab-5': 'tab-5', 'tab-4': 'tab-4',
  magazine: 'magazine', booklet: 'booklet',
  // spreadsheet column "Publication Format"
  '6tab': 'tab-6', '5tab': 'tab-5', '4tab': 'tab-4',
  '6 column tabloid': 'tab-6', '5 column tabloid': 'tab-5', '4 column tabloid': 'tab-4',
  'glossy magazine': 'magazine',
  // Legacy: the spreadsheet called this "Glossy Pamplet" (sic) and older
  // records use format 'pamphlet'. Both resolve to the booklet grid — it is
  // the same physical product — but note the live area is 5" x 8", NOT the
  // 9" x 11.5" the spreadsheet's pamphlet row stated.
  'glossy pamplet': 'booklet',
  'glossy pamphlet': 'booklet',
  pamphlet: 'booklet',
}));

// Formats that exist in the legacy enums but do NOT determine a column grid.
// Kept separate from the alias table so the reason is explicit at the call
// site instead of looking like an accidental miss.
const AMBIGUOUS_FORMATS = new Set(['tabloid', 'tab']);
const NON_PRINT_FORMATS = new Set(['digital', 'digital-only']);

// normalizePageFormat('6Tab') → 'tab-6'; normalizePageFormat('tabloid') → null.
//
// 'tabloid' resolves to null ON PURPOSE. 80 of the 150 publications are
// 6-column and 2 are 5-column; defaulting would silently misprice the
// exceptions. Use pageFormatIsAmbiguous() to tell "needs a decision" apart
// from "unrecognized".
function normalizePageFormat(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  return FORMAT_ALIASES.get(key) || null;
}

function pageFormatIsAmbiguous(value) {
  return AMBIGUOUS_FORMATS.has(String(value || '').trim().toLowerCase());
}

function getPageFormat(value) {
  const id = normalizePageFormat(value);
  return id ? PAGE_FORMATS[id] : null;
}

// Width in inches of an N-column ad. Returns null for magazine/pamphlet
// (no grid) or an out-of-range column count.
function columnWidthIn(format, columns) {
  const f = getPageFormat(format);
  if (!f || !Array.isArray(f.columnWidthsIn)) return null;
  const n = Number(columns);
  if (!Number.isInteger(n) || n < 1 || n > f.columnWidthsIn.length) return null;
  return f.columnWidthsIn[n - 1];
}

// Distance from the LEFT edge of the live area to the left edge of column N.
//
// The other half of the geometry an InDesign frame needs: columnWidthIn gives
// the width of an N-column block, this gives where it starts. Column 1 is 0;
// after that it is the width of the block to its left plus the gutter that
// separates them — NOT (N-1) x single-column width, which would drop every
// intervening gutter and creep an ad left by up to 0.7" on a broadsheet.
//
// Returns null for an unknown format or a column outside the grid, so a
// caller cannot build a frame from a guess.
function columnOffsetIn(format, startColumn) {
  const f = getPageFormat(format);
  if (!f || !Array.isArray(f.columnWidthsIn)) return null;
  const n = Number(startColumn);
  if (!Number.isInteger(n) || n < 1 || n > f.columnWidthsIn.length) return null;
  if (n === 1) return 0;
  const gutter = f.gutterIn ?? DEFAULT_GUTTER_IN;
  return Number((f.columnWidthsIn[n - 2] + gutter).toFixed(4));
}

// Inverse of columnWidthIn — snap a measured width back onto the grid.
// Used when an incoming ad is described in inches (legacy orders, supplied
// artwork) and has to be reconciled to a column count. Tolerance defaults to
// half a gutter, which is tight enough that adjacent columns never overlap.
function columnsForWidthIn(format, widthIn, tolerance = null) {
  const f = getPageFormat(format);
  if (!f || !Array.isArray(f.columnWidthsIn)) return null;
  // Half the format's OWN gutter — tight enough that adjacent columns can
  // never both match, and correct for tab-5's wider gutter.
  const tol = tolerance == null ? (f.gutterIn ?? DEFAULT_GUTTER_IN) / 2 : tolerance;
  const w = Number(widthIn);
  if (!Number.isFinite(w)) return null;
  let best = null;
  let bestDelta = Infinity;
  f.columnWidthsIn.forEach((cw, i) => {
    const delta = Math.abs(cw - w);
    if (delta < bestDelta) { bestDelta = delta; best = i + 1; }
  });
  return bestDelta <= tol ? best : null;
}

// The billing unit for per-column-inch rates: columns × depth in inches.
// Deliberately NOT area — a 2col × 5in ad is 10 column inches on every
// format, but it is a different physical size on each, which is what the
// per-format rate is for.
function columnInches(columns, depthIn) {
  const c = Number(columns);
  const d = Number(depthIn);
  if (!Number.isInteger(c) || c < 1 || !Number.isFinite(d) || d <= 0) return null;
  return c * d;
}

function fullPageDimensions(format) {
  const f = getPageFormat(format);
  return f ? { widthIn: f.pageWidthIn, depthIn: f.pageDepthIn } : null;
}

function doubleTruckDimensions(format) {
  const f = getPageFormat(format);
  if (!f || !f.doubleTruckWidthIn) return null;
  return { widthIn: f.doubleTruckWidthIn, depthIn: f.doubleTruckDepthIn };
}

// Named fractional unit for glossies ('full-page', 'half-horiz', ...).
function namedUnitDimensions(format, unitId) {
  const f = getPageFormat(format);
  if (!f || !f.namedUnits) return null;
  const u = f.namedUnits[String(unitId || '').toLowerCase()];
  return u ? { widthIn: u.widthIn, depthIn: u.depthIn } : null;
}

// Every figure in this module that the spreadsheet states but that does not
// reconcile arithmetically. Surfaced as data so the audit script and any
// future rate-card builder can refuse to price against an unverified grid
// instead of rediscovering the discrepancy.
function unverifiedFigures() {
  const out = [];
  for (const f of Object.values(PAGE_FORMATS)) {
    if (f.columnWidthsUnverified) {
      out.push({ format: f.id, field: 'columnWidthsIn', note: 'full-page width does not reconcile with column width + gutter' });
    }
    for (const unit of f.namedUnitsUnverified || []) {
      out.push({ format: f.id, field: `namedUnits.${unit}`, note: 'stated width is inconsistent with the fraction it names' });
    }
  }
  return out;
}

module.exports = {
  DEFAULT_GUTTER_IN,
  PAGE_FORMATS,
  AMBIGUOUS_FORMATS,
  NON_PRINT_FORMATS,
  normalizePageFormat,
  pageFormatIsAmbiguous,
  getPageFormat,
  columnWidthIn,
  columnOffsetIn,
  columnsForWidthIn,
  columnInches,
  fullPageDimensions,
  doubleTruckDimensions,
  namedUnitDimensions,
  unverifiedFigures,
};
