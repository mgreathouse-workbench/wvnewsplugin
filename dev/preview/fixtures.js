// Stand-ins for the website and for InDesign, so the REAL panel code
// (plugin/wvnews-print/app.js and everything it wires) can run in Chrome.
//
// Shaped after the live EXT_101726 fixture edition: a Saturday Exponent
// Telegram, sections A10 B10 C10 D8, 14 pages with snippets, 52 stories.
//
// Each fake keeps a call log (window.__calls) so the smoke tests can assert
// what the panel asked for, not just what it drew.

(function () {
  const calls = (window.__calls = []);
  const log = (name, args) => calls.push({ name, args, at: Date.now() });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const NET = () => wait(window.__latency == null ? 120 : window.__latency);

  // ── Data ──────────────────────────────────────────────────────────
  const SNIPPETS = [
    ['59f9eb9368207b9f', 'a1daily'], ['2421712f0465e9eb', 'a2'], ['990d356bed177b96', 'news'],
    ['47c2b784fa47f19c', 'sports'], ['562a32169ca14ca4', 'exp opinion'], ['65fd59497fee93de', 'dailygrid'],
    ['90f335bbe58daf84', 'stocks daily'], ['9d060afae91bcd9f', 'jumplanding'], ['d3902fd65e39048a', 'puzzleanswer'],
  ].map(([id, name]) => ({ id, name, siteId: 'exponent-telegram', category: 'chrome' }));

  const SECTIONS = [{ letter: 'A', pageCount: 10 }, { letter: 'B', pageCount: 10 }, { letter: 'C', pageCount: 10 }, { letter: 'D', pageCount: 8 }];
  const folios = [];
  for (const s of SECTIONS) for (let i = 1; i <= s.pageCount; i++) folios.push(`${s.letter}${i}`);
  const snippetFor = {
    A1: 0, A2: 1, A3: 2, A4: 2, A5: 2, A6: 2, A7: 4, A8: 2, A9: 2, A10: 5, B1: 3, B2: 3, B3: 3, B4: 7,
  };

  const editionPages = () => folios.map((f) => ({
    folio: f,
    snippetId: snippetFor[f] != null ? SNIPPETS[snippetFor[f]].id : null,
    assets: [],
  }));

  const state = (window.__fake = {
    signedIn: true,
    edition: {
      id: 'EXT_101726', siteId: 'exponent-telegram', siteCode: 'EXT', editionDate: '2026-10-17',
      dayOfWeek: 'Saturday', status: 'built', sections: SECTIONS, pages: editionPages(),
    },
    pageFiles: {},
    lockedByOthers: { B2: { displayName: 'Dana Whitlock', email: 'dana@example.com' } },
    open: [],            // open InDesign documents, by name
    front: null,         // the front document's name
    savedBytes: {},      // fileName -> length saved to disk
    failCheckout: {},    // folio -> error to throw
  });

  const now = Date.now();
  for (const f of folios) {
    const v = f === 'A1' ? 5 : f === 'A5' ? 4 : 4;
    state.pageFiles[f] = { folio: f, currentVersion: v, lock: null, updatedAt: new Date(now).toISOString() };
  }
  state.pageFiles.B2.lock = {
    uid: 'dana', email: 'dana@example.com', displayName: 'Dana Whitlock',
    lockedAt: new Date(now - 20 * 60000).toISOString(), expiresAt: new Date(now + 70 * 60000).toISOString(), expired: false,
  };
  state.pageFiles.C4.lock = {
    uid: 'sam', email: 'sam@example.com', displayName: 'Sam Ortiz',
    lockedAt: new Date(now - 200 * 60000).toISOString(), expiresAt: new Date(now - 20 * 60000).toISOString(), expired: true,
  };

  const HEADLINES = [
    'Country music icon Dolly Parton dies at 80', 'Canada sets new tariffs on US goods', 'W.Va. Wesleyan offers new affordability initiatives',
    'Airport looks to expand flights to Charlotte', 'Clarksburg teen arrested after shooting at vehicle', 'Man pleads guilty to sex crimes in Harrison County',
    'WVU Medicine team performs innovative lung surgery', 'Local warming shelter prepares for another winter', 'Iran seeing longer lines outside gasoline stations',
    'Texas wildfire mushrooms within hours, ripping through ranchlands', 'Judge rejects Ghislaine Maxwell bid for release', 'Lewis County volleyball sweeps Preston 2-0',
    'Bridgeport council approves budget amendments', 'Fairmont State announces new nursing program', 'Harrison County schools report rising enrollment',
    'Robert C. Byrd High wins regional band contest', 'Salem fire department receives new engine', 'Shinnston residents debate park renovations',
  ];
  const stories = [];
  for (let i = 0; i < 52; i++) {
    const page = i < 46 ? folios[i % 14] : null;
    stories.push({
      id: `TESTED-story-${String(i + 1).padStart(2, '0')}`,
      headline: HEADLINES[i % HEADLINES.length] + (i >= HEADLINES.length ? ` (${Math.floor(i / HEADLINES.length) + 1})` : ''),
      byline: ['By Steven Allen Adams', 'By Matt Harvey', 'By Jeff Toquinto', 'Staff report', 'By Rebecca Cunningham'][i % 5],
      dateline: i % 3 === 0 ? 'CLARKSBURG' : '',
      deck: i % 4 === 0 ? 'Officials say the change takes effect next month' : '',
      pageAssignment: page,
      bodyText: 'Lorem ipsum dolor sit amet '.repeat(80 + (i * 13) % 300),
      printOnly: i % 11 === 0,
      photo: i % 5 === 0 ? { url: '', alt: '' } : null,
      placement: i < 4 ? { documentName: 'wv_EXT_101726_A1.indd' } : null,
    });
  }

  const ADS = [
    ['TESTED-ad-05', 'Cava Appliance', '6col x 4in', 10.5, 4, true, 'rop'],
    ['TESTED-ad-01', 'Mountain State Motors', '1col x 3in', 1.6458, 3, true, 'rop'],
    ['TESTED-ad-29', 'Maple Lake Dental', 'Full Page', 10.5, 20.42, true, 'rop'],
    ['TESTED-ad-12', 'Riverside Realty', 'Eighth Page', 5.1875, 5, false, 'classified'],
    ['TESTED-ad-18', 'Goff Plumbing', '2col x 4in', 3.4167, 4, false, 'classified'],
    ['TESTED-ad-23', 'Harrison County Clerk', '2col x 6in', 3.4167, 6, false, 'legal'],
  ].map(([id, advertiser, sizeCode, w, h, color, section]) => ({
    id, advertiser, sizeCode, widthIn: w, heightIn: h, colorRequired: color, adSection: section,
    adSectionSource: id === 'TESTED-ad-23' ? 'inferred' : 'set', editionId: 'EXT_101726', pageAssignment: '',
  }));

  // ── uxp ───────────────────────────────────────────────────────────
  window.__fakeUxp = {
    shell: { openExternal: async (url) => { log('openExternal', [url]); } },
    versions: { plugin: '', uxp: '8.0.0' },   // harness.js fills in the manifest's
    storage: { formats: { binary: 'binary', utf8: 'utf8' } },
  };

  // ── auth.js ───────────────────────────────────────────────────────
  window.__fakeAuth = {
    getAccessToken: async () => (state.signedIn ? 'token' : null),
    beginAuthorize: async () => 'https://staging.wvnews.com/api/print/oauth/authorize?client_id=wvnews-print',
    exchangeCode: async (code) => { log('exchangeCode', [code]); await NET(); state.signedIn = true; },
    signOut: async () => { state.signedIn = false; },
  };

  // ── api.js ────────────────────────────────────────────────────────
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pageFile = (f) => clone(state.pageFiles[f]);
  window.__fakeApi = {
    fetchSites: async () => { await NET(); return { sites: [
      { id: 'exponent-telegram', name: 'The Exponent Telegram', code: 'EXT', defaultSections: SECTIONS },
      { id: 'state-journal', name: 'State Journal', code: 'SJN', defaultSections: [{ letter: 'A', pageCount: 12 }] },
      { id: 'garrett-republican', name: 'Garrett County Republican', code: 'GCR', defaultSections: [{ letter: 'A', pageCount: 16 }] },
    ] }; },
    listEditions: async ({ siteId } = {}) => {
      log('listEditions', [siteId]); await NET();
      if (siteId && siteId !== 'exponent-telegram') return { editions: [] };
      return { editions: [
        clone(state.edition),
        { id: 'EXT_082626', siteId: 'exponent-telegram', editionDate: '2026-08-26', status: 'built', sections: [{ letter: 'A', pageCount: 10 }, { letter: 'B', pageCount: 10 }], pages: Array.from({ length: 20 }, (_, i) => ({ folio: `${i < 10 ? 'A' : 'B'}${(i % 10) + 1}`, snippetId: null })) },
        { id: 'EXT_101926', siteId: 'exponent-telegram', editionDate: '2026-10-19', status: 'planned', sections: SECTIONS, pages: editionPages().map((p) => ({ ...p, snippetId: null })) },
      ] };
    },
    listSnippets: async () => { await NET(); return { snippets: clone(SNIPPETS) }; },
    getEdition: async (id) => {
      log('getEdition', [id]); await NET();
      if (id === state.edition.id) return { edition: clone(state.edition) };
      const list = (await window.__fakeApi.listEditions({})).editions;
      const e = list.find((x) => x.id === id);
      if (!e) { const err = new Error('Not found'); err.statusCode = 404; throw err; }
      return { edition: e };
    },
    updateEditionStatus: async (id, status) => { log('updateEditionStatus', [id, status]); state.edition.status = status; return {}; },
    listEditionPages: async () => { await NET(); return Object.keys(state.pageFiles).map(pageFile); },
    checkoutPage: async ({ folio }) => {
      log('checkoutPage', [folio]); await NET();
      if (state.failCheckout[folio]) throw state.failCheckout[folio];
      const theirs = state.lockedByOthers[folio];
      if (theirs) {
        const err = new Error(`Page ${folio} is checked out`);
        err.statusCode = 423;
        err.lock = { ...state.pageFiles[folio].lock };
        throw err;
      }
      state.pageFiles[folio].lock = {
        uid: 'me', email: 'designer@example.com', displayName: 'Pat Morgan',
        lockedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * 60000).toISOString(), expired: false,
      };
      return { page: pageFile(folio), downloadUrl: `https://storage.example/pages/${folio}.indd` };
    },
    fetchPageBinary: async () => { await NET(); return new ArrayBuffer(2002944); },
    heartbeatPage: async ({ folio }) => ({ page: pageFile(folio) }),
    checkinPage: async ({ folio, bytes, note }) => {
      log('checkinPage', [folio, bytes && bytes.byteLength, note]); await NET();
      const pf = state.pageFiles[folio];
      pf.currentVersion += 1; pf.lock = null;
      return { page: pageFile(folio) };
    },
    fetchBudget: async () => { log('fetchBudget', []); await NET(); return {
      assets: clone(stories),
      templates: [{ id: 't1', label: 'Two-column with photo', kind: 'story' }, { id: 't2', label: 'Brief', kind: 'brief' }],
      styleMap: {},
    }; },
    recordPlacement: async (p) => { log('recordPlacement', [p.assetId, p.pageAssignment]); return {}; },
    fetchMarketplace: async (siteId, kind) => {
      log('fetchMarketplace', [kind]); await NET();
      if (kind === 'ads') return { count: ADS.length, items: clone(ADS) };
      const n = { classifieds: 30, legals: 11, obits: 16 }[kind] || 0;
      return { count: n, items: Array.from({ length: n }, (_, i) => ({ id: `${kind}-${i}` })) };
    },
    fetchSectionHeaders: async () => ({ headers: [] }),
    publishAds: async ({ orderIds }) => { log('publishAds', [orderIds]); await NET(); return { published: orderIds, skipped: [], errors: [] }; },
    createEdition: async (body) => { log('createEdition', [body]); await NET(); return { edition: { id: `${body.siteCode}_NEW` } }; },
    updateEdition: async (id, body) => { log('updateEdition', [id, body]); await NET(); return {}; },
  };

  // ── indesign.js ───────────────────────────────────────────────────
  const fileName = (ed, f) => `wv_${ed}_${f}.indd`;
  const folioOf = (name) => { const m = /^wv_[A-Z]{3}_\d{6}_([A-Z]+\d+)\.indd$/.exec(name || ''); return m ? m[1] : null; };
  const isOpen = (name) => state.open.includes(name);
  window.__fakeId = {
    STORY_BLOCK_IDS: ['2col_story', '4col_story', '4col_story_1mug', '4col_story_1photo_1mug', '4col_story_2photos', '4col_story_2photos_boxed', '6col_story'],
    // documents
    openDownloadedPage: async ({ editionId, folio, arrayBuffer }) => {
      const name = fileName(editionId, folio);
      if (!isOpen(name)) state.open.push(name);
      state.front = name;
      state.savedBytes[name] = arrayBuffer.byteLength;
      return { doc: { name }, tempPath: `/tmp/PluginData/${name}`, fileName: name, bytes: arrayBuffer.byteLength };
    },
    createBlankPage: async ({ editionId, folio }) => {
      const name = fileName(editionId, folio);
      state.open.push(name); state.front = name;
      return { doc: { name }, tempPath: `/tmp/PluginData/${name}`, fileName: name, bytes: null };
    },
    findOpenDocByTempPath: (p) => { const n = String(p).split('/').pop(); return isOpen(n) ? { name: n } : null; },
    saveAndReadPageBytes: async ({ fileName: n }) => new ArrayBuffer(state.savedBytes[n] || 1),
    readPageBytes: async (n) => {
      if (state.savedBytes[n] == null) throw new Error('not found');
      return new ArrayBuffer(state.savedBytes[n]);
    },
    closePageDoc: async (doc) => { if (doc) { state.open = state.open.filter((x) => x !== doc.name); if (state.front === doc.name) state.front = state.open[0] || null; } },
    closeOpenPageDoc: (ed, f) => { const n = fileName(ed, f); const found = isOpen(n) ? 1 : 0; state.open = state.open.filter((x) => x !== n); return { found, closed: found }; },
    activeDocIsPage: (ed, f) => ({ ok: state.front === fileName(ed, f), expected: fileName(ed, f), actual: state.front }),
    bringPageToFront: (ed, f) => { const n = fileName(ed, f); if (!isOpen(n)) return false; state.front = n; return true; },
    openDocumentNames: () => state.open.slice(),
    uiBrightness: () => (window.__brightness == null ? null : window.__brightness),
    activeDocument: () => { if (!state.front) throw new Error('Open a document first.'); return { name: state.front }; },
    activePageLabel: () => folioOf(state.front) || '1',
    activeDocPageCount: () => 1,
    // building
    buildEditionPages: async (edition, _snips, onProgress) => {
      const results = [];
      const pages = edition.pages || [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        for (const phase of ['checkout', 'create', 'place', 'save']) {
          onProgress && onProgress({ folio: p.folio, index: i, total: pages.length, phase });
          await wait(window.__buildStep == null ? 25 : window.__buildStep);
        }
        state.pageFiles[p.folio].currentVersion += 1;
        results.push({
          folio: p.folio, saved: true, placed: !!p.snippetId, version: state.pageFiles[p.folio].currentVersion,
          assets: { placed: p.folio === 'A5' ? 1 : 0, missed: 0 },
          diag: p.folio === 'A5' ? ['master: B-Inside', 'first ad: top 0.0000in, bottom 20.4200in from page top'] : [],
        });
      }
      log('buildEditionPages', [pages.map((p) => p.folio)]);
      return { built: results.length, failed: 0, results };
    },
    refreshPlacedAdsOnActivePage: async () => ({ checked: 2, replaced: 1, unchanged: 1, failed: 0, details: ['order-TESTED-ad-05: replaced', 'order-TESTED-ad-09: still no approved artwork'] }),
    // budget
    verifyPlacedAssets: async () => ({ docNames: state.open.slice(), assetIds: state.open.includes('wv_EXT_101726_A1.indd') ? ['TESTED-story-01', 'TESTED-story-15'] : [] }),
    autoPaginatePage: async (profile, folio, stories) => {
      log('autoPaginatePage', [profile, folio, stories.length, state.front]); await wait(200);
      const placements = stories.map((s, i) => ({
        story: s, weight: i === 0 ? 'lead' : 'secondary',
        position: { id: `pos-${i + 1}`, defaultBlock: i === 0 ? '4col_story_1photo_1mug' : '2col_story' },
        placed: true, framesBound: ['headline', 'body'],
        grouped: i !== 2, groupNote: i === 2 ? 'grouping changed how its text wraps, so its frames were left as placed' : '',
      }));
      return { placements, unplaced: [], successCount: placements.length, totalStories: stories.length };
    },
    placeTemplate: async () => ({ page: 'A1', documentName: state.front, framesBound: ['headline', 'body'] }),
    placeStoryIntoSelectedFrame: async () => ({ page: 'A1', documentName: state.front, framesBound: ['headline', 'deck', 'byline', 'body'] }),
    placeAndBindStoryBlock: async () => ({ framesBound: ['print_headline', 'nameline', 'main story'], grouped: true, groupNote: '' }),
    flowFullStoryIntoLabelledFrames: async () => ({ page: 'A1', documentName: state.front, framesBound: ['headlineFrame', 'bodyFrame'], missing: [] }),
    flowIntoSelectedFrame: async () => ({ page: 'A1', documentName: state.front, framesBound: ['body'] }),
    placePhotoInSelection: async () => ({ page: 'A1', documentName: state.front }),
    captureSourceForJump: async (slug) => ({ slug, sourceDocName: state.front, sourcePage: 'A1', overflowText: '…', overflowChars: 1420, turnlinePlaced: true }),
    completeJumpToFrame: async () => ({ destDocName: state.front, destPage: 'A9', patchedInDoc: true }),
    // marketplace
    placeMarketplaceBlock: async (kind, items) => ({ placed: items.length, frame: 'the selected frame' }),
    updateSectionHeaders: async () => ({ placed: 6 }),
    placeAdSized: async (ad) => ({ page: folioOf(state.front) || 'A3', frameLabel: `order-${ad.id}` }),
    placedAdOrderIdsOnActivePage: () => ['TESTED-ad-05', 'TESTED-ad-01'],
  };

  // Count calls still in flight, across every fake, so the smoke tests can
  // wait for "nothing pending" rather than a fixed delay.
  window.__inflight = 0;
  for (const fake of [window.__fakeApi, window.__fakeAuth, window.__fakeId, window.__fakeUxp.shell]) {
    for (const [name, fn] of Object.entries(fake)) {
      if (typeof fn !== 'function') continue;
      fake[name] = function tracked(...args) {
        const out = fn.apply(this, args);
        if (out && typeof out.then === 'function') {
          window.__inflight++;
          const done = () => { window.__inflight--; };
          out.then(done, done);
        }
        return out;
      };
    }
  }

  // Test controls: simulate the operator closing a window after saving.
  window.__sim = {
    closeWindow(folio, savedBytes) {
      const n = fileName('EXT_101726', folio);
      state.open = state.open.filter((x) => x !== n);
      if (state.front === n) state.front = state.open[0] || null;
      if (savedBytes != null) state.savedBytes[n] = savedBytes;
    },
  };
}());
