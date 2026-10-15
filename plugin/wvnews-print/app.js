// WVNews Print — panel entry point and composition root.
//
// This file wires the panel together and nothing else. The work lives in:
//
//   ui/        html templating, the store, the renderer, the action runner,
//              event delegation, formatting
//   features/  what each tab does — session, editions, pages, budget,
//              marketplace, navigation
//   views/     what each tab looks like, as pure functions of state
//
// Only THIS file require()s local modules. Everything under ui/, features/ and
// views/ receives its dependencies as arguments, so module resolution happens
// from one place — the plugin root — however the UXP release resolves paths.
//
// The rules that keep the panel from freezing, each the answer to a bug that
// shipped in the version this replaced:
//
//   1. State changes go through store.set(); nothing calls render() directly.
//   2. Every user action goes through run(), which owns busy state and always
//      clears it. (A publish that succeeded once latched every button off.)
//   3. Events are delegated from #root; markup names its action. Nothing is
//      bound to an element that may not be on screen. (A null binding once
//      threw and took the whole panel down.)
//   4. Paints are batched, deferred while a mouse button is down, and keep
//      scroll position and focus. (A 4-second repaint ate clicks.)
//   5. Background work never runs during a user action and only repaints when
//      something changed.

// ── Polyfills ─────────────────────────────────────────────────────────
// UXP 8 exposes crypto.subtle but not TextEncoder/TextDecoder, which auth.js
// needs for PKCE. Defined before anything that uses them is required.
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(str) {
      const s = String(str);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
        else {
          i++;
          const cp = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        }
      }
      return new Uint8Array(out);
    }
  };
}
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(buf) {
      const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < a.length;) {
        const b = a[i++];
        if (b < 0x80) s += String.fromCharCode(b);
        else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (a[i++] & 0x3f));
        else if (b < 0xf0) { const b2 = a[i++], b3 = a[i++]; s += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)); }
        else {
          const b2 = a[i++], b3 = a[i++], b4 = a[i++];
          const cp = (((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)) - 0x10000;
          s += String.fromCharCode(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
        }
      }
      return s;
    }
  };
}

// ── Modules ───────────────────────────────────────────────────────────
const { CONFIG } = require('./config.js');
const auth = require('./auth.js');
const api = require('./api.js');
const id = require('./indesign.js');
const colorPlacement = require('./color-placement.js');

const h = require('./ui/html.js');
const fmt = require('./ui/format.js');
const { createStore } = require('./ui/store.js');
const { createRenderer } = require('./ui/renderer.js');
const { createActions, fail } = require('./ui/actions.js');
const { createEvents } = require('./ui/events.js');
const { createThemeWatcher } = require('./ui/theme.js');

const { createSession } = require('./features/session.js');
const { createEditions, foliosOf, previewEditionId } = require('./features/editions.js');
const { createPages } = require('./features/pages.js');
const { createBudget, SITE_TO_PUB_PROFILE } = require('./features/budget.js');
const { createMarketplace } = require('./features/marketplace.js');
const { createNavigation } = require('./features/navigation.js');

const { createCommon } = require('./views/common.js');
const { createShell } = require('./views/shell.js');
const { createPagesView } = require('./views/pages.js');
const { createBudgetView } = require('./views/budget.js');
const { createMarketplaceView } = require('./views/marketplace.js');
const { createSetupView } = require('./views/setup.js');
const { createOverlays } = require('./views/overlays.js');

// ── State that outlives a panel reload ────────────────────────────────
// Checkouts, the edition you were in, the pending jump and your preferences
// live on the global, so reloading the panel puts you back where you were.
const persist = (globalThis.__wvnewsPlugin = globalThis.__wvnewsPlugin || {});
if (!persist.checkouts && persist.activeCheckout) {
  // Panels from before multi-page checkout kept a single record.
  const c = persist.activeCheckout;
  persist.checkouts = { [`${c.editionId}::${c.folio}`]: c };
}
// Timers from a previous instance of this file, if the context survived.
for (const k of ['heartbeatTimer', 'sweepTimer', 'verifyTimer', 'clockTimer', 'themeTimer']) {
  if (persist[k]) { clearInterval(persist[k]); persist[k] = null; }
}

const store = createStore({
  booting: true,
  user: null,
  signInCode: '',
  sites: [],
  sitesLoading: false,
  siteId: '',

  view: persist.lastView || 'pages',
  edition: null,
  editions: [],
  editionsLoading: false,
  editionsLoadedFor: null,
  snippets: [],
  snippetsById: {},
  form: null,
  datePicker: null,

  pageFiles: {},
  pageFilesLoading: false,
  pageFilesLoaded: false,
  checkouts: persist.checkouts || {},
  autoCheckin: persist.autoCheckin !== false,
  confirmBuild: false,
  openDocs: [],
  frontFolio: '',
  sweepWarned: null,

  budget: null,
  storyId: null,
  blockId: persist.blockId || '4col_story_1photo_1mug',
  jumpSlug: '',
  pendingJump: persist.pendingJump || null,
  placement: null,

  market: null,
  placedAds: {},

  activity: null,
  message: null,
  detailsOpen: false,
  copied: 0,
  now: Date.now(),
});

// ── Features ──────────────────────────────────────────────────────────
const { run } = createActions({ store });
const host = {
  openExternal: (url) => require('uxp').shell.openExternal(url),
  hostname: () => {
    try { return require('os').hostname() || ''; } catch { return ''; }
  },
};
const ctx = { store, run, fail, api, auth, id, fmt, persist, host, colorPlacement };
ctx.session = createSession(ctx);
ctx.editions = createEditions(ctx);
ctx.pages = createPages(ctx);
ctx.budget = createBudget(ctx);
ctx.marketplace = createMarketplace(ctx);
ctx.nav = createNavigation(ctx);

// ── Views ─────────────────────────────────────────────────────────────
const ui = createCommon(h);
const viewDeps = { ...h, fmt, ui, foliosOf, previewEditionId };
const views = {
  pages: createPagesView(viewDeps),
  budget: createBudgetView(viewDeps),
  marketplace: createMarketplaceView(viewDeps),
  setup: createSetupView(viewDeps),
  overlays: createOverlays(viewDeps),
};
const meta = {
  server: String(CONFIG.SERVER_BASE || '').replace(/^https?:\/\//, ''),
  // The manifest's version, as UXP reports it. A hard-coded fallback would
  // go stale at the next release, so without one the footer shows none.
  version: (() => {
    try { return require('uxp').versions.plugin || ''; } catch { return ''; }
  })(),
};
const shell = createShell({ ...viewDeps, views, meta });

// What the views may ask beyond raw state. Pure reads — no InDesign calls.
function derived(s) {
  return {
    heldFor: ctx.pages.heldFor,
    pagesWithStories: ctx.budget.pagesWithStories,
    isPlaced: ctx.budget.isPlaced,
    profile: s.edition ? SITE_TO_PUB_PROFILE[s.edition.siteId] || null : null,
    blockIds: id.STORY_BLOCK_IDS || [],
  };
}

// ── Rendering ─────────────────────────────────────────────────────────
const root = document.getElementById('root');
const renderer = createRenderer({
  root,
  render: () => h.render(shell.render(store.state, derived(store.state))),
  onError: (err) => console.error('[wvnews-print] render failed:', err),
});
store.subscribe(() => renderer.schedule());

// ── Events ────────────────────────────────────────────────────────────
// Every action the markup can name. A name missing here logs a warning
// instead of throwing, and an element not on screen cannot send one.
const P = ctx.pages, B = ctx.budget, M = ctx.marketplace, E = ctx.editions, N = ctx.nav, S = ctx.session;
createEvents({
  root,
  handlers: {
    click: {
      noop: () => {},
      // session
      openSignIn: () => S.openSignIn(),
      finishSignIn: () => S.finishSignIn(),
      signOut: () => S.signOut(),
      // navigation and messages
      setView: (v) => N.setView(v),
      goSetup: () => N.setView('setup'),
      dismissMessage: () => N.dismissMessage(),
      toggleDetails: () => N.toggleDetails(),
      copyMessage: () => N.copyMessage(),
      // editions and the plan
      changeEdition: () => E.change(),
      selectEdition: (editionId) => E.select(editionId),
      loadEditions: () => E.load(),
      newEdition: () => E.openNew(),
      editPlan: () => E.openEdit(),
      cancelForm: () => E.cancelForm(),
      addSection: () => E.addSection(),
      removeSection: (i) => E.removeSection(i),
      submitForm: () => E.submitForm(),
      // date picker
      openDate: () => N.openDate(),
      shiftMonth: (d) => N.shiftMonth(Number(d)),
      toggleYears: () => N.toggleYears(),
      pickDay: (iso) => N.pickDay(iso),
      pickYear: (y) => N.pickYear(y),
      cancelDate: () => N.cancelDate(),
      confirmDate: () => N.confirmDate(),
      // pages
      refreshPages: () => P.refreshFiles(),
      openPage: (folio) => P.open(folio),
      showPage: (folio) => P.show(folio),
      checkin: (folio) => P.checkin(folio),
      checkinAll: () => P.checkinAll(),
      rebuildPage: (folio) => P.rebuild(folio),
      buildPages: () => P.requestBuild(),
      confirmBuild: () => P.build(),
      cancelBuild: () => P.cancelBuild(),
      refreshPlacedAds: () => P.refreshPlacedAds(),
      // budget
      loadBudget: () => B.load(),
      paginate: (folio) => B.paginate(folio),
      openStory: (storyId) => B.selectStory(storyId),
      closeStory: () => B.back(),
      placeTemplate: (templateId) => B.placeTemplate(templateId),
      placePackage: () => B.placePackage(),
      placeBlock: () => B.placeBlock(),
      flowAll: () => B.flowAll(),
      flowField: (kind) => B.flowField(kind),
      placePhoto: () => B.placePhoto(),
      captureJump: () => B.captureJump(),
      completeJump: () => B.completeJump(),
      cancelJump: () => B.cancelJump(),
      // marketplace
      loadMarket: () => M.load(),
      placeLiners: (kind) => M.placeLiners(kind),
      updateHeaders: () => M.updateHeaders(),
      placeAd: (adId) => M.placeAd(adId),
      publishPage: () => M.publishPage(),
    },
    change: {
      setPublication: (value) => E.setPublication(value),
      setFormPublication: (value) => E.setFormPublication(value),
      assignSnippet: (value, folio) => E.assignSnippet(value, folio),
      commitSections: () => E.commitSections(),
      setBlock: (value) => B.setBlock(value),
      setAutoCheckin: (value) => P.setAutoCheckin(value),
    },
    input: {
      setSignInCode: (value) => S.setSignInCode(value),
      setJumpSlug: (value) => B.setJumpSlug(value),
      typeSectionLetter: (value, i) => E.typeSectionLetter(value, i),
      typeSectionCount: (value, i) => E.typeSectionCount(value, i),
    },
  },
});

// ── Boot ──────────────────────────────────────────────────────────────
persist.themeTimer = createThemeWatcher({
  root: document.documentElement,
  readBrightness: () => (id.uiBrightness ? id.uiBrightness() : null),
  matchMedia: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? (q) => window.matchMedia(q) : null,
  isBusy: () => !!store.state.activity,
}).start();
renderer.paintNow();
B.startVerifier();
// Minutes left on a lock tick down while the Pages tab is showing.
persist.clockTimer = setInterval(() => {
  if (store.state.view === 'pages' && store.state.edition) store.set({ now: Date.now() });
}, 60 * 1000);

S.boot().catch((err) => {
  console.error('[wvnews-print] boot failed:', err);
  store.set({ booting: false, message: { kind: 'error', text: `The panel could not start: ${err.message}` } });
});

console.log('[wvnews-print] panel ready');
