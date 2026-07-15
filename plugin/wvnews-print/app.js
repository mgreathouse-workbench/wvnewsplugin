// Top-level UI controller for the WVNews Print panel.
// Vanilla DOM, no React — keeps install free of a build step.

// TextEncoder / TextDecoder polyfill. UXP 8 doesn't expose these
// globally even though crypto.subtle does. Define them before any
// module that uses them is required.
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(str) {
      const s = String(str);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) {
          out.push(0xc0 | (c >> 6));
          out.push(0x80 | (c & 0x3f));
        } else if (c < 0xd800 || c >= 0xe000) {
          out.push(0xe0 | (c >> 12));
          out.push(0x80 | ((c >> 6) & 0x3f));
          out.push(0x80 | (c & 0x3f));
        } else {
          i++;
          const c2 = s.charCodeAt(i);
          const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
          out.push(0xf0 | (cp >> 18));
          out.push(0x80 | ((cp >> 12) & 0x3f));
          out.push(0x80 | ((cp >> 6) & 0x3f));
          out.push(0x80 | (cp & 0x3f));
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
        else if (b < 0xe0) {
          const b2 = a[i++];
          s += String.fromCharCode(((b & 0x1f) << 6) | (b2 & 0x3f));
        } else if (b < 0xf0) {
          const b2 = a[i++], b3 = a[i++];
          s += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
        } else {
          const b2 = a[i++], b3 = a[i++], b4 = a[i++];
          const cp = (((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)) - 0x10000;
          s += String.fromCharCode(0xd800 | (cp >> 10));
          s += String.fromCharCode(0xdc00 | (cp & 0x3ff));
        }
      }
      return s;
    }
  };
}

const { CONFIG } = require('./config.js');
const { beginAuthorize, exchangeCode, getAccessToken, signOut } = require('./auth.js');
const {
  fetchBudget, fetchSites, recordPlacement, deletePlacement, publishAds,
  listEditions, getEdition, listSnippets, updateEditionStatus,
  listEditionPages, checkoutPage, heartbeatPage, checkinPage, fetchPageBinary,
  fetchMarketplace, fetchSectionHeaders,
} = require('./api.js');
const {
  placeTemplate, flowIntoSelectedFrame, placePhotoInSelection, placeMarketplaceBlock,
  updateSectionHeaders,
  flowFullStoryIntoLabelledFrames, threadAndJump,
  captureSourceForJump, completeJumpToFrame,
  placeStoryIntoSelectedFrame,
  placeAndBindStoryBlock,
  autoPaginatePage,
  STORY_BLOCK_IDS,
  verifyPlacedAssets,
  buildEditionPages,
  activeDocument, activePageLabel,
  placeAdSized, placedAdOrderIdsOnActivePage, activeDocPageCount,
  openDownloadedPage, createBlankPage, findOpenDocByTempPath, saveAndReadPageBytes, closePageDoc,
} = require('./indesign.js');
const { isColorPage } = require('./color-placement.js');

// Heartbeat cadence. Server lock TTL is 90 minutes — beat well inside
// that so a network blip doesn't time a real designer out.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

// Map siteId → layout-config folder under assets/layouts/.
// Only ET is wired up so far; tabloid + SJ pubs will be added once
// their layout configs and template assets land.
const SITE_TO_PUB_PROFILE = {
  // The sites feed returns canonical ids (`exponent-telegram`); keep the
  // legacy `exponent`/`theet` slugs mapped too so auto-pagination resolves
  // regardless of which tag reaches the plugin.
  'exponent-telegram': 'exponent-daily',
  exponent: 'exponent-daily',
  theet: 'exponent-daily',
  // For weekend ET we'd switch to 'exponent-weekend' based on day-of-week.
};

// Normalize a story's pageAssignment into a folio matching our layout
// config filenames. Budget feed uses both 'A1' and 'A-1' historically.
function normalizeFolio(pa) {
  if (!pa) return null;
  return String(pa).replace(/[-\s]/g, '').toUpperCase();
}

// Cross-doc pending-jump state. Persisted on globalThis so a UXP
// hot-reload doesn't drop it while the operator is mid-flow.
const G = globalThis;
G.__wvnewsPlugin ||= {};
function getPending() { return G.__wvnewsPlugin.pendingJump || null; }
function setPending(p) { G.__wvnewsPlugin.pendingJump = p; }
function clearPending() { delete G.__wvnewsPlugin.pendingJump; }


console.log('[wvnews-print] app.js loaded — controller starting');

const state = {
  user: null,           // { email }
  sites: [],            // [{ id, name }] — fetched from /api/print/sites
  sitesLoading: false,
  siteId: '',
  editionDate: todayISO(),
  datePickerOpen: false,   // calendar modal open/closed (UXP has no native date popup)
  datePickerView: null,    // { y, m } month currently shown in the calendar (m 0-based)
  datePickerPending: null, // tentatively-selected date; committed only on OK
  datePickerMode: 'days',  // 'days' | 'years' — what the dialog body shows
  datePickerTarget: 'main',// which field the open picker drives: 'main' | 'pubform'
  budget: null,         // server response
  selectedAssetId: null,
  busy: false,
  error: '',
  info: '',
  // Live placement-verification state. Populated by verifyPlacedAssets()
  // — we scan open documents for frames stamped with `wvnews-asset-id`
  // labels. If a budget asset is recorded as "placed" but its document
  // is open and no stamped frame is found, we treat it as deleted-off-
  // the-page and render it as unplaced.
  activePlacedIds: new Set(),   // asset IDs currently found in any open doc
  openDocNames: new Set(),      // names of all currently open documents
  placementChecked: false,      // has at least one verification run completed?
  // Persisted Dead Drop slug — render() rebuilds innerHTML so the
  // <input> would lose its value on every heartbeat tick if we didn't
  // mirror it here.
  jumpSlug: '',
  // Persisted block-size selection for the new Story Block placer.
  // Defaults to a sane mid-size block.
  selectedBlockId: '4col_story_1photo_1mug',

  // ── Edition-creation feature (Steps 10–11) ────────────────────
  // The panel toggles between two top-level views: the existing
  // budget+placement flow ('budget') and the new edition-build flow
  // ('editions'). See PUBLICATION-CREATION-SPEC.md.
  view: 'budget',                  // 'budget' | 'editions' | 'marketplace'

  // Marketplace tab: available classifieds / legals / obits / ads for the
  // selected publication, pulled on demand and placed into a frame.
  marketplace: null,               // { loading, classifieds, legals, obits, ads }
  placedAds: {},                   // orderId → page label, this session (UI feedback)
  adsEditionId: '',                // editionId of the currently-loaded ads feed
  editionFormat: 'broadsheet',     // for Full-Color folio gating (ET is broadsheet)

  // Editions inner view: list of editions, the create/edit form,
  // or the detail (post-create) screen.
  pubView: 'list',                 // 'list' | 'form' | 'detail'
  editions: [],                // results of listEditions()
  editionsLoading: false,
  selectedEditionId: null,
  selectedEdition: null,       // full plan once loaded
  snippets: [],                    // results of listSnippets(siteId)
  snippetsById: {},                // lookup: snippetId → { id, name, ... }

  // Create/edit form state. `mode` decides POST vs PATCH on submit.
  // Empty pubForm = no form open; non-null = form is rendered.
  pubForm: null,                   // see openPubForm() for shape

  // ── Cloud check-out / check-in (Step 1, plugin side) ──────────────
  // Per-folio page-file rows for the currently-selected edition. Keyed
  // by folio. Refreshed when an edition is loaded + after each
  // check-out / check-in. Mirrors the server payload from
  // /api/print/editions/<id>/pages.
  editionPages: {},                // { 'A1': { folio, lock, currentVersion, ... }, ... }
  editionPagesLoading: false,

  // The one page the designer is editing locally. Persisted on
  // globalThis so a UDT hot-reload while a page is open doesn't drop
  // it — paired with the heartbeat timer below.
  // Shape: { editionId, folio, tempPath, fileName, lock }
  activeCheckout: G.__wvnewsPlugin.activeCheckout || null,
};

// Heartbeat timer handle. Stored off-state so render() doesn't try to
// re-render every tick.
G.__wvnewsPlugin.heartbeatTimer ||= null;

const $ = (id) => document.getElementById(id);
const main = () => $('main');

// ── Lifecycle ──────────────────────────────────────────────────────

async function init() {
  const token = await getAccessToken().catch(() => null);
  if (token) {
    state.user = { email: '…' };
    await loadSites();
  }
  render();
}

async function loadSites() {
  state.sitesLoading = true;
  try {
    const { sites } = await fetchSites();
    state.sites = sites || [];
    if (!state.siteId && state.sites.length) state.siteId = state.sites[0].id;
  } catch (err) {
    state.error = `Could not load publications: ${err.message}`;
  } finally {
    state.sitesLoading = false;
  }
}
init().catch(err => {
  state.error = String(err.message || err);
  render();
});

// ── Render dispatch ─────────────────────────────────────────────────

function render() {
  renderHeader();
  if (!state.user) renderSignIn();
  else renderMain();
}

function renderHeader() {
  $('user-chip').textContent = state.user ? `Signed in` : 'Not signed in';
  $('footer-text').textContent = `WVNews Print · ${CONFIG.SERVER_BASE.replace(/^https?:\/\//, '')}`;
}

function renderSignIn() {
  main().innerHTML = `
    <div class="signin-card">
      <h2>Sign in to WVNews</h2>
      <p>Click the button to open your browser, sign in with Google, then paste the code you receive into the panel.</p>
      <button class="primary" id="btn-open">Open sign-in page</button>
      <div style="margin-top:14px;text-align:left;">
        <label class="field">
          <span class="lbl">Code from browser</span>
          <input type="text" id="code-input" placeholder="paste here" />
        </label>
        <button class="primary" id="btn-exchange">Finish sign in</button>
      </div>
      <div class="alert alert-error" id="signin-error" style="${state.error ? '' : 'display:none'}">${state.error || ''}</div>
    </div>
  `;
  $('btn-open').onclick = onOpenAuthorize;
  $('btn-exchange').onclick = onExchangeCode;
}

async function onOpenAuthorize() {
  state.error = '';
  try {
    const url = await beginAuthorize();
    // Don't log the full authorize URL — it contains the PKCE
    // code_challenge and state, and DevTools logs bleed via screenshots,
    // copy-paste, and support sessions. Log only the host portion as a
    // breadcrumb for "did the browser launch land somewhere reasonable."
    try {
      const u = new URL(url);
      console.log('[wvnews-print] authorize: opening', u.origin + u.pathname);
    } catch {
      console.log('[wvnews-print] authorize: opening browser');
    }
    const { shell } = require('uxp');
    await shell.openExternal(url);
    state.info = 'Browser opened. Copy the code shown on the page and paste it below.';
  } catch (err) {
    console.error('[wvnews-print] onOpenAuthorize failed:', err);
    const msg = (err && err.message) || (err && err.toString && err.toString())
      || (typeof err === 'string' ? err : 'unknown error — see DevTools console');
    state.error = `Could not open browser: ${msg}`;
  }
  render();
}

async function onExchangeCode() {
  const code = $('code-input').value.trim();
  if (!code) { state.error = 'Paste the code first.'; render(); return; }
  state.busy = true; state.error = ''; render();
  try {
    await exchangeCode(code);
    state.user = { email: 'signed in' };
    await loadSites();
    if (state.siteId) await refreshBudget();
  } catch (err) {
    state.error = `Sign-in failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

// ── Main panel ──────────────────────────────────────────────────────

function renderMain() {
  const sel = state.budget?.assets.find(a => a.id === state.selectedAssetId);
  const siteOptions = state.sites.length
    ? state.sites.map(s => `<option value="${s.id}" ${s.id === state.siteId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')
    : `<option value="">${state.sitesLoading ? 'Loading…' : 'No publications available'}</option>`;
  main().innerHTML = `
    <div class="row" style="margin-bottom:8px;">
      <label class="field" style="margin:0;">
        <span class="lbl">Publication</span>
        <select id="site-sel">
          ${siteOptions}
        </select>
      </label>
      <label class="field" style="margin:0;">
        <span class="lbl">Edition</span>
        ${renderDatePicker()}
      </label>
    </div>
    <div class="row" style="margin-bottom:8px;">
      <button class="primary" id="btn-load" ${!state.siteId ? 'disabled' : ''}>${state.budget ? 'Refresh' : 'Load budget'}</button>
      ${!state.sites.length && !state.sitesLoading
        ? '<button class="secondary" id="btn-reload-sites">Reload pubs</button>' : ''}
      <button class="ghost" id="btn-signout">Sign out</button>
    </div>
    ${state.error  ? `<div class="alert alert-error">${state.error}</div>`   : ''}
    ${state.info   ? `<div class="alert alert-info">${state.info}</div>`     : ''}
    ${state.busy   ? `<div class="empty"><span class="spinner"></span> Working…</div>` : ''}

    <div class="row" style="margin:6px 0 8px;border-bottom:1px solid #d4d4d4;">
      <button class="ghost" data-view="budget"       style="font-weight:${state.view === 'budget' ? '700' : '400'};border-bottom:${state.view === 'budget' ? '2px solid #1b5e20' : '2px solid transparent'};border-radius:0;">Budget</button>
      <button class="ghost" data-view="editions" style="font-weight:${state.view === 'editions' ? '700' : '400'};border-bottom:${state.view === 'editions' ? '2px solid #1b5e20' : '2px solid transparent'};border-radius:0;">Editions</button>
      <button class="ghost" data-view="marketplace" style="font-weight:${state.view === 'marketplace' ? '700' : '400'};border-bottom:${state.view === 'marketplace' ? '2px solid #1b5e20' : '2px solid transparent'};border-radius:0;">Marketplace</button>
    </div>

    ${state.view === 'editions'
      ? renderEditionsView()
      : state.view === 'marketplace'
      ? renderMarketplaceView()
      : `${state.budget ? renderBudgetList() : '<div class="empty">Pick a publication and edition, then click Load budget.</div>'}
         ${sel ? renderDetail(sel) : ''}`
    }
  `;
  for (const el of document.querySelectorAll('[data-view]')) {
    el.onclick = () => {
      const v = el.getAttribute('data-view');
      if (state.view === v) return;
      state.view = v;
      state.error = ''; state.info = '';
      state.selectedEditionId = null;
      state.selectedEdition = null;
      render();
      if (v === 'editions') refreshEditions();
      if (v === 'marketplace') refreshMarketplace();
    };
  }
  // Marketplace tab: refresh counts + per-kind place buttons.
  const btnMktRefresh = $('btn-mkt-refresh');
  if (btnMktRefresh) btnMktRefresh.onclick = () => refreshMarketplace();
  const btnSyncHdr = $('btn-mkt-synchdr');
  if (btnSyncHdr) btnSyncHdr.onclick = () => onUpdateSectionHeaders();
  for (const el of document.querySelectorAll('[data-mkt-place]')) {
    el.onclick = () => onPlaceMarketplace(el.getAttribute('data-mkt-place'));
  }
  // Display ads: per-item Place + Publish Page.
  for (const el of document.querySelectorAll('[data-ad-place]')) {
    el.onclick = () => onPlaceAd(el.getAttribute('data-ad-place'));
  }
  const btnAdPublish = $('btn-ad-publish');
  if (btnAdPublish) btnAdPublish.onclick = () => onPublishPage();
  // Editions view: row clicks drill into an edition; the "back"
  // button in the detail view returns to the list.
  for (const el of document.querySelectorAll('[data-pub-id]')) {
    el.onclick = () => {
      state.pubView = 'detail';
      selectEdition(el.getAttribute('data-pub-id'));
    };
  }
  // Per-folio Check out / Check in buttons inside the Edition detail view.
  for (const el of document.querySelectorAll('[data-folio-checkout]')) {
    el.onclick = () => onCheckoutPage(el.getAttribute('data-folio-checkout'));
  }
  for (const el of document.querySelectorAll('[data-folio-checkin]')) {
    el.onclick = () => onCheckinActiveCheckout();
  }
  // Top banner Check in button + refresh-locks button.
  const btnActiveCheckin = $('btn-active-checkin');
  if (btnActiveCheckin) btnActiveCheckin.onclick = () => onCheckinActiveCheckout();
  const btnRefreshLocks = $('btn-refresh-locks');
  if (btnRefreshLocks) btnRefreshLocks.onclick = () => {
    const eid = state.activeCheckout?.editionId || state.selectedEditionId;
    if (eid) refreshEditionPages(eid);
  };
  const btnPubBack = $('btn-pub-back');
  if (btnPubBack) {
    btnPubBack.onclick = () => {
      state.selectedEditionId = null;
      state.selectedEdition = null;
      state.pubView = 'list';
      state.confirmRebuild = false;
      state.error = '';
      render();
    };
  }
  // Create + edit form
  const btnPubNew = $('btn-pub-new');
  if (btnPubNew) btnPubNew.onclick = () => openPubForm(null);
  const btnPubRefresh = $('btn-pub-refresh');
  if (btnPubRefresh) btnPubRefresh.onclick = () => refreshEditions();
  const btnPubEdit = $('btn-pub-edit');
  if (btnPubEdit) btnPubEdit.onclick = () => openPubForm(state.selectedEdition);
  const btnPubBuild = $('btn-pub-build');
  if (btnPubBuild) btnPubBuild.onclick = onBuildEdition;
  const btnPubCancel = $('btn-pub-cancel');
  if (btnPubCancel) btnPubCancel.onclick = closePubForm;
  const btnPubSubmit = $('btn-pubform-submit');
  if (btnPubSubmit) btnPubSubmit.onclick = submitPubForm;
  // Pub + date inputs — mirror into state so heartbeat re-renders don't blow them away.
  const pubSite = $('pubform-site');
  if (pubSite) pubSite.onchange = () => {
    state.pubForm.siteId = pubSite.value;
    // If site changed and form has no custom sections yet, pre-fill from defaultSections.
    const site = state.sites.find(s => s.id === pubSite.value);
    if (site?.defaultSections?.length && state.pubForm.sections.length === 1 && state.pubForm.sections[0].pageCount === 1) {
      state.pubForm.sections = site.defaultSections.map(s => ({ letter: s.letter, pageCount: s.pageCount }));
    }
    // Reload snippets filtered to this site, then re-render.
    listSnippets({ siteId: pubSite.value || undefined })
      .then(r => {
        state.snippets = r?.snippets || [];
        state.snippetsById = Object.fromEntries(state.snippets.map(s => [s.id, s]));
        render();
      })
      .catch(() => render());
  };
  // The create-edition date uses the shared calendar picker (target
  // 'pubform'); bindDatePicker() wires it, and committing a date triggers a
  // full re-render that refreshes the id-preview line below it.
  // Section editor
  const btnAddSec = $('btn-pubform-addsec');
  if (btnAddSec) btnAddSec.onclick = () => {
    const last = state.pubForm.sections.length
      ? state.pubForm.sections[state.pubForm.sections.length - 1].letter
      : '@';
    const next = String.fromCharCode(last.charCodeAt(0) + 1);
    if (next > 'Z') return;
    state.pubForm.sections.push({ letter: next, pageCount: 4 });
    render();
  };
  for (const el of document.querySelectorAll('.pubform-sec-letter')) {
    el.oninput = () => {
      const i = Number(el.getAttribute('data-idx'));
      const v = String(el.value || '').toUpperCase().slice(0, 1);
      if (state.pubForm?.sections[i]) state.pubForm.sections[i].letter = v;
    };
  }
  for (const el of document.querySelectorAll('.pubform-sec-count')) {
    el.oninput = () => {
      const i = Number(el.getAttribute('data-idx'));
      const v = Math.max(1, Math.min(200, Number(el.value) || 1));
      if (state.pubForm?.sections[i]) state.pubForm.sections[i].pageCount = v;
    };
    // Re-render on blur so the page grid below updates.
    el.onblur = () => render();
  }
  for (const el of document.querySelectorAll('.pubform-sec-remove')) {
    el.onclick = () => {
      const i = Number(el.getAttribute('data-idx'));
      state.pubForm.sections.splice(i, 1);
      render();
    };
  }
  // Per-page snippet assignment
  for (const el of document.querySelectorAll('.pubform-assign')) {
    el.onchange = () => {
      const folio = el.getAttribute('data-folio');
      if (state.pubForm) state.pubForm.assignments[folio] = el.value || '';
    };
  }
  $('site-sel').onchange = (e) => { state.siteId = e.target.value; render(); };
  bindDatePicker();
  $('btn-load').onclick = () => refreshBudget();
  const btnReloadSites = $('btn-reload-sites');
  if (btnReloadSites) btnReloadSites.onclick = async () => { await loadSites(); render(); };
  $('btn-signout').onclick = async () => {
    await signOut();
    state.user = null; state.budget = null; state.sites = []; state.siteId = '';
    render();
  };

  // Story-row clicks
  for (const el of document.querySelectorAll('[data-asset-id]')) {
    el.onclick = () => { state.selectedAssetId = el.getAttribute('data-asset-id'); render(); };
  }
  // Template-place clicks (only present when a story is selected)
  for (const el of document.querySelectorAll('[data-template-id]')) {
    el.onclick = () => onPlaceTemplate(el.getAttribute('data-template-id'));
  }
  for (const el of document.querySelectorAll('[data-flow-kind]')) {
    el.onclick = () => onFlowSelected(el.getAttribute('data-flow-kind'));
  }
  const btnPlace = $('btn-place-story'); if (btnPlace) btnPlace.onclick = onPlaceStoryInFrame;
  const btnAll = $('btn-flow-all'); if (btnAll) btnAll.onclick = onFlowFullStory;
  const btnPhoto = $('btn-photo'); if (btnPhoto) btnPhoto.onclick = onPlacePhoto;
  const blockSelect = $('story-block-select');
  if (blockSelect) {
    blockSelect.onchange = () => { state.selectedBlockId = blockSelect.value; };
  }
  const btnPlaceBlock = $('btn-place-block');
  if (btnPlaceBlock) btnPlaceBlock.onclick = onPlaceStoryBlock;
  for (const el of document.querySelectorAll('[data-autopage]')) {
    el.onclick = () => onAutoPaginatePage(el.getAttribute('data-autopage'));
  }
  const btnJumpCap = $('btn-jump-capture');
  const inputSlug = $('jump-slug');
  if (btnJumpCap && inputSlug) {
    btnJumpCap.onclick = onCaptureSource;
    // Mirror keystrokes into state so the 4s heartbeat render doesn't
    // blow away the value, and keep the capture button's enabled state
    // in sync with the persisted value.
    inputSlug.oninput = () => {
      state.jumpSlug = inputSlug.value;
      btnJumpCap.disabled = !inputSlug.value.trim();
    };
    btnJumpCap.disabled = !(state.jumpSlug || '').trim();
    // Only auto-focus the first time we see the field — re-focusing
    // every render would yank the cursor out of any other field the
    // user might be typing in.
    if (!state.jumpSlugFocused) {
      inputSlug.focus();
      state.jumpSlugFocused = true;
    }
  }
  const btnJumpDrop = $('btn-jump-complete'); if (btnJumpDrop) btnJumpDrop.onclick = onCompleteJump;
  const btnJumpCancel = $('btn-jump-cancel'); if (btnJumpCancel) btnJumpCancel.onclick = () => {
    clearPending(); state.info = 'Pending jump cancelled.'; render();
  };
}

function renderBudgetList() {
  const assets = state.budget.assets;
  if (!assets.length) {
    return `<div class="empty">No stories in this budget yet.</div>`;
  }

  // Group stories by their normalized page assignment so we can show
  // an Auto-paginate button per page that has stories.
  const byPage = {};
  for (const a of assets) {
    const f = normalizeFolio(a.pageAssignment);
    if (!f) continue;
    (byPage[f] ||= []).push(a);
  }
  const pubProfile = SITE_TO_PUB_PROFILE[state.siteId] || null;

  // Render an auto-paginate strip per page (sorted A1, A2, ... B1, B2 ...).
  const pageOrder = Object.keys(byPage).sort();
  const autoStrip = pubProfile
    ? pageOrder.map(folio => `
        <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #eee;">
          <span style="flex:1;font-size:11px;"><b>${folio}</b> · ${byPage[folio].length} ${byPage[folio].length === 1 ? 'story' : 'stories'}</span>
          <button class="primary" data-autopage="${folio}" style="font-size:10px;padding:2px 8px;">
            Auto-paginate
          </button>
        </div>
      `).join('')
    : `<div style="font-size:10px;color:#a04040;padding:4px;">No layout config for siteId="${state.siteId}". Add an entry in SITE_TO_PUB_PROFILE.</div>`;

  return `
    <div style="margin-bottom:8px;padding:6px;background:#f5f6f8;border-radius:4px;">
      <div style="font-size:10px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">
        Auto-pagination
      </div>
      ${autoStrip || '<div style="font-size:10px;color:#6b6b6b;">No pages assigned yet — add pageAssignment to budget stories.</div>'}
    </div>
    <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;">${assets.length} ${assets.length === 1 ? 'story' : 'stories'}</div>
    ${assets.map(a => {
      const placedNow = isAssetActivelyPlaced(a);
      const placementStale = a.placement && !placedNow;
      return `
      <div class="story ${placedNow ? 'placed' : ''} ${a.id === state.selectedAssetId ? 'selected' : ''}" data-asset-id="${a.id}">
        <div class="story-headline">${escapeHtml(a.headline || '(untitled)')}</div>
        <div class="story-meta">
          ${a.pageAssignment ? `<span class="tag">${a.pageAssignment}</span>` : ''}
          ${placedNow ? `<span class="tag placed">placed</span>` : ''}
          ${placementStale ? `<span class="tag removed" title="Placement was recorded but the frames are no longer on the page">removed from page</span>` : ''}
          <span>${escapeHtml(a.byline || '')}</span>
          ${a.printOnly ? ' · print-only' : ''}
        </div>
      </div>`;
    }).join('')}
  `;
}

// ── Editions view: list / form / detail dispatch ──────────────────

// ── Marketplace view: pull + place classifieds / legals / obits ───
function renderMarketplaceView() {
  if (!state.siteId) {
    return '<div class="empty">Pick a publication above to load its classifieds, legals, and obituaries.</div>';
  }
  const m = state.marketplace;
  if (!m || m.loading) {
    return '<div class="empty"><span class="spinner"></span> Loading marketplace…</div>';
  }
  const row = (kind, label) => {
    const n = ((m[kind] && m[kind].items) || []).length;
    return `
      <div class="story" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <div class="story-headline">${label}</div>
          <div class="story-meta">${n} available${m.date ? ` · ${escapeHtml(m.date)}` : ''}</div>
        </div>
        <button class="primary" data-mkt-place="${kind}" ${n && !state.busy ? '' : 'disabled'}>Place</button>
      </div>`;
  };
  return `
    <div class="row" style="margin-bottom:8px;align-items:center;justify-content:space-between;">
      <div style="font-size:11px;color:#6b6b6b;">Select a text frame in InDesign, then click Place.</div>
      <button class="secondary" id="btn-mkt-refresh">↻ Refresh</button>
    </div>
    ${row('classifieds', 'Classifieds')}
    <div class="row" style="margin:-2px 0 8px;justify-content:flex-end;">
      <button class="secondary" id="btn-mkt-synchdr" ${state.busy ? 'disabled' : ''}
        title="After reshaping the classified columns, select a frame in the section and click to move the category banners to each column's new top.">
        ⟳ Update Section Headers</button>
    </div>
    ${row('legals', 'Legals')}
    ${row('obits', 'Obituaries')}
    ${renderAdsSection(m)}
  `;
}

// Display ads are image placements (not text blocks), so they get their own
// per-item list with individual Place buttons + a Publish Page action.
function renderAdsSection(m) {
  const ads = (m.ads && m.ads.items) || [];
  const placed = state.placedAds || {};
  const items = ads.map(a => {
    const isPlaced = placed[String(a.id)];
    const color = a.colorRequired ? ' <span style="color:#c026d3;font-size:9px;font-weight:700;">● COLOR</span>' : '';
    const dims = (a.widthIn && a.heightIn) ? `${a.widthIn}×${a.heightIn}in` : '';
    return `
      <div class="story" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <div class="story-headline">${escapeHtml(a.advertiser || 'Display ad')}${color}</div>
          <div class="story-meta">${escapeHtml(a.sizeCode || '')}${dims ? ' · ' + dims : ''}${isPlaced ? ` · <span style="color:#2563eb;">placed ${escapeHtml(isPlaced)}</span>` : ''}</div>
        </div>
        <button class="primary" data-ad-place="${escapeHtml(String(a.id))}" ${state.busy ? 'disabled' : ''}>Place</button>
      </div>`;
  }).join('');
  return `
    <div class="story-headline" style="margin-top:10px;">Display Ads <span class="story-meta">(${ads.length})</span></div>
    ${ads.length ? items : '<div class="story-meta" style="padding:2px 0 6px;">No scheduled ads with artwork for this edition.</div>'}
    <div class="row" style="margin:2px 0 8px;justify-content:flex-end;">
      <button class="secondary" id="btn-ad-publish" ${state.busy ? 'disabled' : ''}
        title="Flip every placed ad on the active InDesign page to Published.">✓ Publish Page</button>
    </div>`;
}

async function refreshMarketplace() {
  if (!state.siteId) { state.marketplace = null; render(); return; }
  state.marketplace = { loading: true, date: state.editionDate || '' };
  state.error = ''; render();
  try {
    const [classifieds, legals, obits, ads] = await Promise.all([
      fetchMarketplace(state.siteId, 'classifieds', state.editionDate),
      fetchMarketplace(state.siteId, 'legals', state.editionDate),
      fetchMarketplace(state.siteId, 'obits', state.editionDate),
      // Ads require an edition date (the feed 400s without one); tolerate that
      // and any error so a missing date never breaks the whole marketplace.
      state.editionDate
        ? fetchMarketplace(state.siteId, 'ads', state.editionDate).catch(() => ({ count: 0, items: [] }))
        : Promise.resolve({ count: 0, items: [] }),
    ]);
    // Every ad item carries its editionId (all the same for this edition) —
    // stash it for Publish Page.
    state.adsEditionId = ((ads.items[0] || {}).editionId) || '';
    state.marketplace = { loading: false, date: state.editionDate || '', classifieds, legals, obits, ads };
  } catch (err) {
    state.marketplace = { loading: false, date: state.editionDate || '' };
    state.error = `Could not load marketplace: ${err.message}`;
  } finally {
    render();
  }
}

async function onPlaceMarketplace(kind) {
  const bucket = state.marketplace && state.marketplace[kind];
  const items = (bucket && bucket.items) || [];
  if (!items.length) { state.error = `No ${kind} available to place.`; render(); return; }
  state.error = ''; state.info = ''; state.busy = true; render();
  try {
    // Classifieds get section-header graphics keyed by category. Fetch the
    // available headers (non-fatal — falls back to text headers on failure).
    let headerUrls = null;
    if (kind === 'classifieds') {
      try {
        const sh = await fetchSectionHeaders();
        headerUrls = {};
        for (const h of (sh && sh.headers) || []) headerUrls[h.slug] = h.url;
      } catch (e) {
        console.warn('[wvnews-print] section headers unavailable:', e?.message || e);
      }
    }
    const res = await placeMarketplaceBlock(kind, items, null, headerUrls);
    state.info = `Placed ${res.placed} ${kind} into ${res.frame || 'the selected frame'}.`;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false; render();
  }
}

// Place ONE display ad's print-ready artwork on the active page, sized to its
// real dimensions, color-gated, and recorded (which flips it scheduled→placed
// server-side).
async function onPlaceAd(adId) {
  const bucket = state.marketplace && state.marketplace.ads;
  const asset = ((bucket && bucket.items) || []).find(a => String(a.id) === String(adId));
  if (!asset) { state.error = 'Ad not found — refresh the marketplace.'; render(); return; }
  state.error = ''; state.info = ''; state.busy = true; render();
  try {
    // Color gate: a color-required ad may only drop on a Full-Color folio.
    const folio = activePageLabel();
    const verdict = isColorPage({
      format: state.editionFormat || 'broadsheet',
      totalPages: activeDocPageCount(),
      folio,
    });
    if (asset.colorRequired && verdict && verdict.color === false) {
      throw new Error(`${asset.advertiser || 'This ad'} needs full color, but ${folio || 'this page'} prints black & white. Move to a color page and try again.`);
    }
    const res = await placeAdSized(asset);
    // Record the placement — drives the server scheduled→placed side-effect.
    await recordPlacement({
      assetId: asset.id,
      siteId: state.siteId,
      editionDate: state.editionDate,
      // Record the order's assigned newspaper folio (e.g. "A3") first — the
      // InDesign active-page NAME (res.page/folio, e.g. "1") is not a folio.
      pageAssignment: asset.pageAssignment || res.page || folio || 'A1',
      documentName: '',
      frameLabel: res.frameLabel,
      status: 'placed',
    });
    state.placedAds = state.placedAds || {};
    state.placedAds[String(asset.id)] = res.page || folio || '';
    const warn = (asset.colorRequired && verdict && verdict.color === null)
      ? ' (⚠ could not confirm this is a color page)' : '';
    state.info = `Placed ${asset.advertiser || 'ad'}${asset.sizeCode ? ' (' + asset.sizeCode + ')' : ''} on ${res.page}.${warn}`;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false; render();
  }
}

// Publish every placed ad on the active page/spread — flips those insertions
// scheduled/placed → published for this edition.
async function onPublishPage() {
  const editionId = state.adsEditionId;
  if (!editionId) { state.error = 'Load the Ads marketplace for this edition first.'; render(); return; }
  state.error = ''; state.info = ''; state.busy = true; render();
  try {
    const orderIds = placedAdOrderIdsOnActivePage();
    if (!orderIds.length) throw new Error('No placed ads on the active page to publish.');
    const r = await publishAds({ editionId, orderIds });
    const pub = ((r && r.published) || []).length;
    const skip = ((r && r.skipped) || []).length;
    const errs = ((r && r.errors) || []).length;
    state.info = `Published ${pub} ad${pub === 1 ? '' : 's'}${skip ? `, ${skip} already published` : ''}${errs ? `, ${errs} failed` : ''}.`;
    // Published ads leave the feed — refresh to reflect it.
    await refreshMarketplace();
  } catch (err) {
    state.error = err.message;
    state.busy = false; render();
  }
}

// Re-sync classified column headers to the CURRENT column layout — the
// artist reshapes columns, selects a frame in the section, clicks this.
async function onUpdateSectionHeaders() {
  state.error = ''; state.info = ''; state.busy = true; render();
  try {
    let headerUrls = {};
    try {
      const sh = await fetchSectionHeaders();
      for (const h of (sh && sh.headers) || []) headerUrls[h.slug] = h.url;
    } catch (e) { /* no art → nothing to sync */ }
    const res = await updateSectionHeaders(headerUrls);
    state.info = `Re-synced ${res.placed} column header${res.placed === 1 ? '' : 's'} to the current layout.`;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false; render();
  }
}

function renderEditionsView() {
  if (state.editionsLoading) {
    return '<div class="empty"><span class="spinner"></span> Loading editions…</div>';
  }
  if (state.pubView === 'form' && state.pubForm) {
    return renderEditionForm();
  }
  if (state.pubView === 'detail' && state.selectedEdition) {
    return renderEditionDetail(state.selectedEdition);
  }
  return renderEditionsList();
}

function renderEditionsList() {
  const list = state.editions.filter(p => !state.siteId || p.siteId === state.siteId);
  return `
    <div class="row" style="margin-bottom:8px;">
      <button class="primary" id="btn-pub-new" style="flex:1;">+ New edition</button>
      <button class="secondary" id="btn-pub-refresh" title="Re-fetch editions from the server (e.g. after creating one online)">↻ Refresh</button>
    </div>
    ${!list.length
      ? `<div class="empty">No editions planned${state.siteId ? ` for ${escapeHtml(state.siteId)}` : ''} yet. Click <b>+ New edition</b> above.</div>`
      : `<div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;">${list.length} planned edition${list.length === 1 ? '' : 's'}</div>
         ${list.map(p => {
           const assigned = (p.pages || []).filter(pp => pp.snippetId).length;
           const total = (p.pages || []).length;
           return `
             <div class="story" data-pub-id="${escapeHtml(p.id)}" style="cursor:pointer;">
               <div class="story-headline">${escapeHtml(p.id)}</div>
               <div class="story-meta">
                 <span class="tag">${escapeHtml(p.dayOfWeek || '')}</span>
                 <span>${escapeHtml(p.editionDate)}</span>
                 ${p.status ? `<span class="tag">${escapeHtml(p.status)}</span>` : ''}
                 <span>· ${assigned}/${total} pages assigned</span>
               </div>
             </div>`;
         }).join('')}`
    }
  `;
}

// Compute edition id for the form preview. Mirrors editionId()
// from src/lib/print-editions.js but kept inline so we don't have
// to pull the lib into the plugin bundle.
function previewPubId(siteCode, editionDate) {
  if (!/^[A-Z]{3}$/.test(siteCode || '')) return '—';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(editionDate || '')) return '—';
  const [y, m, d] = editionDate.split('-');
  return `${siteCode}_${m}${d}${y.slice(2)}`;
}
function foliosFromSectionsLocal(sections) {
  const out = [];
  for (const s of sections || []) {
    const n = Number(s.pageCount) || 0;
    for (let i = 1; i <= n; i++) out.push(`${s.letter}${i}`);
  }
  return out;
}

function renderEditionForm() {
  const form = state.pubForm;
  const isEdit = form.mode === 'edit';
  const site = state.sites.find(s => s.id === form.siteId);
  const siteCode = site?.code || '';
  const pubId = isEdit ? form.editingId : previewPubId(siteCode, form.editionDate);
  const folios = foliosFromSectionsLocal(form.sections);
  // Snippets filtered to this site (plus shared null-siteId snippets).
  const eligible = state.snippets.filter(s => !s.siteId || s.siteId === form.siteId);
  const byCat = new Map();
  for (const s of eligible) {
    const cat = s.category || 'other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(s);
  }
  // Build snippet-select HTML for a folio with the right option preselected.
  // UXP's HTML renderer does not honor <optgroup>, so options are flat
  // with category prefixed into the visible label instead.
  const snippetSelect = (folio) => {
    const selectedId = form.assignments[folio] || '';
    const opts = Array.from(byCat.entries()).flatMap(([cat, items]) =>
      items.map(s =>
        `<option value="${escapeHtml(s.id)}"${s.id === selectedId ? ' selected' : ''}>${escapeHtml(cat)} · ${escapeHtml(s.name)}</option>`
      )
    ).join('');
    return `<option value=""${!selectedId ? ' selected' : ''}>— no snippet —</option>${opts}`;
  };

  return `
    <div style="margin-bottom:8px;">
      <button class="ghost" id="btn-pub-cancel">← Cancel</button>
      <span style="float:right;font-size:11px;color:#6b6b6b;">
        ${isEdit ? `Editing ${escapeHtml(form.editingId)}` : `Will create <b>${escapeHtml(pubId)}</b>`}
      </span>
    </div>

    <div style="margin-bottom:10px;padding:8px;background:#f7f7f8;border-radius:4px;">
      <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">
        1. Publication + date
      </div>
      <label class="field" style="margin-bottom:4px;">
        <span class="lbl">Publication</span>
        <select id="pubform-site" ${isEdit ? 'disabled' : ''}>
          <option value="">— pick publication —</option>
          ${state.sites.map(s =>
            `<option value="${escapeHtml(s.id)}" ${s.id === form.siteId ? 'selected' : ''}>${escapeHtml(s.name)}${s.code ? ` (${escapeHtml(s.code)})` : ''}</option>`
          ).join('')}
        </select>
      </label>
      <label class="field" style="margin-bottom:0;">
        <span class="lbl">Edition date</span>
        ${renderDatePicker('pubform', { disabled: isEdit })}
      </label>
      <div id="pubform-idpreview" style="font-size:10px;margin-top:4px;font-family:monospace;color:${siteCode && /^\d{4}-\d{2}-\d{2}$/.test(form.editionDate) ? '#6b6b6b' : '#a04040'};">
        ${siteCode && /^\d{4}-\d{2}-\d{2}$/.test(form.editionDate)
          ? `→ ${escapeHtml(pubId)}`
          : 'Enter the edition date as YYYY-MM-DD'}
      </div>
    </div>

    <div style="margin-bottom:10px;padding:8px;background:#f7f7f8;border-radius:4px;">
      <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">
        2. Sections
      </div>
      <div id="pubform-sections">
        ${form.sections.map((sec, i) => `
          <div class="row" style="margin-bottom:3px;">
            <input type="text" class="pubform-sec-letter" data-idx="${i}" value="${escapeHtml(sec.letter)}" maxlength="1"
              style="width:30px;text-align:center;font-weight:700;text-transform:uppercase;" />
            <span style="font-size:11px;align-self:center;">×</span>
            <input type="number" class="pubform-sec-count" data-idx="${i}" value="${sec.pageCount}" min="1" max="200"
              style="width:60px;" />
            <span style="font-size:11px;align-self:center;color:#6b6b6b;">pages</span>
            ${form.sections.length > 1
              ? `<button class="ghost pubform-sec-remove" data-idx="${i}" style="font-size:10px;color:#a04040;">remove</button>`
              : ''}
          </div>
        `).join('')}
      </div>
      <button class="ghost" id="btn-pubform-addsec" style="font-size:11px;color:#1b5e20;">+ Add section</button>
    </div>

    <div style="margin-bottom:10px;padding:8px;background:#f7f7f8;border-radius:4px;">
      <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">
        3. Snippet per page (${folios.length} page${folios.length === 1 ? '' : 's'})
      </div>
      ${!form.siteId
        ? '<div style="font-size:11px;color:#6b6b6b;">Pick a publication above to see eligible snippets.</div>'
        : !folios.length
          ? '<div style="font-size:11px;color:#6b6b6b;">Add sections above to generate the page grid.</div>'
          : folios.map(folio => `
              <div class="row" style="margin-bottom:2px;">
                <span style="width:34px;font-weight:700;font-size:11px;align-self:center;">${folio}</span>
                <select class="pubform-assign" data-folio="${folio}" style="flex:1;font-size:11px;">
                  ${snippetSelect(folio)}
                </select>
              </div>
            `).join('')
      }
      ${form.siteId && eligible.length === 0
        ? `<div style="font-size:11px;color:#a04040;margin-top:4px;line-height:1.3;">
             No snippets uploaded for this pub yet. Upload .idms files at
             <code>/admin/print-layout/snippets</code> in the web admin, then come back.
           </div>`
        : form.siteId
          ? `<div style="font-size:10px;color:#6b6b6b;margin-top:4px;">${eligible.length} eligible snippet${eligible.length === 1 ? '' : 's'} for this pub</div>`
          : ''}
    </div>

    ${form.error ? `<div class="alert alert-error">${escapeHtml(form.error)}</div>` : ''}

    <div class="row" style="margin-top:6px;">
      <button class="primary" id="btn-pubform-submit" style="flex:1;" ${form.busy ? 'disabled' : ''}>
        ${form.busy ? 'Saving…' : (isEdit ? 'Save changes' : `Create ${pubId !== '—' ? pubId : 'edition'}`)}
      </button>
    </div>
  `;
}

// Top-of-detail banner shown only when this edition has an active
// check-out by the current user. Surfaces the folio, time left on the
// lock, and a prominent Check in button. The same lock is also shown
// in-row below; this banner is the "fast action" path so the designer
// doesn't have to scroll a 20-page list to check in.
function renderActiveCheckoutBanner(pub) {
  const co = state.activeCheckout;
  if (!co || co.editionId !== pub.id) return '';
  const left = minutesLeft(co.lock?.expiresAt);
  return `
    <div style="margin:6px 0;padding:6px 8px;border-radius:4px;background:#e6f4ea;border:1px solid #a8d5b8;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="font-size:11px;color:#0a4a1c;">
          <b>${escapeHtml(co.folio)}</b> checked out · ${left}m left
        </div>
        <button class="primary" id="btn-active-checkin" style="font-size:11px;padding:3px 8px;" ${state.busy ? 'disabled' : ''}>
          Check in
        </button>
      </div>
      <div style="font-size:9px;color:#0a4a1c;margin-top:2px;">
        Save in InDesign (Cmd-S) before checking in — Check in reads the saved file.
      </div>
    </div>`;
}

function renderEditionDetail(pub) {
  const pages = pub.pages || [];
  return `
    <div style="margin-bottom:8px;">
      <button class="ghost" id="btn-pub-back">← Editions</button>
    </div>
    <div style="margin-bottom:8px;">
      <div style="font-weight:700;font-size:14px;">${escapeHtml(pub.id)}</div>
      <div style="font-size:11px;color:#6b6b6b;">
        ${escapeHtml(pub.dayOfWeek || '')} ${escapeHtml(pub.editionDate)} ·
        ${(pub.sections || []).map(s => `${s.letter}1–${s.letter}${s.pageCount}`).join(', ')} ·
        <span class="tag">${escapeHtml(pub.status || 'planned')}</span>
      </div>
    </div>
    ${renderActiveCheckoutBanner(pub)}
    <div style="margin-top:6px;padding-top:6px;border-top:1px solid #d4d4d4;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:11px;color:#6b6b6b;">Pages (${pages.length})${state.editionPagesLoading ? ' · loading locks…' : ''}</span>
      </div>
      ${pages.map(p => {
        const snip = p.snippetId ? state.snippetsById[p.snippetId] : null;
        const snipLabel = snip ? snip.name : (p.snippetId ? '(snippet not in library)' : '— no snippet —');
        const snipClass = snip ? '' : 'style="color:#a04040;"';
        const pf = state.editionPages[p.folio];
        const lock = pf?.lock;
        const youHold = !!(lock && state.activeCheckout?.folio === p.folio);
        // Lock state badge string
        let lockText, lockColor;
        if (!pf) { lockText = '–'; lockColor = '#a0a0a0'; }
        else if (lock && !lock.expired && youHold) { lockText = `you · ${minutesLeft(lock.expiresAt)}m`; lockColor = '#0a6e2c'; }
        else if (lock && !lock.expired) { lockText = `${lock.displayName || 'someone'} · ${minutesLeft(lock.expiresAt)}m`; lockColor = '#a06000'; }
        else if (lock && lock.expired) { lockText = 'stale'; lockColor = '#888'; }
        else { lockText = pf.currentVersion > 0 ? `v${pf.currentVersion}` : 'no binary'; lockColor = '#0a6e2c'; }
        // Per-row action button
        let actionBtn;
        if (youHold) {
          actionBtn = `<button class="primary" data-folio-checkin="${escapeHtml(p.folio)}" style="font-size:10px;padding:2px 6px;">Check in</button>`;
        } else if (lock && !lock.expired) {
          actionBtn = `<span style="font-size:10px;color:#888;">locked</span>`;
        } else {
          actionBtn = `<button class="secondary" data-folio-checkout="${escapeHtml(p.folio)}" style="font-size:10px;padding:2px 6px;" ${state.busy ? 'disabled' : ''}>Check out</button>`;
        }
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:2px 0;">
            <div style="width:32px;font-weight:700;">${escapeHtml(p.folio)}</div>
            <div style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" ${snipClass}>${escapeHtml(snipLabel)}</div>
            <div style="font-size:10px;color:${lockColor};font-family:monospace;white-space:nowrap;">${escapeHtml(lockText)}</div>
            ${actionBtn}
          </div>`;
      }).join('')}
    </div>
    <div style="margin-top:10px;padding-top:6px;border-top:1px solid #d4d4d4;">
      ${pub.status !== 'built' ? `
        <div class="row" style="margin-bottom:6px;">
          <button class="secondary" id="btn-pub-edit" style="flex:1;">Edit plan</button>
        </div>
      ` : `
        <div style="font-size:10px;color:#6b6b6b;margin-bottom:6px;line-height:1.3;">
          Pages have been built. Edit individual <code>.indd</code> files in InDesign directly —
          the plan in the platform is frozen.
        </div>
      `}
      <button class="primary" id="btn-pub-build" style="width:100%;" ${state.busy ? 'disabled' : ''}>
        ${pub.status === 'built' ? 'Rebuild Pages' : 'Build Pages'}
      </button>
      <div style="font-size:10px;color:#6b6b6b;margin-top:3px;line-height:1.3;">
        Builds each page (<b>${pages.length}</b>) from the pub template + its
        assigned snippet and <b>checks it in to the website</b> as a new version.
        Each build bumps the page's version in the cloud — no local files.
      </div>
      ${state.buildProgress ? `
        <div style="font-size:10px;color:#1b5e20;margin-top:4px;font-family:monospace;">
          ${escapeHtml(state.buildProgress)}
        </div>` : ''}
    </div>
  `;
}

function renderDetail(a) {
  const templates = state.budget.templates || [];
  return `
    <div class="detail">
      <h3>${escapeHtml(a.headline)}</h3>
      <div class="byline">${escapeHtml(a.byline || '')}${a.dateline ? ' · ' + escapeHtml(a.dateline) : ''}</div>
      ${a.photo?.url ? `<img class="photo-thumb" src="${a.photo.url}" alt="${escapeHtml(a.photo.alt || '')}" />` : ''}
      <div class="stats">${(a.bodyText || '').split(/\s+/).filter(Boolean).length} words</div>

      <div style="margin-bottom:6px;font-weight:600;">Place from template</div>
      <div class="template-list">
        ${templates.length
          ? templates.map(t => `
              <div class="template-row" data-template-id="${t.id}">
                <span>${escapeHtml(t.label)}</span>
                <span class="kind">${t.kind}</span>
              </div>
            `).join('')
          : '<div class="muted">No templates configured. Add some at /admin/print-layout/templates.</div>'
        }
      </div>

      <div style="margin-top:8px;">
        <button class="primary" id="btn-place-story" style="width:100%;">Build story package in selected bounds</button>
        <div style="font-size:10px;color:#6b6b6b;margin-top:3px;">
          Draw a text frame marking out where the whole story should sit on
          the page (Type tool T → drag), select it (Selection tool V → click),
          then click this. Plugin replaces it with labelled sub-frames
          (headline / deck / byline / photo / caption / body), places the
          photo, and applies paragraph styles per region.
        </div>
      </div>

      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #d4d4d4;">
        <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;">
          Place from designed Story Block (post-TownNews path)
        </div>
        <label class="field" style="margin-bottom:4px;">
          <span class="lbl">Block size</span>
          <select id="story-block-select" style="width:100%;">
            ${STORY_BLOCK_IDS.map(b => `<option value="${b}" ${b === state.selectedBlockId ? 'selected' : ''}>${b}</option>`).join('')}
          </select>
        </label>
        <button class="primary" id="btn-place-block" style="width:100%;">
          Place block + bind story data
        </button>
        <div style="font-size:10px;color:#6b6b6b;margin-top:3px;line-height:1.3;">
          Places the chosen Story Block snippet from the bundled assets,
          then replaces placeholder text (<code>print_headline</code>,
          <code>nameline</code>, <code>caption</code>, <code>main story</code>, etc.)
          with this story's data. Paragraph styles already in the snippet
          (HD HDB Head Bold / BCJ Body Copy Justified / IMN Image Mugshot Name)
          are preserved.
        </div>
      </div>

      <div style="margin-top:8px;">
        <button class="secondary" id="btn-flow-all" style="width:100%;">Place into labelled frames (multi-frame layout)</button>
        <div style="font-size:10px;color:#6b6b6b;margin-top:3px;">
          Uses Script Labels (<code>headlineFrame</code>, <code>bodyFrame</code>,
          <code>photoFrame</code>, etc.) for layouts that put each field in its
          own frame. Or label a single frame <code>storyFrame</code> for the
          Blox combined-stream mode.
        </div>
      </div>

      <div style="margin-top:8px;font-size:11px;color:#6b6b6b;">Or flow one field at a time:</div>
      <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">
        <button class="secondary" data-flow-kind="headline">Headline</button>
        ${a.deck ? `<button class="secondary" data-flow-kind="deck">Deck</button>` : ''}
        ${a.byline ? `<button class="secondary" data-flow-kind="byline">Byline</button>` : ''}
        ${a.dateline ? `<button class="secondary" data-flow-kind="dateline">Dateline</button>` : ''}
        <button class="secondary" data-flow-kind="body">Body</button>
        ${a.photo?.url ? `<button class="secondary" id="btn-photo">Place photo</button>` : ''}
      </div>

      ${renderDeadDropSection(a)}
    </div>
  `;
}

function renderDeadDropSection(a) {
  const pending = getPending();
  if (pending) {
    return `
      <div style="margin-top:12px;padding-top:8px;border-top:1px solid #d4d4d4;">
        <div class="alert alert-info" style="margin:0 0 6px;">
          Pending jump: <b>${escapeHtml(pending.slug)}</b> captured from
          <b>${escapeHtml(pending.sourceDocName)}</b> · page <b>${escapeHtml(pending.sourcePage)}</b>
          (${pending.overflowChars} chars to drop)
        </div>
        <div style="display:flex;gap:4px;">
          <button class="primary" id="btn-jump-complete" style="flex:1;">
            Drop into selected frame
          </button>
          <button class="ghost" id="btn-jump-cancel">Cancel</button>
        </div>
        <div style="font-size:10px;color:#6b6b6b;margin-top:3px;line-height:1.3;">
          Select the destination body frame on the jump page and click
          Drop. The keyword (e.g. <code>COUNCIL</code>) and
          <code>(Continued from Page A1)</code> are prepended INSIDE
          the body frame as the first two paragraphs; the overflow
          body follows. Source's turnline placeholder is patched with
          the destination page label.
        </div>
      </div>
    `;
  }
  return `
    <div style="margin-top:12px;padding-top:8px;border-top:1px solid #d4d4d4;">
      <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;">
        Dead Drop — capture source for cross-document jump
      </div>
      <label class="field" style="margin-bottom:4px;">
        <span class="lbl">Jump caption</span>
        <input type="text" id="jump-slug" value="${escapeHtml(state.jumpSlug || '')}" placeholder="e.g. CENTER, TAX, CANVASS"
               style="text-transform:uppercase;font-family:monospace;" />
      </label>
      <button class="primary" id="btn-jump-capture" style="width:100%;" disabled>
        Dead Drop (capture)
      </button>
      <div style="font-size:10px;color:#6b6b6b;margin-top:3px;line-height:1.3;">
        Select the overflowing body frame and click Dead Drop. The
        plugin truncates the body to its visible content and appends
        <code>See SLUG, [DESTPAGE]</code> as the new last paragraph
        — no separate turnline frame. The placeholder is patched
        during the destination drop.
      </div>
    </div>
  `;
}

// ── Actions ─────────────────────────────────────────────────────────

async function refreshBudget() {
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    state.budget = await fetchBudget(state.siteId, state.editionDate);
    if (!state.budget.assets.some(a => a.id === state.selectedAssetId)) {
      state.selectedAssetId = null;
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false;
    render();
  }
  // Right after refreshing the budget, verify what's actually still on
  // the page so the "placed" badges reflect reality.
  refreshPlacementState();
}

// Load the list of planned editions + the snippet library so the
// Editions view can render. Both are pulled together so the
// detail view can resolve snippetId → human name.
async function refreshEditions() {
  state.editionsLoading = true; state.error = ''; render();
  try {
    const [pubResp, snipResp] = await Promise.all([
      listEditions({ siteId: state.siteId || undefined }),
      listSnippets({ siteId: state.siteId || undefined }),
    ]);
    state.editions = pubResp?.editions || [];
    state.snippets = snipResp?.snippets || [];
    state.snippetsById = Object.fromEntries(state.snippets.map(s => [s.id, s]));
  } catch (err) {
    state.error = `Could not load editions: ${err.message}`;
  } finally {
    state.editionsLoading = false;
    render();
  }
}

// Drill into one edition: fetch the full plan (which includes
// freshly resolved snippet metadata + signed URLs) and render the
// detail view.
async function selectEdition(id) {
  state.editionsLoading = true; state.error = ''; render();
  try {
    const resp = await getEdition(id);
    state.selectedEditionId = id;
    state.selectedEdition = resp?.edition || null;
    // Cloud page-files live in a sibling collection; load alongside.
    // Fire-and-forget — the inline edition view renders without them
    // and updates when the promise resolves.
    refreshEditionPages(id).catch(() => { /* surfaced via state.error */ });
  } catch (err) {
    state.error = `Could not load edition ${id}: ${err.message}`;
    state.selectedEdition = null;
    state.selectedEditionId = null;
  } finally {
    state.editionsLoading = false;
    state.confirmRebuild = false;   // fresh edition → clear any pending rebuild confirm
    render();
  }
}

// ── Cloud check-out / check-in ─────────────────────────────────────

async function refreshEditionPages(editionId) {
  if (!editionId) return;
  state.editionPagesLoading = true; render();
  try {
    const rows = await listEditionPages(editionId);
    state.editionPages = Object.fromEntries(rows.map(r => [r.folio, r]));
  } catch (err) {
    state.error = `Could not load page locks: ${err.message}`;
  } finally {
    state.editionPagesLoading = false;
    render();
  }
}

function startHeartbeat() {
  stopHeartbeat();
  G.__wvnewsPlugin.heartbeatTimer = setInterval(async () => {
    const co = state.activeCheckout;
    if (!co) { stopHeartbeat(); return; }
    try {
      const r = await heartbeatPage({ editionId: co.editionId, folio: co.folio });
      if (r?.page?.lock) {
        state.activeCheckout = { ...co, lock: r.page.lock };
        G.__wvnewsPlugin.activeCheckout = state.activeCheckout;
        // Also keep editionPages in sync so the row badge moves
        state.editionPages = { ...state.editionPages, [co.folio]: r.page };
        render();
      }
    } catch (err) {
      // 423 means someone broke our lock. Surface + abandon.
      if (err.statusCode === 423 || /423|lock/i.test(err.message)) {
        state.error = `Lock on ${co.folio} was broken: ${err.message}`;
        state.activeCheckout = null;
        G.__wvnewsPlugin.activeCheckout = null;
        stopHeartbeat();
        render();
      }
      // Other errors (network blip) — silent, try again next tick.
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (G.__wvnewsPlugin.heartbeatTimer) {
    clearInterval(G.__wvnewsPlugin.heartbeatTimer);
    G.__wvnewsPlugin.heartbeatTimer = null;
  }
}

// Check out a page: acquire lock → download binary → open in InDesign
// → start heartbeating. Refuses if the designer already has a different
// page checked out (one-at-a-time discipline keeps the temp folder
// clean and prevents accidental "save wrong page" footguns).
async function onCheckoutPage(folio) {
  const pub = state.selectedEdition;
  if (!pub) { state.error = 'No edition selected.'; render(); return; }
  if (state.activeCheckout && state.activeCheckout.folio !== folio) {
    state.error = `Check in ${state.activeCheckout.folio} before opening another page.`;
    render(); return;
  }
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    let hostName = '';
    try { hostName = (require('os').hostname && require('os').hostname()) || ''; }
    catch { /* uxp may not expose os — fine, host is informational */ }

    const co = await checkoutPage({ editionId: pub.id, folio, host: hostName });
    // If the page has no binary yet (currentVersion=0, no .indt template
    // for this pub), open a fresh blank document instead of downloading.
    // First check-in writes v1; from there on every check-out downloads
    // the saved binary like a normal page.
    let opened;
    if (co.downloadUrl) {
      const binary = await fetchPageBinary(co.downloadUrl);
      opened = await openDownloadedPage({
        editionId: pub.id, folio, arrayBuffer: binary,
      });
    } else {
      opened = await createBlankPage({ editionId: pub.id, folio });
      state.info = `${folio} opened blank (no template uploaded yet — your first check-in writes v1).`;
    }
    state.activeCheckout = {
      editionId: pub.id,
      folio,
      tempPath: opened.tempPath,
      fileName: opened.fileName,
      lock: co.page.lock,
    };
    G.__wvnewsPlugin.activeCheckout = state.activeCheckout;
    state.editionPages = { ...state.editionPages, [folio]: co.page };
    state.info = `${folio} checked out — opens in InDesign.`;
    startHeartbeat();
  } catch (err) {
    if (err.statusCode === 423 && err.lock) {
      state.error = `${folio} is checked out by ${err.lock.displayName || 'someone'} (${minutesLeft(err.lock.expiresAt)}m left).`;
    } else {
      state.error = err.message;
    }
  } finally {
    state.busy = false; render();
  }
}

// Save the active doc → read bytes → POST as new version → close doc
// → clear active-checkout state → stop heartbeat.
async function onCheckinActiveCheckout(note = '') {
  const co = state.activeCheckout;
  if (!co) { state.error = 'Nothing checked out.'; render(); return; }
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const doc = findOpenDocByTempPath(co.tempPath) || activeDocument();
    const bytes = await saveAndReadPageBytes({ doc, fileName: co.fileName });
    const result = await checkinPage({
      editionId: co.editionId, folio: co.folio, bytes, note,
    });
    state.editionPages = { ...state.editionPages, [co.folio]: result.page };
    await closePageDoc(doc);
    state.activeCheckout = null;
    G.__wvnewsPlugin.activeCheckout = null;
    stopHeartbeat();
    state.info = `${co.folio} checked in as v${result.page.currentVersion}.`;
  } catch (err) {
    if (err.statusCode === 423) {
      state.error = `Lock on ${co.folio} no longer valid — your save was NOT uploaded. ${err.message}`;
      // Abandon the local checkout state; user has to manually re-acquire.
      state.activeCheckout = null;
      G.__wvnewsPlugin.activeCheckout = null;
      stopHeartbeat();
    } else {
      state.error = err.message;
    }
  } finally {
    state.busy = false; render();
  }
}

function minutesLeft(expiresAt) {
  if (!expiresAt) return 0;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 60000));
}

// Build Pages: create one InDesign .indd per page in the edition's
// build folder, placing each page's assigned snippet. Runs the build in
// indesign.js (no doScript — see placeAndBindStoryBlock) and reports
// per-page progress. On a clean run (no failures) the edition is marked
// `built` on the platform.
async function onBuildEdition() {
  const pub = state.selectedEdition;
  if (!pub) { state.error = 'No edition selected.'; render(); return; }
  const total = (pub.pages || []).length;
  if (!total) { state.error = 'This edition has no pages to build.'; render(); return; }

  // Rebuilding overwrites every .indd in the folder — including manual
  // edits the operator may have made after the first build. Require a
  // second click to confirm.
  if (pub.status === 'built' && !state.confirmRebuild) {
    state.confirmRebuild = true;
    state.error = `${pub.id} was already built. Rebuilding checks in a new version of every page on the website, overwriting any manual edits. Click Rebuild Pages again to confirm.`;
    render();
    return;
  }
  state.confirmRebuild = false;

  state.busy = true; state.error = ''; state.info = ''; state.buildProgress = ''; render();
  const PHASE = { checkout: 'locking page', create: 'opening template', download: 'downloading snippet', place: 'placing', save: 'checking in' };
  try {
    const result = await buildEditionPages(pub, state.snippetsById, (p) => {
      state.buildProgress = `[${p.index + 1}/${p.total}] ${p.folio} — ${PHASE[p.phase] || p.phase}…`;
      render();
    });

    const lines = [`Built ${result.built}/${result.results.length} page${result.results.length === 1 ? '' : 's'} → checked in to the website`];
    for (const r of result.results) {
      lines.push(r.saved
        ? `  ✓ ${r.folio}${r.version ? ` v${r.version}` : ''}${r.placed ? '' : ' (no snippet placed)'}${r.assets && r.assets.placed ? ` + ${r.assets.placed} asset${r.assets.placed === 1 ? '' : 's'}` : ''}${r.assets && r.assets.missed ? ` (${r.assets.missed} asset${r.assets.missed === 1 ? '' : 's'} missing)` : ''}`
        : `  ✗ ${r.folio} — ${r.error || 'failed'}`);
    }
    state.info = lines.join('\n');

    // Mark built on the platform only when every page saved.
    if (result.failed === 0) {
      try {
        await updateEditionStatus(pub.id, 'built');
        state.selectedEdition = { ...pub, status: 'built' };
      } catch (e) {
        state.info += `\n(Pages built, but could not set status=built: ${e.message})`;
      }
    }
  } catch (err) {
    state.error = `Build failed: ${err.message}`;
  } finally {
    state.busy = false;
    state.buildProgress = '';
    render();
  }
}

// Open the create/edit form. If an edition is passed, we go into
// edit mode (PATCH on submit); otherwise create mode (POST).
function openPubForm(initial) {
  const isEdit = !!initial?.id;
  const site = state.sites.find(s => s.id === (initial?.siteId || state.siteId));
  const assignments = {};
  if (initial?.pages) {
    for (const p of initial.pages) assignments[p.folio] = p.snippetId || '';
  }
  state.pubForm = {
    mode: isEdit ? 'edit' : 'create',
    editingId: isEdit ? initial.id : null,
    siteId: initial?.siteId || state.siteId || '',
    editionDate: initial?.editionDate || state.editionDate || '',
    sections: initial?.sections
      ? initial.sections.map(s => ({ letter: s.letter, pageCount: s.pageCount }))
      : (site?.defaultSections
          ? site.defaultSections.map(s => ({ letter: s.letter, pageCount: s.pageCount }))
          : [{ letter: 'A', pageCount: 1 }]),
    assignments,
    busy: false,
    error: '',
  };
  state.pubView = 'form';
  render();

  // Snippets must reflect the form's current pub. The dropdown's
  // onchange handler covers user-initiated picks, but if the form
  // opens with a pre-selected siteId (edit mode, or carried from
  // state.siteId on create) no `change` event fires — so do it here.
  if (state.pubForm.siteId) {
    listSnippets({ siteId: state.pubForm.siteId })
      .then(r => {
        state.snippets = r?.snippets || [];
        state.snippetsById = Object.fromEntries(state.snippets.map(s => [s.id, s]));
        render();
      })
      .catch(() => { /* leave state.snippets as-is */ });
  }
}

function closePubForm() {
  state.pubForm = null;
  state.pubView = 'list';
  render();
}

// POST a new edition or PATCH an existing one. Reads everything
// from state.pubForm so the in-progress edits aren't lost on render.
async function submitPubForm() {
  const form = state.pubForm;
  if (!form) return;
  // UXP's <select> doesn't reliably fire `change`, so read the live site
  // value at submit time. The edition date comes from the calendar picker,
  // which commits straight to form.editionDate on OK — no DOM read needed.
  // (Edit mode disables these, so only sync for create.)
  if (form.mode === 'create') {
    const siteEl = $('pubform-site');
    if (siteEl) form.siteId = siteEl.value;
  }
  const site = state.sites.find(s => s.id === form.siteId);
  if (!form.siteId || !site)         { form.error = 'Pick a publication.'; render(); return; }
  if (!form.editionDate)              { form.error = 'Pick an edition date.'; render(); return; }
  if (!form.sections.length)          { form.error = 'Add at least one section.'; render(); return; }
  if (form.mode === 'create' && !/^[A-Z]{3}$/.test(site.code || '')) {
    form.error = `${site.name} doesn't have a 3-letter site code set yet.`;
    render(); return;
  }

  form.busy = true; form.error = ''; render();
  try {
    const sections = form.sections.map(s => ({
      letter: String(s.letter || '').toUpperCase(),
      pageCount: Number(s.pageCount) || 0,
    }));
    const folios = foliosFromSectionsLocal(sections);
    const pages = folios.map(folio => ({ folio, snippetId: form.assignments[folio] || null }));

    const path = form.mode === 'edit'
      ? `/api/print/editions/${encodeURIComponent(form.editingId)}`
      : '/api/print/editions';
    const method = form.mode === 'edit' ? 'PATCH' : 'POST';
    const body = form.mode === 'edit'
      ? { sections, pages }
      : { siteId: form.siteId, siteCode: site.code, editionDate: form.editionDate, sections, pages };

    const token = await getAccessToken();
    if (!token) throw new Error('Not signed in');
    const res = await fetch(`${CONFIG.SERVER_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

    // Refresh the list so the new/updated edition shows up.
    state.pubForm = null;
    state.pubView = 'list';
    await refreshEditions();
    state.info = form.mode === 'edit'
      ? `Saved changes to ${form.editingId}.`
      : `Created ${data.edition?.id || 'edition'}.`;
  } catch (err) {
    form.error = err.message;
    form.busy = false;
  } finally {
    render();
  }
}

// Ask InDesign which asset IDs are currently visible (via stamped
// `wvnews-asset-id` labels on any pageItem in any open document) and
// update the panel. Safe to call repeatedly — no-ops on error so we
// don't disturb the UI if InDesign is mid-script.
async function refreshPlacementState() {
  try {
    const { docNames = [], assetIds = [] } = await verifyPlacedAssets();
    state.openDocNames = new Set(docNames);
    state.activePlacedIds = new Set(assetIds);
    state.placementChecked = true;
    render();
  } catch (e) {
    // Don't surface — verification is best-effort background work.
    console.warn('[wvnews-print] refreshPlacementState skipped:', e?.message || e);
  }
}

// True when the operator is mid-interaction with a form control. The
// heartbeat's render() replaces the whole panel DOM, which dismisses an
// open <input type="date"> picker (and drops focus on text/number
// fields) — so we skip the tick while a control is focused.
function isEditingInput() {
  try {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = (ae.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'select' || tag === 'textarea';
  } catch { return false; }
}

// Heartbeat: re-verify periodically so the UI catches deletions the
// operator did in InDesign between actions. 4s is slow enough not to
// thrash, fast enough to feel live. Only runs in the Budget view —
// that's the only place placement badges render — so it never re-renders
// (and wrecks the date picker on) the Editions create/edit form.
setInterval(() => {
  if (!state.budget || !state.user) return;
  if (state.view !== 'budget') return;
  if (isEditingInput()) return;
  refreshPlacementState();
}, 4000);

// Return true if the asset's "placed" badge should display, taking
// live verification into account. Rule: if the asset's placement
// records a document name that's currently open AND that asset's ID
// is NOT among the live IDs, treat it as removed. If the placement's
// document isn't open (or we haven't verified yet), trust the server.
function isAssetActivelyPlaced(a) {
  if (!a || !a.placement) return false;
  if (!state.placementChecked) return true; // pre-scan: trust the server
  const docName = a.placement.documentName || '';
  if (docName && state.openDocNames.has(docName)) {
    return state.activePlacedIds.has(a.id);
  }
  // Doc not open — we can't verify; fall back to the server's record.
  return true;
}

async function onPlaceTemplate(templateId) {
  const t = state.budget?.templates?.find(x => x.id === templateId);
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!t || !a) return;
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await placeTemplate(t, a, state.budget.styleMap);
    await recordPlacement({
      assetId: a.id,
      siteId: state.siteId,
      editionDate: state.editionDate,
      pageAssignment: result.page || activePageLabel() || a.pageAssignment || 'A-1',
      documentName: result.documentName,
      frameLabel: (result.framesBound || []).join(','),
      templateId: t.id,
      status: 'placed',
    });
    state.info = `Placed “${a.headline}” via ${t.label}.`;
    await refreshBudget();
  } catch (err) {
    state.error = `Placement failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onFlowSelected(kind = 'body') {
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!a) return;
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await flowIntoSelectedFrame(a, state.budget.styleMap, kind);
    await recordPlacement({
      assetId: a.id,
      siteId: state.siteId,
      editionDate: state.editionDate,
      pageAssignment: result.page || activePageLabel() || a.pageAssignment || 'A-1',
      documentName: result.documentName,
      frameLabel: `${kind}:${(result.framesBound || []).join(',')}`,
      status: 'placed',
    });
    state.info = `Flowed ${kind} of “${a.headline}” into selected frame.`;
    await refreshBudget();
  } catch (err) {
    state.error = `Flow failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onPlaceStoryInFrame() {
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!a) return;
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await placeStoryIntoSelectedFrame(a, state.budget.styleMap);
    await recordPlacement({
      assetId: a.id,
      siteId: state.siteId,
      editionDate: state.editionDate,
      pageAssignment: result.page || activePageLabel() || a.pageAssignment || 'A-1',
      documentName: result.documentName,
      frameLabel: 'story:' + (result.framesBound || []).join(','),
      status: 'placed',
    });
    state.info = `Built story package for "${a.headline}" — ${result.framesBound.length} frames: ${result.framesBound.join(', ')}.`;
    await refreshBudget();
  } catch (err) {
    state.error = `Place story failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onAutoPaginatePage(folio) {
  const pubProfile = SITE_TO_PUB_PROFILE[state.siteId];
  if (!pubProfile) {
    state.error = `No layout config registered for siteId="${state.siteId}".`;
    render(); return;
  }
  const stories = (state.budget?.assets || []).filter(a => normalizeFolio(a.pageAssignment) === folio);
  if (!stories.length) {
    state.error = `No stories assigned to ${folio}.`;
    render(); return;
  }
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await autoPaginatePage(pubProfile, folio, stories);

    // Record each placed story so the placement-tracker reflects reality.
    for (const p of result.placements) {
      if (!p.placed) continue;
      await recordPlacement({
        assetId: p.story.id,
        siteId: state.siteId,
        editionDate: state.editionDate,
        pageAssignment: folio,
        documentName: activeDocument().name,
        frameLabel: `block:${p.position.defaultBlock}@${p.position.id}:${(p.framesBound || []).join(',')}`,
        status: 'placed',
      }).catch(() => { /* best-effort */ });
    }

    const lines = [];
    lines.push(`${result.successCount}/${result.totalStories} placed on ${folio}.`);
    for (const p of result.placements) {
      const mark = p.placed ? '✓' : '✗';
      lines.push(`  ${mark} ${p.weight} → ${p.position.id} (${p.position.defaultBlock}) — "${p.story.headline}"${p.error ? ' — ' + p.error : ''}`);
    }
    for (const u of result.unplaced) {
      lines.push(`  · skipped "${u.story.headline}" — ${u.reason}`);
    }
    if (result.overBudgeted && result.overBudgetMessage) {
      lines.push('');
      lines.push(result.overBudgetMessage);
    }
    state.info = lines.join('\n');
    await refreshBudget();
  } catch (err) {
    state.error = `Auto-paginate failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onPlaceStoryBlock() {
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!a) { state.error = 'Pick a story first.'; render(); return; }
  const blockId = state.selectedBlockId;
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await placeAndBindStoryBlock(blockId, a);
    await recordPlacement({
      assetId: a.id,
      siteId: state.siteId,
      editionDate: state.editionDate,
      pageAssignment: activePageLabel() || a.pageAssignment || 'A-1',
      documentName: activeDocument().name,
      frameLabel: `block:${blockId}:${(result.framesBound || []).join(',')}`,
      status: 'placed',
    });
    state.info = `Placed ${blockId} for "${a.headline}". Bound: ${result.framesBound.join(', ') || '(no placeholders matched)'}.`;
    await refreshBudget();
  } catch (err) {
    state.error = `Place block failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onFlowFullStory() {
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!a) return;
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await flowFullStoryIntoLabelledFrames(a, state.budget.styleMap);
    if (!result.framesBound.length) {
      state.error = 'No labelled frames found on this page. Label your frames via Window → Utilities → Script Label.';
    } else {
      await recordPlacement({
        assetId: a.id,
        siteId: state.siteId,
        editionDate: state.editionDate,
        pageAssignment: result.page || activePageLabel() || a.pageAssignment || 'A-1',
        documentName: result.documentName,
        frameLabel: result.framesBound.join(','),
        status: 'placed',
      });
      state.info = `Placed "${a.headline}" into ${result.framesBound.length} frame${result.framesBound.length === 1 ? '' : 's'}: ${result.framesBound.join(', ')}.`;
      if (result.missing.length) state.info += ` Skipped: ${result.missing.join('; ')}.`;
      await refreshBudget();
    }
  } catch (err) {
    state.error = `Place full story failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onCaptureSource() {
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!a) return;
  // Pull from state first (always up-to-date because oninput mirrors
  // into it). Fall back to the live DOM value just in case state and
  // DOM ever diverge (e.g. user pasted via right-click menu).
  const slug = (state.jumpSlug || $('jump-slug')?.value || '').trim().toUpperCase();
  if (!slug) {
    state.error = 'Type a jump caption first (e.g. CENTER, TAX).';
    render();
    return;
  }
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const captured = await captureSourceForJump(slug, state.budget.styleMap);
    setPending({
      slug: captured.slug,
      sourceDocName: captured.sourceDocName,
      sourcePage: captured.sourcePage,
      overflowText: captured.overflowText,
      overflowChars: captured.overflowChars,
      assetId: a.id,
      headline: a.headline,
      capturedAt: Date.now(),
    });
    const turnNote = captured.turnlinePlaced
      ? 'Turnline appended to body story.'
      : '⚠ turnline NOT appended (see DevTools).';
    state.info = `Captured ${captured.overflowChars} chars from ${captured.sourcePage}. ${turnNote} Open the destination .indd, select the destination body frame, and click Drop.`;
  } catch (err) {
    state.error = `Capture failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onCompleteJump() {
  const pending = getPending();
  if (!pending) { state.error = 'No pending jump.'; render(); return; }
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await completeJumpToFrame(pending, state.budget?.styleMap);
    await recordPlacement({
      assetId: pending.assetId,
      siteId: state.siteId,
      editionDate: state.editionDate,
      pageAssignment: pending.sourcePage,
      documentName: pending.sourceDocName,
      frameLabel: `jump:${pending.slug} → ${result.destDocName}/${result.destPage}`,
      status: 'placed',
    });
    const notes = ['keyword + continued-from prepended to dest body'];
    if (!result.patchedInDoc) notes.push('⚠ source turnline left as [DESTPAGE] — original doc was not open');
    state.info = `Dead drop complete: "${pending.headline}" jumps ${pending.sourceDocName} ${pending.sourcePage} → ${result.destDocName} ${result.destPage} as ${pending.slug}. (${notes.join('; ')})`;
    clearPending();
  } catch (err) {
    state.error = `Drop failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function onPlacePhoto() {
  const a = state.budget?.assets?.find(x => x.id === state.selectedAssetId);
  if (!a || !a.photo) return;
  state.busy = true; state.error = ''; state.info = ''; render();
  try {
    const result = await placePhotoInSelection(a.photo, a);
    await recordPlacement({
      assetId: a.id,
      siteId: state.siteId,
      editionDate: state.editionDate,
      pageAssignment: result.page || activePageLabel() || a.pageAssignment || 'A-1',
      documentName: result.documentName,
      frameLabel: 'photo',
      status: 'placed',
    });
    state.info = `Photo placed for “${a.headline}”.`;
  } catch (err) {
    state.error = `Photo place failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ── Edition calendar picker ─────────────────────────────────────────
// UXP's webview renders <input type="date"> as a plain text box with no
// calendar popup, so we roll our own. It's a centered modal dialog
// (Material-style: header + month grid of circular days + year picker +
// Cancel/OK) — a modal instead of an anchored popover so it never clips
// against the narrow panel. Fully state-driven (datePickerOpen / View /
// Pending / Mode) so the 4s heartbeat re-render can't disturb it. Day
// clicks update a PENDING date; it commits to editionDate only on OK.

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function isoFrom(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function viewFromISO(iso) {
  const p = parseISO(iso) || parseISO(todayISO());
  return { y: p.y, m: p.m };
}
function fmtHuman(iso) {
  const p = parseISO(iso);
  if (!p) return 'Pick a date';
  const dt = new Date(p.y, p.m, p.d);
  return `${WEEKDAYS_ABBR[dt.getDay()]}, ${MONTHS_ABBR[p.m]} ${p.d}, ${p.y}`;
}
function shiftMonth(delta) {
  const v = state.datePickerView || viewFromISO(state.editionDate);
  let m = v.m + delta, y = v.y;
  if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
  state.datePickerView = { y, m };
}

// Headline shown at the top of the dialog, e.g. "Mon, Aug 17". Year is
// omitted here (it's always visible in the month/year row below).
function fmtHeadline(iso) {
  const p = parseISO(iso);
  if (!p) return 'Pick a date';
  const dt = new Date(p.y, p.m, p.d);
  return `${WEEKDAYS_ABBR[dt.getDay()]}, ${MONTHS_ABBR[p.m]} ${p.d}`;
}

// The picker can drive two date fields: the main toolbar ('main') and the
// create-edition form ('pubform'). Only one modal opens at a time, so we
// just track which field is active and read/write the right slice of state.
function pickerValue(target) {
  return (target === 'pubform' ? (state.pubForm && state.pubForm.editionDate) : state.editionDate) || '';
}
function pickerCommit(target, iso) {
  if (target === 'pubform') { if (state.pubForm) state.pubForm.editionDate = iso; }
  else { state.editionDate = iso; }
}
function openDatePicker(target) {
  state.datePickerTarget = target;
  state.datePickerOpen = true;
  state.datePickerPending = pickerValue(target) || todayISO();
  state.datePickerView = viewFromISO(state.datePickerPending);
  state.datePickerMode = 'days';
  render();
}

function renderDatePicker(target = 'main', opts = {}) {
  const cur = pickerValue(target);
  const label = cur ? fmtHuman(cur) : 'Pick a date';
  const dis = opts.disabled ? ' disabled' : '';
  let html = `<div class="datepick">
      <button type="button" class="datepick-trigger" id="date-trigger-${target}"${dis}>
        <span>${escapeHtml(label)}</span>
        <span class="datepick-caret">▾</span>
      </button>`;
  if (state.datePickerOpen && state.datePickerTarget === target) html += renderDateDialog();
  html += `</div>`;
  return html;
}

// Full-panel modal (centered card) — sidesteps the popover-clipping issue
// and matches the familiar Material-style date dialog.
function renderDateDialog() {
  const pending = state.datePickerPending || pickerValue(state.datePickerTarget) || todayISO();
  const view = state.datePickerView || viewFromISO(pending);
  const mode = state.datePickerMode || 'days';
  const body = mode === 'years' ? renderYearGrid(view) : renderMonthGrid(view, pending);
  const navs = mode === 'days'
    ? `<div class="datepick-navs">
         <button type="button" class="datepick-nav" id="datepick-prev" title="Previous month">‹</button>
         <button type="button" class="datepick-nav" id="datepick-next" title="Next month">›</button>
       </div>`
    : '';
  return `<div class="datepick-overlay" id="datepick-overlay">
      <div class="datepick-dialog" id="datepick-dialog">
        <div class="datepick-dlg-head">
          <div class="datepick-dlg-label">Select date</div>
          <div class="datepick-dlg-headline">${escapeHtml(fmtHeadline(pending))}</div>
        </div>
        <div class="datepick-dlg-monthrow">
          <button type="button" class="datepick-monthbtn" id="datepick-monthtoggle">
            ${MONTHS_LONG[view.m]} ${view.y} <span class="datepick-monthcaret">${mode === 'years' ? '▴' : '▾'}</span>
          </button>
          ${navs}
        </div>
        ${body}
        <div class="datepick-dlg-foot">
          <button type="button" class="datepick-text-btn" id="datepick-cancel">Cancel</button>
          <button type="button" class="datepick-text-btn primary" id="datepick-ok">OK</button>
        </div>
      </div>
    </div>`;
}

function renderMonthGrid(view, pending) {
  const { y, m } = view;
  const startDow = new Date(y, m, 1).getDay();       // 0 = Sunday
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todISO = todayISO();
  const dow = DOW_LETTERS.map(w => `<div class="datepick-cell dow">${w}</div>`).join('');
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div class="datepick-cell"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const cellISO = isoFrom(y, m, d);
    const cls = ['datepick-day'];
    if (cellISO === pending) cls.push('selected');
    if (cellISO === todISO) cls.push('today');
    cells += `<div class="datepick-cell"><button type="button" class="${cls.join(' ')}" data-pick-date="${cellISO}">${d}</button></div>`;
  }
  return `<div class="datepick-grid">${dow}</div><div class="datepick-grid">${cells}</div>`;
}

function renderYearGrid(view) {
  const cur = view.y;
  const start = cur - 6;
  let cells = '';
  for (let i = 0; i < 12; i++) {
    const yr = start + i;
    cells += `<button type="button" class="datepick-year${yr === cur ? ' selected' : ''}" data-pick-year="${yr}">${yr}</button>`;
  }
  return `<div class="datepick-yeargrid">${cells}</div>`;
}

function closeDatePicker() {
  state.datePickerOpen = false;
  state.datePickerMode = 'days';
  render();
}

function bindDatePicker() {
  for (const target of ['main', 'pubform']) {
    const trigger = $(`date-trigger-${target}`);
    if (trigger) trigger.onclick = () => openDatePicker(target);
  }
  // Click the dim backdrop (but not the card) to dismiss without committing.
  const overlay = $('datepick-overlay');
  if (overlay) overlay.onclick = (e) => { if (e.target === overlay) closeDatePicker(); };
  // Month/year label toggles the year picker.
  const monthToggle = $('datepick-monthtoggle');
  if (monthToggle) monthToggle.onclick = () => {
    state.datePickerMode = (state.datePickerMode === 'years') ? 'days' : 'years';
    render();
  };
  const prev = $('datepick-prev');
  if (prev) prev.onclick = () => { shiftMonth(-1); render(); };
  const next = $('datepick-next');
  if (next) next.onclick = () => { shiftMonth(1); render(); };
  // Day click updates the PENDING selection (highlight + headline), no commit.
  for (const el of document.querySelectorAll('[data-pick-date]')) {
    el.onclick = () => { state.datePickerPending = el.getAttribute('data-pick-date'); render(); };
  }
  // Year click sets the visible year and returns to the day grid.
  for (const el of document.querySelectorAll('[data-pick-year]')) {
    el.onclick = () => {
      const v = state.datePickerView || viewFromISO(state.datePickerPending);
      state.datePickerView = { y: Number(el.getAttribute('data-pick-year')), m: v.m };
      state.datePickerMode = 'days';
      render();
    };
  }
  const cancel = $('datepick-cancel');
  if (cancel) cancel.onclick = () => closeDatePicker();
  const ok = $('datepick-ok');
  if (ok) ok.onclick = () => {
    if (state.datePickerPending) pickerCommit(state.datePickerTarget, state.datePickerPending);
    closeDatePicker();
  };
}

function escapeHtml(s) {
  // Encode the standard five HTML-special characters. Older versions
  // omitted the single quote — fine for double-quoted attributes only,
  // but unsafe for the few panel templates that use single quotes.
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
