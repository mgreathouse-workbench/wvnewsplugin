// The InDesign bridge's document lookups, against a fake InDesign DOM.
//
//   npm test
//
// These are the calls the panel makes to decide which window is which page.
// Getting one wrong is silent and expensive: the old findOpenDocByTempPath
// matched ANY document in the plugin's temp folder, so with A1 open it called
// A6 "still open" — the close sweep never checked A6 in, and Check In on a
// closed A6 saved, read and closed A1's window instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ── A fake `indesign` module ──────────────────────────────────────────

const fake = { app: null, SaveOptions: { NO: 'SaveOptions.NO' } };

function doc(name, { dir = '/Users/op/Library/Caches/PluginData/wvnews', closeThrows = false } = {}) {
  const d = {
    name,
    fullName: `${dir}/${name}`,
    closedWith: null,
    close(opt) {
      if (closeThrows) throw new Error('User canceled this action.');
      d.closedWith = opt;
      fake.app._docs.splice(fake.app._docs.indexOf(d), 1);
      if (fake.app._active === d) fake.app._active = fake.app._docs[0] || null;
    },
    layoutWindows: {
      length: 1,
      item: () => ({ bringToFront: () => { if (!fake.app._windowsStuck) fake.app._active = d; } }),
    },
  };
  return d;
}

// `activeDocument` is assignable on some InDesign builds and read-only on
// others; `readOnlyActive` covers the second, `windowsStuck` a window that
// will not come forward either.
function host(docs, { active = 0, readOnlyActive = false, windowsStuck = false } = {}) {
  const app = {
    _docs: docs.slice(),
    _active: docs[active] || null,
    _windowsStuck: windowsStuck,
    documents: {
      get length() { return app._docs.length; },
      item(i) {
        if (!app._docs[i]) throw new Error('Object is invalid');
        return app._docs[i];
      },
    },
    get activeDocument() {
      if (!app._active) throw new Error('No documents are open.');
      return app._active;
    },
    set activeDocument(d) {
      if (readOnlyActive) throw new Error('Property is read only.');
      app._active = d;
    },
  };
  fake.app = app;
  return app;
}

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'indesign') return fake;
  if (request === 'uxp') return { storage: { localFileSystem: {}, formats: { binary: 'binary', utf8: 'utf8' } } };
  return realLoad.call(this, request, ...rest);
};
const id = require('../plugin/wvnews-print/indesign.js');

const ED = 'EXT_101726';
const A1 = 'wv_EXT_101726_A1.indd';
const A6 = 'wv_EXT_101726_A6.indd';
const TEMP = '/Users/op/Library/Caches/PluginData/wvnews';

// ── findOpenDocByTempPath ─────────────────────────────────────────────

test('findOpenDocByTempPath finds the page by its own file name', () => {
  const a6 = doc(A6);
  host([doc(A1), a6]);
  assert.equal(id.findOpenDocByTempPath(`${TEMP}/${A6}`), a6);
});

test('findOpenDocByTempPath does not mistake another page in the temp folder for this one', () => {
  // The A6 bug: A1 open from the same folder, A6 closed.
  host([doc(A1)], { active: 0 });
  assert.equal(id.findOpenDocByTempPath(`${TEMP}/${A6}`), null);
});

test('findOpenDocByTempPath accepts a Windows path', () => {
  const a6 = doc(A6, { dir: 'C:\\Users\\op\\AppData\\Local\\Temp\\wvnews' });
  host([a6]);
  assert.equal(id.findOpenDocByTempPath(`C:\\Users\\op\\AppData\\Local\\Temp\\wvnews\\${A6}`), a6);
});

test('findOpenDocByTempPath is null for an empty path or no documents', () => {
  host([]);
  assert.equal(id.findOpenDocByTempPath(''), null);
  assert.equal(id.findOpenDocByTempPath(null), null);
  assert.equal(id.findOpenDocByTempPath(`${TEMP}/${A6}`), null);
});

test('findOpenDocByTempPath skips a document that throws on read', () => {
  const a6 = doc(A6);
  const broken = {};
  Object.defineProperty(broken, 'name', { get() { throw new Error('Object is invalid'); } });
  host([broken, a6]);
  assert.equal(id.findOpenDocByTempPath(`${TEMP}/${A6}`), a6);
});

// ── activeDocIsPage ───────────────────────────────────────────────────

test('activeDocIsPage reports the expected and actual documents', () => {
  host([doc(A1), doc(A6)], { active: 0 });
  assert.deepEqual(id.activeDocIsPage(ED, 'A6'), { ok: false, expected: A6, actual: A1 });
  assert.deepEqual(id.activeDocIsPage(ED, 'A1'), { ok: true, expected: A1, actual: A1 });
});

test('activeDocIsPage with nothing open is not ok and names no document', () => {
  host([]);
  assert.deepEqual(id.activeDocIsPage(ED, 'A6'), { ok: false, expected: A6, actual: null });
});

test('activeDocIsPage does not let A1 pass for A10', () => {
  host([doc('wv_EXT_101726_A10.indd')]);
  assert.equal(id.activeDocIsPage(ED, 'A1').ok, false);
});

// ── bringPageToFront ──────────────────────────────────────────────────

test('bringPageToFront makes the page the active document', () => {
  const app = host([doc(A1), doc(A6)], { active: 0 });
  assert.equal(id.bringPageToFront(ED, 'A6'), true);
  assert.equal(app._active.name, A6);
});

test('bringPageToFront falls back to the window when activeDocument is read-only', () => {
  const app = host([doc(A1), doc(A6)], { active: 0, readOnlyActive: true });
  assert.equal(id.bringPageToFront(ED, 'A6'), true);
  assert.equal(app._active.name, A6);
});

test('bringPageToFront is false when the page is not open', () => {
  host([doc(A1)]);
  assert.equal(id.bringPageToFront(ED, 'A6'), false);
});

test('bringPageToFront is false when InDesign will not bring it forward', () => {
  const app = host([doc(A1), doc(A6)], { active: 0, readOnlyActive: true, windowsStuck: true });
  assert.equal(id.bringPageToFront(ED, 'A6'), false);
  assert.equal(app._active.name, A1);
});

test('bringPageToFront is true without changing anything when the page is already in front', () => {
  const app = host([doc(A1), doc(A6)], { active: 1, readOnlyActive: true, windowsStuck: true });
  assert.equal(id.bringPageToFront(ED, 'A6'), true);
  assert.equal(app._active.name, A6);
});

// ── closeOpenPageDoc and openDocumentNames ────────────────────────────

test('closeOpenPageDoc closes only that page, without saving', () => {
  const a1 = doc(A1);
  const a6 = doc(A6);
  host([a1, a6]);
  assert.deepEqual(id.closeOpenPageDoc(ED, 'A6'), { found: 1, closed: 1 });
  assert.equal(a6.closedWith, fake.SaveOptions.NO);
  assert.equal(a1.closedWith, null);
  assert.deepEqual(id.openDocumentNames(), [A1]);
});

test('closeOpenPageDoc reports a page that would not close', () => {
  host([doc(A6, { closeThrows: true })]);
  assert.deepEqual(id.closeOpenPageDoc(ED, 'A6'), { found: 1, closed: 0 });
});

test('openDocumentNames lists every open document', () => {
  host([doc(A1), doc(A6), doc('Untitled-1')]);
  assert.deepEqual(id.openDocumentNames(), [A1, A6, 'Untitled-1']);
});
