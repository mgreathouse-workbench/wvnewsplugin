// Runs the real panel in Chrome.
//
// app.js is evaluated unchanged with a CommonJS require() that resolves
// local modules from plugin/wvnews-print/ and substitutes the fakes in
// fixtures.js for the four things a browser does not have: uxp, InDesign,
// the website API and sign-in.
//
// Query string:
//   theme=dark|mediumdark|mediumlight|light   InDesign's colour theme
//   scheme=none                         a release where no colour-scheme query
//                                       matches, so the panel falls back to…
//   brightness=0..1                     …InDesign's brightness preference
//   signedOut=1                         start at the sign-in screen
//   persist=<json>                      seed the state that survives reloads

(async function () {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  if (params.get('signedOut')) window.__fake.signedIn = false;
  if (params.get('brightness') != null) window.__brightness = Number(params.get('brightness'));
  globalThis.__wvnewsPlugin = params.get('persist') ? JSON.parse(params.get('persist')) : {};

  // The colour scheme InDesign reports for each theme. Chrome knows only
  // "dark" and "light", so the stylesheet's queries are resolved here: the
  // reported scheme's become always-true, every other one never-true. The
  // panel's own matchMedia() calls get the same answers.
  const SCHEME = { dark: 'darkest', mediumdark: 'dark', mediumlight: 'light', light: 'lightest' };
  const scheme = params.get('scheme') === 'none' ? null : SCHEME[theme];
  const resolve = (value) => (value === scheme ? '(min-width: 0px)' : '(max-width: 0px)');
  const css = await (await fetch('/plugin/wvnews-print/styles.css')).text();
  document.getElementById('panel-styles').textContent =
    css.replace(/\(prefers-color-scheme:\s*(\w+)\)/g, (_, value) => resolve(value));
  const realMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    const m = /prefers-color-scheme:\s*(\w+)/.exec(q);
    return m ? { matches: m[1] === scheme, media: q } : realMatchMedia(q);
  };

  const BASE = '/plugin/wvnews-print/';
  const files = await (await fetch('/__files')).json();
  const sources = {};
  await Promise.all(files.map(async (f) => { sources[f] = await (await fetch(BASE + f)).text(); }));
  // The version UXP would report is the manifest's.
  window.__fakeUxp.versions.plugin = (await (await fetch(`${BASE}manifest.json`)).json()).version;

  const stubs = {
    uxp: window.__fakeUxp,
    os: { hostname: () => 'preview-mac' },
    './auth.js': window.__fakeAuth,
    './api.js': window.__fakeApi,
    './indesign.js': window.__fakeId,
  };
  const cache = {};
  function require(name) {
    if (stubs[name]) return stubs[name];
    const key = String(name).replace(/^\.\//, '');
    if (cache[key]) return cache[key].exports;
    if (!(key in sources)) throw new Error(`harness: no module "${name}"`);
    const module = { exports: {} };
    cache[key] = module;
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', `${sources[key]}\n//# sourceURL=${BASE}${key}`)(module, module.exports, require);
    // Test access to the one store, so the smoke tests can tell when the
    // panel is idle instead of guessing with sleeps. Harness-only; the panel
    // itself exposes nothing.
    if (key === 'ui/store.js') {
      const real = module.exports.createStore;
      module.exports = { ...module.exports, createStore: (init) => (window.__store = real(init)) };
    }
    return module.exports;
  }

  try {
    // eslint-disable-next-line no-new-func
    new Function('require', `${sources['app.js']}\n//# sourceURL=${BASE}app.js`)(require);
    window.__harnessReady = true;
  } catch (err) {
    window.__harnessError = String(err && (err.stack || err.message));
    document.body.insertAdjacentHTML('afterbegin', `<pre style="color:red">${window.__harnessError}</pre>`);
  }
}());
