// Multi-piece display ads: one order, one ad number, several pieces, each
// placed on its own page with its own size and artwork.
//
//   npm test
//
// Tina 2026-11-09: a multi-page legal display (3 full pages + a half page) is
// ONE order on the platform, and a piece is named "order:8123#p2" there. Read
// whole, that id sent /asset/order/8123%23p2 (a 404 and a grey box), keyed two
// pieces' artwork to one slot, and let Publish Page send "8123#p2" as an order
// id. These pin the split: the order id goes where an order id is expected,
// the piece rides beside it, and an order with no pieces is byte-for-byte what
// it was before.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// ── Fakes: InDesign, UXP, and the API indesign.js talks to ─────────────

const fake = {
  app: null,
  EmptyFrameFittingOptions: { CONTENT_TO_FRAME: 'CONTENT_TO_FRAME' },
  FitOptions: { CONTENT_TO_FRAME: 'CONTENT_TO_FRAME' },
};
const written = [];
const fakeUxp = {
  storage: {
    formats: { binary: 'binary', utf8: 'utf8' },
    localFileSystem: {
      getTemporaryFolder: async () => ({
        createFile: async (name) => {
          written.push(name);
          return { nativePath: `/tmp/wvnews/${name}`, write: async () => {} };
        },
      }),
    },
  },
};
const fetched = [];
let artwork = () => null;
const fakeApi = {
  fetchAssetContent: async (...args) => { fetched.push(args); return artwork(...args); },
  fetchBinary: async () => new ArrayBuffer(4),
};

const PLUGIN = path.join(__dirname, '..', 'plugin', 'wvnews-print');
const realLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === 'indesign') return fake;
  if (request === 'uxp') return fakeUxp;
  // indesign.js gets the fake API; api.js itself is loaded for real below.
  if (request === './api.js' && parent && parent.filename === path.join(PLUGIN, 'indesign.js')) return fakeApi;
  if (request === './auth.js') return { getAccessToken: async () => 'token' };
  return realLoad.call(this, request, parent, ...rest);
};
const id = require('../plugin/wvnews-print/indesign.js');
const api = require('../plugin/wvnews-print/api.js');
const adPiece = require('../plugin/wvnews-print/ad-piece.js');
const h = require('../plugin/wvnews-print/ui/html.js');
const { createCommon } = require('../plugin/wvnews-print/views/common.js');
const { createMarketplaceView } = require('../plugin/wvnews-print/views/marketplace.js');
const { createMarketplace } = require('../plugin/wvnews-print/features/marketplace.js');

// A document whose active page holds frames with these Script Labels.
function pageWithLabels(labels, { withGraphic = [] } = {}) {
  const items = labels.map((label) => {
    const it = {
      label,
      removed: false,
      placed: [],
      graphics: { length: withGraphic.includes(label) ? 1 : 0 },
      frameFittingOptions: {},
      place(p) { it.placed.push(p); it.graphics.length = 1; },
      fit() {},
      remove() { it.removed = true; },
    };
    return it;
  });
  const page = { name: '1', allPageItems: items, parent: { allPageItems: [] } };
  const doc = {
    name: 'wv_EXT_101726_A6.indd',
    layoutWindows: [{ activePage: page }],
    pages: { item: () => page },
    swatches: { item: () => 'None' },
  };
  fake.app = { documents: { length: 1, item: () => doc }, activeDocument: doc };
  const byLabel = Object.fromEntries(items.map((it) => [it.label, it]));
  return byLabel;
}

const ED = 'EXT_101726';

// ── ad-piece.js ───────────────────────────────────────────────────────

test('adKey and adFrameLabel add the piece, and leave an order without one as it was', () => {
  assert.equal(adPiece.adKey({ id: '8123' }), '8123');
  assert.equal(adPiece.adKey({ id: 8123 }), '8123');
  assert.equal(adPiece.adKey({ id: '8123', pieceKey: 'p2' }), '8123#p2');
  assert.equal(adPiece.adFrameLabel({ id: 'TESTED-ad-05' }), 'order-TESTED-ad-05');
  assert.equal(adPiece.adFrameLabel({ id: '8123', pieceKey: 'p2' }), 'order-8123#p2');
});

test('splitAdKey separates the order id from the piece', () => {
  assert.deepEqual(adPiece.splitAdKey('8123#p2'), { id: '8123', pieceKey: 'p2' });
  assert.deepEqual(adPiece.splitAdKey('8123'), { id: '8123', pieceKey: null });
  assert.deepEqual(adPiece.splitAdKey('8123#'), { id: '8123', pieceKey: null });
});

test('parseAdFrameLabel reads wells, pieces and holding captions back', () => {
  const p = adPiece.parseAdFrameLabel;
  assert.deepEqual(p('order-8123'),
    { kind: 'order', id: '8123', pieceKey: null, key: '8123', frameLabel: 'order-8123', holding: false });
  assert.deepEqual(p('order-8123#p2'),
    { kind: 'order', id: '8123', pieceKey: 'p2', key: '8123#p2', frameLabel: 'order-8123#p2', holding: false });
  assert.deepEqual(p('order-8123#p2-holding'),
    { kind: 'order', id: '8123', pieceKey: 'p2', key: '8123#p2', frameLabel: 'order-8123#p2', holding: true });
  // Hyphenated order ids survive; only a trailing -holding is a caption.
  assert.equal(p('order-TESTAD-ET-071526').id, 'TESTAD-ET-071526');
  assert.equal(p('order-TESTAD-ET-071526-holding').holding, true);
  assert.equal(p('order-TESTAD-ET-071526-holding').id, 'TESTAD-ET-071526');
  assert.deepEqual(p('filler-abc'),
    { kind: 'filler', id: 'abc', pieceKey: null, key: 'abc', frameLabel: 'filler-abc', holding: false });
  for (const other of ['ad', 'storyFrame', 'order-', '', null, undefined]) assert.equal(p(other), null);
});

test('pieceText names a piece the way the Page Grid does, and nothing else', () => {
  assert.equal(adPiece.pieceText({ id: '8123', pieceKey: 'p2', pieceLabel: 'Page 2 of 4' }), '#8123 · Page 2 of 4');
  assert.equal(adPiece.pieceText({ id: '8123', pieceKey: 'p2' }), '#8123 · p2');
  assert.equal(adPiece.pieceText({ id: '8123' }), '');
});

// ── slotIdentity ──────────────────────────────────────────────────────

test('slotIdentity: a plain order slot is exactly what it was', () => {
  assert.deepEqual(id.slotIdentity({ id: 'order:7930', orderId: '7930' }),
    { kind: 'order', id: '7930', pieceKey: null, key: '7930', frameLabel: 'order-7930' });
  // A slot from an older plan with no kind prefix.
  assert.deepEqual(id.slotIdentity({ orderId: '555' }),
    { kind: 'order', id: '555', pieceKey: null, key: '555', frameLabel: 'order-555' });
});

test('slotIdentity: a piece slot gives the bare order id and a per-piece label', () => {
  assert.deepEqual(id.slotIdentity({ id: 'order:8123#p2', orderId: '8123', pieceKey: 'p2', pieceLabel: 'Page 2 of 4' }),
    { kind: 'order', id: '8123', pieceKey: 'p2', key: '8123#p2', frameLabel: 'order-8123#p2' });
  // The piece is honoured from the slot field when the id does not carry it.
  assert.deepEqual(id.slotIdentity({ id: 'order:8123', orderId: '8123', pieceKey: 'p3' }),
    { kind: 'order', id: '8123', pieceKey: 'p3', key: '8123#p3', frameLabel: 'order-8123#p3' });
});

test('slotIdentity: two pieces of one order never share a well', () => {
  const a = id.slotIdentity({ id: 'order:8123#p1', orderId: '8123', pieceKey: 'p1' });
  const b = id.slotIdentity({ id: 'order:8123#p2', orderId: '8123', pieceKey: 'p2' });
  assert.equal(a.id, b.id);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.frameLabel, b.frameLabel);
});

test('slotIdentity: a filler keeps its label and never gets a piece', () => {
  assert.deepEqual(id.slotIdentity({ id: 'filler:abc', kind: 'filler' }),
    { kind: 'filler', id: 'abc', pieceKey: null, key: 'abc', frameLabel: 'filler-abc' });
});

// ── fetchAssetContent ─────────────────────────────────────────────────

test('fetchAssetContent asks for a piece with ?piece=, never inside the path', async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ asset: { id: '8123' } }) };
  };
  try {
    await api.fetchAssetContent(ED, 'order', '8123', 'p2');
    await api.fetchAssetContent(ED, 'order', '8123');
    await api.fetchAssetContent(ED, 'order', '8123', null);
  } finally { globalThis.fetch = realFetch; }
  assert.match(urls[0], /\/api\/print\/editions\/EXT_101726\/asset\/order\/8123\?piece=p2$/);
  assert.match(urls[1], /\/api\/print\/editions\/EXT_101726\/asset\/order\/8123$/);
  assert.equal(urls[2], urls[1]);
});

// ── Publish Page and Refresh Artwork on a real page ───────────────────

test('Publish Page commits each ORDER once, whatever pieces and captions are on the page', () => {
  pageWithLabels([
    'order-8123#p1', 'order-8123#p2', 'order-8123#p2-holding',
    'order-777', 'order-777-holding', 'filler-abc', 'storyFrame',
  ]);
  assert.deepEqual(id.placedAdOrderIdsOnActivePage(), ['8123', '777']);
});

test('Refresh Artwork refetches a piece by order id + piece and clears only its caption', async () => {
  fetched.length = 0;
  written.length = 0;
  const frames = pageWithLabels(
    ['order-8123#p1', 'order-8123#p2', 'order-8123#p2-holding', 'order-777', 'order-777-holding', 'filler-abc'],
    { withGraphic: ['order-8123#p1'] },
  );
  artwork = (editionId, kind, assetId, pieceKey) => (
    kind === 'filler' ? null : { id: assetId, fileUrl: `https://storage.googleapis.com/ads/${assetId}-${pieceKey || 'all'}.pdf` });

  const r = await id.refreshPlacedAdsOnActivePage(ED);

  assert.deepEqual(fetched, [
    [ED, 'order', '8123', 'p1'],
    [ED, 'order', '8123', 'p2'],
    [ED, 'order', '777', null],
    [ED, 'filler', 'abc', null],
  ]);
  assert.deepEqual({ checked: r.checked, replaced: r.replaced, unchanged: r.unchanged, failed: r.failed },
    { checked: 4, replaced: 2, unchanged: 2, failed: 0 });
  assert.equal(frames['order-8123#p2'].placed.length, 1);
  assert.equal(frames['order-8123#p2-holding'].removed, true);
  assert.equal(frames['order-777-holding'].removed, true);
  assert.equal(frames['order-8123#p1'].placed.length, 0, 'a well that already holds art is left alone');
  // '#' is not a file-name character; the temp file still names the piece.
  assert.ok(written.includes('order-8123_p2-refresh.pdf'), written.join(', '));
});

// ── The Display Ads list and Place ────────────────────────────────────

const PLAIN = {
  id: 'TESTED-ad-05', kind: 'order', advertiser: 'Cava Appliance', sizeCode: '6col x 4in',
  widthIn: 10.5, heightIn: 4, adSection: 'legal', editionId: ED, pageAssignment: '',
};
const pieceOf = (n, extra = {}) => ({
  id: '8123', kind: 'order', advertiser: 'Harrison County Commission', sizeCode: 'LEGAL',
  pieceKey: `p${n}`, pieceLabel: `Page ${n} of 4`, sizeLabel: 'Full Page',
  widthIn: 10.5, heightIn: 21, adSection: 'legal', editionId: ED, pageAssignment: 'B3',
  fileUrl: `https://storage.googleapis.com/ads/8123-p${n}.pdf`, ...extra,
});

test('the Display Ads list names each piece and places it by its own key', () => {
  const view = createMarketplaceView({ ...h, ui: createCommon(h), adPiece });
  const state = {
    activity: null,
    edition: { id: ED },
    market: { ads: { items: [PLAIN, pieceOf(1), pieceOf(2)] } },
    placedAds: { '8123#p2': 'A6' },
  };
  const out = h.render(view.render(state));
  assert.ok(out.includes('#8123 · Page 1 of 4 · Full Page · 10.5 × 21 in'), 'piece 1 row meta');
  assert.ok(out.includes('#8123 · Page 2 of 4 · Full Page · 10.5 × 21 in'), 'piece 2 row meta');
  assert.ok(out.includes('data-arg="8123#p1"') && out.includes('data-arg="8123#p2"'), 'pieces place by piece key');
  // Only the piece that was placed says so.
  assert.equal((out.match(/Placed on A6 this session/g) || []).length, 1);
  // The plain order's row is unchanged.
  assert.ok(out.includes('6col x 4in · 10.5 × 4 in'));
  assert.ok(out.includes('data-arg="TESTED-ad-05"'));
});

function marketplaceWith(items) {
  const calls = { placed: [], recorded: [] };
  const store = {
    state: { edition: { id: ED, siteId: 'exponent-telegram', editionDate: '2026-10-17' }, market: { ads: { items } }, placedAds: {} },
    set(patch) { Object.assign(this.state, patch); },
  };
  const m = createMarketplace({
    store,
    run: (label, fn) => fn(),
    api: { recordPlacement: async (p) => { calls.recorded.push(p); } },
    id: {
      activePageLabel: () => 'A6',
      activeDocPageCount: () => 12,
      placeAdSized: async (ad) => { calls.placed.push(ad); return { page: 'A6', frameLabel: adPiece.adFrameLabel(ad) }; },
    },
    fmt: {},
    fail: (msg) => new Error(msg),
    colorPlacement: { isColorPage: () => ({ color: true }) },
    adPiece,
  });
  return { m, store, calls };
}

test('Place on a piece places THAT piece and records it against the order', async () => {
  const { m, store, calls } = marketplaceWith([pieceOf(1), pieceOf(2), pieceOf(3)]);
  const r = await m.placeAd('8123#p2');
  assert.equal(calls.placed.length, 1);
  assert.equal(calls.placed[0].pieceKey, 'p2');
  assert.equal(calls.recorded[0].assetId, '8123');
  assert.equal(calls.recorded[0].pieceKey, 'p2');
  assert.equal(calls.recorded[0].frameLabel, 'order-8123#p2');
  assert.deepEqual(store.state.placedAds, { '8123#p2': 'A6' });
  assert.match(r.text, /Placed Harrison County Commission \(#8123 · Page 2 of 4\) on A6\./);
});

test('Place on a plain order records exactly what it did before', async () => {
  const { m, store, calls } = marketplaceWith([{ ...PLAIN, fileUrl: 'https://storage.googleapis.com/ads/5.pdf' }]);
  const r = await m.placeAd('TESTED-ad-05');
  assert.deepEqual(calls.recorded[0], {
    assetId: 'TESTED-ad-05', siteId: 'exponent-telegram', editionDate: '2026-10-17',
    pageAssignment: 'A6', documentName: '', frameLabel: 'order-TESTED-ad-05', status: 'placed',
  });
  assert.deepEqual(store.state.placedAds, { 'TESTED-ad-05': 'A6' });
  assert.equal(r.text, 'Placed Cava Appliance on A6.');
});
