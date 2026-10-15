// Small formatting and ordering helpers shared by the views and features.

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function minutesLeft(expiresAt, now = Date.now()) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 60000));
}

// A1 < A2 < A10 < B1. Plain string order puts A10 before A2.
function folioParts(f) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(f || ''));
  return m ? [m[1].toUpperCase(), Number(m[2])] : [String(f || ''), 0];
}
function compareFolio(a, b) {
  const [la, na] = folioParts(a);
  const [lb, nb] = folioParts(b);
  return la < lb ? -1 : la > lb ? 1 : na - nb;
}

// Budget stories carry page assignments as both 'A1' and 'A-1'.
function normalizeFolio(pa) {
  if (!pa) return null;
  return String(pa).replace(/[-\s]/g, '').toUpperCase();
}

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function isoFrom(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// "Sat, Oct 17, 2026"
function fmtDate(iso) {
  const p = parseISO(iso);
  if (!p) return '';
  const dt = new Date(p.y, p.m, p.d);
  return `${WEEKDAYS_ABBR[dt.getDay()]}, ${MONTHS_ABBR[p.m]} ${p.d}, ${p.y}`;
}
// "Sat, Oct 17"
function fmtDateShort(iso) {
  const p = parseISO(iso);
  if (!p) return '';
  const dt = new Date(p.y, p.m, p.d);
  return `${WEEKDAYS_ABBR[dt.getDay()]}, ${MONTHS_ABBR[p.m]} ${p.d}`;
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// "wv_EXT_101726_A6.indd" — must match cloudPageTempName in indesign.js.
function pageFileName(editionId, folio) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `wv_${safe(editionId)}_${safe(folio)}.indd`;
}

module.exports = {
  MONTHS_LONG, MONTHS_ABBR, WEEKDAYS_ABBR, DOW_LETTERS,
  plural, minutesLeft, compareFolio, normalizeFolio,
  todayISO, parseISO, isoFrom, fmtDate, fmtDateShort, wordCount, pageFileName,
};
