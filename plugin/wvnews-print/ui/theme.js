// Which of InDesign's colour themes the panel is drawn for.
//
// The stylesheet switches its colours with the prefers-color-scheme media
// query — darkest, dark, light, lightest — because InDesign, unlike other
// Adobe apps, does not hand a UXP panel its theme as --uxp-host-* variables.
// InDesign does honour the media query. This is the fallback for a release
// where none of its values match: read InDesign's own brightness preference
// and name the family on <html data-ui="dark|light">, which the stylesheet
// answers. Whenever a colour-scheme query does match, the attribute is
// removed and the media queries, which know all four themes, decide.
//
// Checked again on an interval so a theme change in Preferences follows
// without reloading the panel. It only writes when the answer changes.

const SCHEMES = ['darkest', 'dark', 'light', 'lightest'];

function createThemeWatcher({ root, readBrightness, matchMedia, isBusy = () => false, intervalMs = 3000, timers = globalThis }) {
  // Start from what is actually on the page: a panel reloaded in a context
  // that survived may still carry the previous instance's attribute.
  let current = null;
  try { current = root.getAttribute('data-ui') || null; } catch { /* no attribute API */ }

  function schemeMatches() {
    if (typeof matchMedia !== 'function') return false;
    try { return SCHEMES.some((v) => !!matchMedia(`(prefers-color-scheme: ${v})`).matches); }
    catch { return false; }
  }

  // InDesign's interface brightness runs from 0 (Dark) to 1 (Light); the two
  // medium themes sit either side of the middle.
  function family() {
    if (schemeMatches()) return null;
    let b = null;
    try { b = readBrightness(); } catch { return null; }
    if (typeof b !== 'number' || Number.isNaN(b)) return null;
    return b <= 0.5 ? 'dark' : 'light';
  }

  function apply() {
    const next = family();
    if (next === current) return current;
    current = next;
    try {
      if (next) root.setAttribute('data-ui', next);
      else root.removeAttribute('data-ui');
    } catch { /* nothing to theme */ }
    return current;
  }

  function start() {
    apply();
    return timers.setInterval(() => { if (!isBusy()) apply(); }, intervalMs);
  }

  return { apply, start, current: () => current };
}

module.exports = { createThemeWatcher, SCHEMES };
