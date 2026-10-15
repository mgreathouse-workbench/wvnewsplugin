// The panel's foundations: templating, the store, the action runner and the
// formatting helpers. Plain Node, no DOM — these modules take everything they
// need as arguments, which is what makes them testable here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { html, raw, cx, flag, render } = require('../plugin/wvnews-print/ui/html.js');
const { createStore } = require('../plugin/wvnews-print/ui/store.js');
const { createActions, fail } = require('../plugin/wvnews-print/ui/actions.js');
const fmt = require('../plugin/wvnews-print/ui/format.js');
const { foliosOf, previewEditionId } = require('../plugin/wvnews-print/features/editions.js');

// ── html ──────────────────────────────────────────────────────────────

test('html escapes every interpolated value', () => {
  const headline = 'Judge says "no" to <script> & more';
  assert.equal(render(html`<div title="${headline}">${headline}</div>`),
    '<div title="Judge says &quot;no&quot; to &lt;script&gt; &amp; more">Judge says &quot;no&quot; to &lt;script&gt; &amp; more</div>');
});

test('html nests, joins arrays, and drops null, false and true', () => {
  const items = ['A1', 'A<2>'];
  assert.equal(render(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`), '<ul><li>A1</li><li>A&lt;2&gt;</li></ul>');
  assert.equal(render(html`${null}${undefined}${false}${true}${0}`), '0');
  assert.equal(render(html`${raw('<b>ok</b>')}`), '<b>ok</b>');
});

test('cx and flag build class lists and boolean attributes', () => {
  assert.equal(cx('row', false && 'x', 'is-mine', null), 'row is-mine');
  assert.equal(render(html`<sp-button${flag('disabled', true)}${flag('quiet', false)}>`), '<sp-button disabled>');
});

// ── store ─────────────────────────────────────────────────────────────

test('store.set merges, derives, and notifies every listener', () => {
  const store = createStore({ a: 1, b: 2 });
  const seen = [];
  const off = store.subscribe((s) => seen.push(s.a));
  store.set({ a: 5 });
  store.set((s) => ({ a: s.a + 1 }));
  off();
  store.set({ a: 100 });
  assert.deepEqual(seen, [5, 6]);
  assert.deepEqual(store.state, { a: 100, b: 2 });
});

test('a listener that throws does not stop the others', () => {
  const store = createStore({ n: 0 });
  let reached = false;
  const err = console.error;
  console.error = () => {};
  try {
    store.subscribe(() => { throw new Error('boom'); });
    store.subscribe(() => { reached = true; });
    store.set({ n: 1 });
  } finally { console.error = err; }
  assert.equal(reached, true);
});

// ── run() ─────────────────────────────────────────────────────────────

function runner() {
  const store = createStore({ activity: null, message: null, detailsOpen: false });
  const logged = { warn: [], error: [] };
  const log = { warn: (...a) => logged.warn.push(a.join(' ')), error: (...a) => logged.error.push(a.join(' ')) };
  return { store, logged, run: createActions({ store, log }).run };
}

test('run names the activity while it runs and clears it after success', async () => {
  const { store, run } = runner();
  let during = null;
  await run('Checking in A6', async ({ progress }) => {
    progress('uploading');
    during = store.state.activity;
    return 'A6 checked in as v5.';
  });
  assert.deepEqual(during, { label: 'Checking in A6', detail: 'uploading' });
  assert.equal(store.state.activity, null);
  assert.deepEqual(store.state.message, { kind: 'success', text: 'A6 checked in as v5.' });
});

test('run clears the activity after a failure, too', async () => {
  // The bug this runner exists for: the old reset lived in the catch block,
  // so a publish that SUCCEEDED latched every button off for the session.
  const { store, run } = runner();
  await run('Publishing', async () => { throw new Error('network down'); });
  assert.equal(store.state.activity, null);
  assert.equal(store.state.message.kind, 'error');
  assert.equal(store.state.message.text, 'network down');
});

test('run refuses to start a second action while one is running', async () => {
  const { store, run } = runner();
  let release;
  const first = run('Building pages', () => new Promise((r) => { release = r; }));
  let secondRan = false;
  await run('Opening A6', async () => { secondRan = true; });
  assert.equal(secondRan, false);
  assert.match(store.state.message.text, /Wait for “Building pages” to finish/);
  release();
  await first;
  assert.equal(store.state.activity, null);
});

test('an anticipated failure is a console warning; anything else is an error', async () => {
  const { store, logged, run } = runner();
  await run('Opening B2', async () => { throw fail('B2 is open by Dana Whitlock for another 69 min.'); });
  assert.equal(logged.warn.length, 1);
  assert.equal(logged.error.length, 0);
  await run('Opening B3', async () => { throw new TypeError("Cannot read properties of undefined (reading 'lock')"); });
  assert.equal(logged.error.length, 1);
  assert.equal(store.state.message.kind, 'error');
});

test('fail carries details for the status bar', async () => {
  const { store, run } = runner();
  await run('Building pages', async () => { throw fail('2 of 38 pages did not build.', ['✓ A1 v5', '✗ B1 — locked']); });
  assert.equal(store.state.message.details, '✓ A1 v5\n✗ B1 — locked');
});

test('an action that returns nothing leaves no message', async () => {
  const { store, run } = runner();
  store.set({ message: { kind: 'error', text: 'old' } });
  await run('Loading the budget', async () => {});
  assert.equal(store.state.message, null);
});

// ── format and plan helpers ───────────────────────────────────────────

test('folios sort as a newspaper reads them, not as strings', () => {
  const list = ['B1', 'A10', 'A2', 'A1', 'C1', 'B10', 'B2'];
  assert.deepEqual(list.sort(fmt.compareFolio), ['A1', 'A2', 'A10', 'B1', 'B2', 'B10', 'C1']);
});

test('page assignments normalise from either spelling', () => {
  assert.equal(fmt.normalizeFolio('a-1'), 'A1');
  assert.equal(fmt.normalizeFolio('B 10'), 'B10');
  assert.equal(fmt.normalizeFolio(''), null);
});

test('dates format the way the context bar shows them', () => {
  assert.equal(fmt.fmtDate('2026-10-17'), 'Sat, Oct 17, 2026');
  assert.equal(fmt.fmtDate('not a date'), '');
  assert.equal(fmt.isoFrom(2026, 9, 7), '2026-10-07');
  assert.deepEqual(fmt.parseISO('2026-10-17'), { y: 2026, m: 9, d: 17 });
});

test('minutes left on a lock never go negative', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(fmt.minutesLeft('2026-10-15T13:30:00Z', now), 90);
  assert.equal(fmt.minutesLeft('2026-10-15T11:00:00Z', now), 0);
  assert.equal(fmt.minutesLeft(null, now), 0);
});

test('plural', () => {
  assert.equal(fmt.plural(1, 'page'), '1 page');
  assert.equal(fmt.plural(38, 'page'), '38 pages');
  assert.equal(fmt.plural(2, 'story', 'stories'), '2 stories');
});

test('a plan expands to its folios, and an edition id follows the platform', () => {
  assert.deepEqual(foliosOf([{ letter: 'A', pageCount: 3 }, { letter: 'B', pageCount: 2 }]), ['A1', 'A2', 'A3', 'B1', 'B2']);
  assert.equal(previewEditionId('EXT', '2026-10-17'), 'EXT_101726');
  assert.equal(previewEditionId('EXTRA', '2026-10-17'), '');
  assert.equal(previewEditionId('EXT', ''), '');
});

// ── theme fallback ────────────────────────────────────────────────────

const { createThemeWatcher } = require('../plugin/wvnews-print/ui/theme.js');

function fakeRoot() {
  const attrs = {};
  return {
    attrs,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
}

test('theme: a matching colour-scheme query leaves the stylesheet in charge', () => {
  const root = fakeRoot();
  root.attrs['data-ui'] = 'dark';   // left by a previous instance of the panel
  const w = createThemeWatcher({ root, readBrightness: () => 1, matchMedia: (q) => ({ matches: q.endsWith('lightest)') }) });
  assert.equal(w.apply(), null);
  assert.deepEqual(root.attrs, {}, 'the leftover override is removed');
});

test('theme: with no matching query, InDesign brightness picks the family', () => {
  const root = fakeRoot();
  let b = 0;
  const w = createThemeWatcher({ root, readBrightness: () => b, matchMedia: () => ({ matches: false }) });
  assert.equal(w.apply(), 'dark');
  assert.equal(root.attrs['data-ui'], 'dark');
  b = 0.5;
  assert.equal(w.apply(), 'dark', 'Medium Dark');
  b = 0.75;
  assert.equal(w.apply(), 'light', 'Medium Light');
  assert.equal(root.attrs['data-ui'], 'light');
});

test('theme: without matchMedia it still uses brightness; without either it sets nothing', () => {
  const root = fakeRoot();
  assert.equal(createThemeWatcher({ root, readBrightness: () => 1, matchMedia: null }).apply(), 'light');
  const bare = fakeRoot();
  const w = createThemeWatcher({ root: bare, readBrightness: () => { throw new Error('not InDesign'); }, matchMedia: null });
  assert.equal(w.apply(), null);
  assert.deepEqual(bare.attrs, {});
});

test('theme: follows a change in Preferences, but not while an action runs', () => {
  const root = fakeRoot();
  let b = 0;
  let busy = false;
  let tick = null;
  const timers = { setInterval: (fn) => { tick = fn; return 1; } };
  createThemeWatcher({ root, readBrightness: () => b, matchMedia: null, isBusy: () => busy, timers }).start();
  assert.equal(root.attrs['data-ui'], 'dark');
  b = 1;
  busy = true;
  tick();
  assert.equal(root.attrs['data-ui'], 'dark');
  busy = false;
  tick();
  assert.equal(root.attrs['data-ui'], 'light');
});
