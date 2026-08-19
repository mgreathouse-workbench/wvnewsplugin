// GENERATED FILE — DO NOT EDIT.
//
// press colour patterns — which pages can run full colour
//
// Source of truth: wvnews-platform/src/lib/color-placement.js
// Regenerate:      node scripts/generate-plugin-modules.mjs   (in wvnews-platform)
// Verify:          node scripts/generate-plugin-modules.mjs --check
//
// The plugin has no build step, so this is a CommonJS transform of Platform's
// ESM module: identical function bodies, different wrapper. Edit the Platform
// module and regenerate — never edit this file directly, or the plugin will
// disagree with the rest of the system.
//
// sourceSha256: f2643a75ad5bafa1

// Colour-placement rules for the WV News press: given a publication's format,
// the run's page/section configuration and a folio, is that page Full Colour
// or black-and-white?
//
// Ported from wvnewsplugin/plugin/wvnews-print/color-placement.js, which was
// the only copy and lived where the layout grid could not reach it. This is
// now the source of truth; the plugin gets a GENERATED CommonJS copy via
// scripts/generate-plugin-color.mjs. Never edit the plugin's copy by hand.
//
// The tables are the press spec verbatim — do not "tidy" them. Several rows
// are deliberately irregular (a 12-page tab genuinely cannot run all colour).

// ── BROADSHEET ───────────────────────────────────────────────────────
// Keyed by PAGES-PER-SECTION. A broadsheet run is 2 sections (A + B) sharing
// one pattern: a 12-page paper is 2x6, a 24-page is 2x12. Folios are
// "A5"/"B3" — the page number RESETS per section, so B3 is page 3 of B.
const BROADSHEET_FC_BY_SECTION_SIZE = {
  6:  [1, 3, 4, 6],
  8:  [1, 3, 4, 5, 6, 8],
  10: [1, 3, 4, 5, 6, 10],
  12: [1, 5, 6, 7, 8, 12],
};

// ── TABLOID ──────────────────────────────────────────────────────────
// Keyed by TOTAL page count. Folios are plain page numbers.
const TAB_FC_BY_PAGE_COUNT = {
  4:  [1, 2, 3, 4],
  8:  [1, 2, 3, 4, 5, 6, 7, 8],
  12: [1, 3, 4, 6, 7, 9, 10, 12],                       // 2,5,8,11 BW — "CANNOT run all color in 12"
  16: [1, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 16],        // 2,7,10,15 BW
  20: [1, 3, 4, 5, 6, 10, 11, 15, 16, 17, 18, 20],      // source CSV repeats 15/16 (typo); 19 assumed BW
  24: [1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22, 24],
  32: [1, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 16, 17, 19, 20, 21, 22, 24, 25, 27, 28, 29, 30, 32],
  40: [1, 3, 4, 5, 6, 10, 11, 13, 14, 15, 16, 20, 21, 25, 26, 27, 28, 30, 31, 35, 36, 37, 38, 40],
  48: [1, 5, 6, 7, 8, 12, 13, 17, 18, 19, 20, 24, 25, 29, 30, 31, 32, 36, 37, 38, 41, 42, 43, 44, 48],
};

// pageFormat (publication record) -> press format. The three tab widths all
// run on the same press pattern; only the column grid differs.
//
// Glossies are not in the press spec because they do not run on this press —
// every glossy rate card in the 2026 media kit states "ALL RATES INCLUDE FULL
// COLOR", so they are treated as entirely colour rather than unknown.
const PRESS_FORMAT_BY_PAGE_FORMAT = {
  broadsheet: 'broadsheet',
  'tab-6': 'tab',
  'tab-5': 'tab',
  'tab-4': 'tab',
  magazine: 'glossy',
  booklet: 'glossy',
};

// Parse "A5", "5A", "12", "A-4" into { section, num }.
function parseFolio(folio) {
  const s = String(folio || '').trim().toUpperCase().replace(/[-\s]/g, '');
  const m = s.match(/^([A-Z]*)?0*(\d+)([A-Z]*)?$/);
  if (!m) return null;
  const section = m[1] || m[3] || '';
  const num = parseInt(m[2], 10);
  return Number.isFinite(num) ? { section, num } : null;
}

// true (FC) | false (BW) | null (config not in the table — caller decides,
// fail-safe is to treat null as BW).
function isColorPageNum(format, count, pageNum) {
  const table = format === 'tab' ? TAB_FC_BY_PAGE_COUNT : BROADSHEET_FC_BY_SECTION_SIZE;
  const fc = table[count];
  if (!fc) return null;
  return fc.indexOf(pageNum) >= 0;
}

function isColorFolio(format, count, folio) {
  const p = parseFolio(folio);
  if (!p) return null;
  return isColorPageNum(format, count, p.num);
}

// Pages-per-section inferred from a total, for callers with no section data.
//   <=24pp even -> 2 sections, size = total/2
//   >24pp       -> 4 sections; the spec does not enumerate those, so null.
function broadsheetSectionSize(totalPages) {
  const n = Number(totalPages);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 24 && n % 2 === 0) {
    const size = n / 2;
    return BROADSHEET_FC_BY_SECTION_SIZE[size] ? size : null;
  }
  return null;
}

// { color: true|false|null, reason }
function isColorPage(opts) {
  const format = opts?.format === 'tab' ? 'tab' : 'broadsheet';
  const parsed = parseFolio(opts?.folio);
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

// Resolve colour for one page of a real edition.
//
// Prefers the edition's ACTUAL sections[] over inferring from the total. The
// plugin could only guess "total / 2", which is wrong whenever the sections
// are uneven — EXT_062326 runs A=8, B=3, where the inference returns null for
// the whole edition but section A is a perfectly ordinary 8pp pattern.
//
// edition: { sections?: [{letter, pageCount}], pages?: [] }
// pub:     publication record (pageFormat)
function colorForEditionPage(edition, pub, folio) {
  const pressFormat = PRESS_FORMAT_BY_PAGE_FORMAT[pub?.pageFormat] || null;
  if (!pressFormat) {
    return { color: null, reason: pub?.pageFormat ? `no press pattern for ${pub.pageFormat}` : 'publication has no pageFormat' };
  }
  if (pressFormat === 'glossy') {
    return { color: true, reason: 'glossy — all pages full colour' };
  }

  const parsed = parseFolio(folio);
  if (!parsed) return { color: null, reason: 'unrecognized folio' };
  const sections = Array.isArray(edition?.sections) ? edition.sections : [];
  const totalPages = sections.length
    ? sections.reduce((a, s) => a + (Number(s.pageCount) || 0), 0)
    : (edition?.pages?.length || 0);

  if (pressFormat === 'tab') {
    const c = isColorPageNum('tab', totalPages, parsed.num);
    return c === null
      ? { color: null, reason: `no tab colour pattern for ${totalPages}pp` }
      : { color: c, reason: c ? 'FC' : 'BW' };
  }

  // Broadsheet: use this folio's OWN section size when we know it.
  const section = sections.find(s => String(s.letter).toUpperCase() === parsed.section);
  const size = section ? Number(section.pageCount) : broadsheetSectionSize(totalPages);
  if (!size) return { color: null, reason: `unknown section size for folio ${folio}` };
  const c = isColorPageNum('broadsheet', size, parsed.num);
  return c === null
    ? { color: null, reason: `no colour pattern for a ${size}pp section` }
    : { color: c, reason: c ? 'FC' : 'BW' };
}

// A colour ad on a BW page is the error this whole module exists to prevent.
// null (unknown config) is treated as NOT placeable, since shipping a colour
// ad onto a mono page is the expensive mistake.
function canPlaceColorAd(pageColor) {
  return pageColor === true;
}

module.exports = {
  BROADSHEET_FC_BY_SECTION_SIZE,
  TAB_FC_BY_PAGE_COUNT,
  PRESS_FORMAT_BY_PAGE_FORMAT,
  parseFolio,
  isColorPageNum,
  isColorFolio,
  broadsheetSectionSize,
  isColorPage,
  colorForEditionPage,
  canPlaceColorAd,
};
