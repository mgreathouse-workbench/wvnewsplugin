// Color-placement rules for the WV News press. Given the product FORMAT
// (broadsheet | tab), the page-count config, and a page number, tells us
// whether that page can run FULL COLOR (FC) or is black-and-white (BW).
//
// Used to gate color-ad placement: the plugin only offers color ads for
// pages that are FC. Encoded from "Color Placement Configuration" (press
// spec). Every list below is the set of FC page numbers; any page not in
// the list is BW.

// ── BROADSHEET ────────────────────────────────────────────────────────────
// Keyed by PAGES-PER-SECTION. A broadsheet run is 2 sections (A + B) that
// share the same pattern, e.g. a 12-page paper = "Two Six" = 2×6-page
// sections; a 24-page = "Two Twelve" = 2×12. >24pp splits into 4 sections.
// Folios look like "B3" / "A5" — section letter FIRST, and the page number
// RESETS per section (page 3 of section B = "B3"). The section letter itself
// doesn't change color; only the page-within-section number does.
const BROADSHEET_FC_BY_SECTION_SIZE = {
  6:  [1, 3, 4, 6],
  8:  [1, 3, 4, 5, 6, 8],
  10: [1, 3, 4, 5, 6, 10],
  12: [1, 5, 6, 7, 8, 12],
};

// ── TABLOID ("Tab") ───────────────────────────────────────────────────────
// Keyed by TOTAL page count. Folios are plain page numbers "1".."N".
const TAB_FC_BY_PAGE_COUNT = {
  4:  [1, 2, 3, 4],
  8:  [1, 2, 3, 4, 5, 6, 7, 8],
  12: [1, 3, 4, 6, 7, 9, 10, 12],                       // 2,5,8,11 BW — "CANNOT run all color in 12"
  16: [1, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 16],        // 2,7,10,15 BW
  20: [1, 3, 4, 5, 6, 10, 11, 15, 16, 17, 18, 20],      // ⚠ last two rows of the CSV read 15/16 again (typo) — assumed 19-BW,20-FC
  24: [1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22, 24],
  32: [1, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 16, 17, 19, 20, 21, 22, 24, 25, 27, 28, 29, 30, 32],
  40: [1, 3, 4, 5, 6, 10, 11, 13, 14, 15, 16, 20, 21, 25, 26, 27, 28, 30, 31, 35, 36, 37, 38, 40],
  48: [1, 5, 6, 7, 8, 12, 13, 17, 18, 19, 20, 24, 25, 29, 30, 31, 32, 36, 37, 38, 41, 42, 43, 44, 48],
};

// Parse a folio like "3A", "5B", "12", "A-4" into { section, num }.
function parseFolio(folio) {
  const s = String(folio || '').trim().toUpperCase().replace(/[-\s]/g, '');
  const m = s.match(/^([A-Z]*)?0*(\d+)([A-Z]*)?$/);
  if (!m) return null;
  const section = m[1] || m[3] || '';
  const num = parseInt(m[2], 10);
  return Number.isFinite(num) ? { section, num } : null;
}

// Is `pageNum` a full-color page?
//   format          — 'broadsheet' | 'tab'
//   count           — broadsheet: PAGES PER SECTION (6/8/10/12); tab: TOTAL pages
//   pageNum         — page number within the section (broadsheet) or overall (tab)
// Returns true (FC), false (BW), or null when the config isn't in the table.
function isColorPageNum(format, count, pageNum) {
  const table = format === 'tab' ? TAB_FC_BY_PAGE_COUNT : BROADSHEET_FC_BY_SECTION_SIZE;
  const fc = table[count];
  if (!fc) return null; // unknown config → caller decides (fail safe = treat as BW)
  return fc.indexOf(pageNum) >= 0;
}

// Convenience: resolve straight from a folio string.
function isColorFolio(format, count, folio) {
  const p = parseFolio(folio);
  if (!p) return null;
  return isColorPageNum(format, count, p.num);
}

// Broadsheet PAGES-PER-SECTION from the total broadsheet page count.
//   ≤24pp → 2 sections (A + B), so section size = total / 2.
//   >24pp → 4 sections; the press spec doesn't enumerate 4-section color
//           patterns, so we return null (caller treats as unknown → warn).
// Returns null for odd totals or anything we can't map to a known table.
function broadsheetSectionSize(totalPages) {
  const n = Number(totalPages);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 24 && n % 2 === 0) {
    const size = n / 2;
    return BROADSHEET_FC_BY_SECTION_SIZE[size] ? size : null;
  }
  return null; // 4-section runs (>24pp broadsheet) not in the spec
}

// Unified entry point for the plugin. Give it what the edition knows:
//   opts.format     — 'broadsheet' | 'tab'
//   opts.totalPages — total pages in the edition (chosen at edition creation)
//   opts.folio      — current page folio ("B3" broadsheet, "7" tab)
// Returns { color: true|false|null, reason }.
//   color=true  → page is Full Color, color ads OK
//   color=false → page is B/W, warn before placing a color ad
//   color=null  → config not recognized; caller should warn (fail-safe = BW)
function isColorPage(opts) {
  const format = (opts && opts.format) === 'tab' ? 'tab' : 'broadsheet';
  const parsed = parseFolio(opts && opts.folio);
  if (!parsed) return { color: null, reason: 'unrecognized folio' };

  if (format === 'tab') {
    const c = isColorPageNum('tab', Number(opts.totalPages), parsed.num);
    if (c === null) return { color: null, reason: `no tab config for ${opts.totalPages}pp` };
    return { color: c, reason: c ? 'FC' : 'BW' };
  }

  const size = broadsheetSectionSize(opts.totalPages);
  if (size === null) return { color: null, reason: `no broadsheet config for ${opts.totalPages}pp` };
  const c = isColorPageNum('broadsheet', size, parsed.num);
  if (c === null) return { color: null, reason: `page ${parsed.num} out of range for ${size}pp section` };
  return { color: c, reason: c ? 'FC' : 'BW' };
}

module.exports = {
  BROADSHEET_FC_BY_SECTION_SIZE,
  TAB_FC_BY_PAGE_COUNT,
  parseFolio,
  isColorPageNum,
  isColorFolio,
  broadsheetSectionSize,
  isColorPage,
};
