// End-to-end smoke tests for the panel, in Chrome.
//
//   npm run test:ui                          run every scenario
//   npm run test:ui -- --shots               also screenshot each screen
//   THEME=mediumlight npm run test:ui -- --shots
//                                            …in another InDesign theme
//   npm run test:ui -- --only=paginate       scenarios whose name matches
//
// Screenshots land in dev/screenshots/<theme>/ (git-ignored).
//
// Runs the REAL panel code (see dev/preview/harness.js) with InDesign and the
// website faked, and drives it with real mouse clicks — mousedown, mouseup,
// click — so the renderer's click-protection is exercised, not bypassed.
// Each scenario asserts on what is drawn AND on what the panel asked the fakes
// to do. Any console error fails the run.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.argv.includes('--shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const THEMES = ['dark', 'mediumdark', 'mediumlight', 'light'];
const THEME = process.env.THEME || 'dark';
if (!THEMES.includes(THEME)) throw new Error(`THEME must be one of ${THEMES.join(', ')}`);
const SHOT_ROOT = path.join(HERE, 'screenshots');

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}/dev/preview/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

const results = [];

async function open({ theme = THEME, width = 340, height = 640, signedOut = false, persist = null, query = {} } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(t)) errors.push(t);
  });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  const q = new URLSearchParams({ theme, ...query });
  if (signedOut) q.set('signedOut', '1');
  if (persist) q.set('persist', JSON.stringify(persist));
  await page.goto(`${BASE}?${q}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__harnessReady || window.__harnessError, { timeout: 8000 });
  const harnessError = await page.evaluate(() => window.__harnessError);
  if (harnessError) throw new Error(`harness failed: ${harnessError}`);
  await idle(page);
  return { page, errors };
}

// Settled: the panel has booted, no action is running, no call to the fakes
// is in flight, and the last paint has landed. Checked twice across a short
// gap, because a state change schedules its paint on the next turn.
async function idle(page, ms = 8000) {
  const settled = () => {
    const s = window.__store && window.__store.state;
    return !!s && !s.booting && !s.activity && window.__inflight === 0 && !document.querySelector('.activity.is-on');
  };
  await page.waitForFunction(settled, { timeout: ms, polling: 20 });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 40)));
  await page.waitForFunction(settled, { timeout: ms, polling: 20 });
}

const sel = (action, arg) => `[data-action="${action}"]${arg != null ? `[data-arg="${arg}"]` : ''}`;
async function click(page, action, arg) {
  const s = sel(action, arg);
  const el = await page.$(s);
  if (!el) throw new Error(`nothing to click: ${s}`);
  await el.click();           // real mousedown / mouseup / click
  await idle(page);
}
async function change(page, name, value, arg) {
  await page.evaluate((n, v, a) => {
    const el = document.querySelector(`[data-change="${n}"]${a != null ? `[data-arg="${a}"]` : ''}`);
    if (!el) throw new Error(`no control ${n}`);
    if (typeof v === 'boolean') el.checked = v; else el.value = v;
    // Not bubbling, on purpose: the panel must not depend on a Spectrum
    // widget's change event bubbling (it listens in the capture phase).
    el.dispatchEvent(new Event('change', { bubbles: false }));
  }, name, value, arg ?? null);
  await idle(page);
}
async function type(page, name, value, arg) {
  await page.evaluate((n, v, a) => {
    const el = document.querySelector(`[data-input="${n}"]${a != null ? `[data-arg="${a}"]` : ''}`);
    if (!el) throw new Error(`no field ${n}`);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: false }));
  }, name, value, arg ?? null);
}
// Enter on whatever carries data-enter="<action>".
async function enter(page, action) {
  await page.evaluate((a) => {
    const el = document.querySelector(`[data-enter="${a}"]`);
    if (!el) throw new Error(`nothing takes Enter for ${a}`);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: false }));
  }, action);
  await idle(page);
}
const text = (page) => page.evaluate(() => document.body.innerText);
const calls = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), name);
const statusText = (page) => page.evaluate(() => (document.querySelector('.status-text') || {}).textContent || '');
const statusKind = (page) => page.evaluate(() => {
  const el = document.querySelector('.status');
  return el ? (el.className.match(/status--(\w+)/) || [])[1] : null;
});
async function shot(page, name, theme = THEME) {
  if (!SHOTS) return;
  const dir = path.join(SHOT_ROOT, theme);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function scenario(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  let ctx;
  try {
    ctx = await fn();
    if (ctx && ctx.errors && ctx.errors.length) throw new Error(`console errors:\n  ${ctx.errors.join('\n  ')}`);
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: err.message });
  } finally {
    if (ctx && ctx.page) await ctx.page.close().catch(() => {});
  }
}

const EDITION = { lastEditionId: 'EXT_101726', lastView: 'pages' };

// ── Scenarios ─────────────────────────────────────────────────────────

await scenario('sign-in screen, and the browser opens', async () => {
  const c = await open({ signedOut: true });
  await shot(c.page, 'signin');
  expect(/Sign in to WVNews Print/.test(await text(c.page)), 'sign-in title missing');
  await click(c.page, 'openSignIn');
  expect((await calls(c.page, 'openExternal')).length === 1, 'browser was not opened');
  expect(/browser is open/i.test(await statusText(c.page)), 'no instruction after opening the browser');
  await type(c.page, 'setSignInCode', 'ABC-123');
  await enter(c.page, 'finishSignIn');          // Enter in the code field signs in
  expect((await calls(c.page, 'exchangeCode'))[0].args[0] === 'ABC-123', 'code not exchanged');
  expect(/EDITIONS/i.test(await text(c.page)), 'did not land on the editions list after sign-in');
  return c;
});

await scenario('first run lands on Setup and choosing an edition opens its pages', async () => {
  const c = await open();
  await shot(c.page, 'setup');
  const t = await text(c.page);
  expect(/No edition chosen/.test(t) && /EXT_101726/.test(t), 'setup list not shown on first run');
  await click(c.page, 'selectEdition', 'EXT_101726');
  const t2 = await text(c.page);
  expect(/Sat, Oct 17, 2026/.test(t2), 'context bar does not show the edition date');
  expect(await c.page.$$eval('.row .cell-folio', (els) => els.length) >= 38, 'not all 38 pages listed');
  return c;
});

await scenario('pages list: states, missing snippets, theme screenshots', async () => {
  const c = await open({ persist: EDITION });
  await shot(c.page, 'pages');
  const t = await text(c.page);
  expect(/Dana/.test(t), 'a page locked by someone else is not marked with who has it');
  expect(/24 pages without a snippet/.test(t), 'missing-snippet warning absent');
  // The list in every theme, whichever one this run is in.
  for (const theme of THEMES.filter((x) => x !== THEME)) {
    const t2 = await open({ theme, persist: EDITION });
    await shot(t2.page, 'pages', theme);
    await t2.page.close();
  }
  return c;
});

await scenario('open a page, it shows as yours, check it in', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'openPage', 'A6');
  expect(/is open in InDesign/.test(await statusText(c.page)), `open did not report success: ${await statusText(c.page)}`);
  expect(/CHECKED OUT/i.test(await text(c.page)), 'checked-out section missing');
  expect(await c.page.$eval('.tab-count', (el) => el.textContent.trim()) === '1', 'Pages tab does not count the held page');
  await shot(c.page, 'pages-checked-out');
  await click(c.page, 'checkin', 'A6');
  expect(/A6 checked in as v5/.test(await statusText(c.page)), `check-in result wrong: ${await statusText(c.page)}`);
  expect(!/CHECKED OUT/i.test(await text(c.page)), 'checked-out section still showing after check-in');
  return c;
});

await scenario('a page someone else holds says who, as an error', async () => {
  const c = await open({ persist: EDITION });
  const before = c.errors.length;
  await click(c.page, 'openPage', 'B2');
  expect(await statusKind(c.page) === 'error', 'locked page did not produce an error');
  expect(/Dana Whitlock/.test(await statusText(c.page)), `holder not named: ${await statusText(c.page)}`);
  // An anticipated refusal is a warning in the console, not an error.
  expect(c.errors.length === before, 'a lock held by someone else was logged as a console error');
  await shot(c.page, 'status-error');
  return c;
});

await scenario('closing a window checks the page in by itself', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'openPage', 'A7');
  // The operator edits, saves (the file grows) and closes the window.
  await c.page.evaluate(() => window.__sim.closeWindow('A7', 2100000));
  await c.page.waitForFunction(() => /A7 checked in as v5 when you closed it/.test(document.body.innerText), { timeout: 15000 });
  expect((await calls(c.page, 'checkinPage')).some((x) => x.args[0] === 'A7'), 'sweep never uploaded A7');
  return c;
});

await scenario('opening and closing without saving adds no version', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'openPage', 'A8');
  await c.page.evaluate(() => window.__sim.closeWindow('A8'));        // same bytes as downloaded
  await new Promise((r) => setTimeout(r, 11500));
  expect(!(await calls(c.page, 'checkinPage')).some((x) => x.args[0] === 'A8'), 'an untouched page was uploaded');
  return c;
});

await scenario('with automatic check-in off, a closed page stays checked out', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'openPage', 'A9');
  await change(c.page, 'setAutoCheckin', false);
  await c.page.evaluate(() => window.__sim.closeWindow('A9', 2100000));
  await new Promise((r) => setTimeout(r, 11500));
  expect(!(await calls(c.page, 'checkinPage')).some((x) => x.args[0] === 'A9'), 'checked in although the option was off');
  expect(/Window closed/.test(await text(c.page)), 'the held page does not say its window is closed');
  // …and checking it in by hand reads the file that was saved.
  await click(c.page, 'checkin', 'A9');
  expect(/A9 checked in as v5 from the file you saved/.test(await statusText(c.page)), `manual check-in: ${await statusText(c.page)}`);
  return c;
});

await scenario('rebuild one page re-reads the plan and reports the result', async () => {
  const c = await open({ persist: EDITION });
  const before = (await calls(c.page, 'getEdition')).length;
  await click(c.page, 'rebuildPage', 'A5');
  expect((await calls(c.page, 'getEdition')).length > before, 'rebuild did not re-read the edition first');
  expect(/Rebuilt A5 as v5/.test(await statusText(c.page)), `rebuild result: ${await statusText(c.page)}`);
  await click(c.page, 'toggleDetails');
  expect(/first ad: top/.test(await c.page.$eval('#status-details', (el) => el.value)), 'geometry detail missing');
  await shot(c.page, 'status-details');
  return c;
});

await scenario('rebuilding a built edition asks first', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'buildPages');
  expect(/Rebuild all 38 pages\?/.test(await text(c.page)), 'no confirmation before rebuilding everything');
  await shot(c.page, 'pages-confirm-rebuild');
  await click(c.page, 'cancelBuild');
  expect(!(await calls(c.page, 'buildEditionPages')).length, 'cancel still built');
  await click(c.page, 'buildPages');
  await click(c.page, 'confirmBuild');
  expect(/Built 38 pages/.test(await statusText(c.page)), `build result: ${await statusText(c.page)}`);
  return c;
});

await scenario('budget loads on first visit, grouped by page', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'setView', 'budget');
  const t = await text(c.page);
  expect(/52 stories on 14 pages/.test(t), `budget summary wrong: ${t.slice(0, 200)}`);
  expect(/NOT ASSIGNED TO A PAGE/i.test(t), 'unassigned group missing');
  // A load that worked is its own confirmation; the status bar stays clear.
  expect(!(await c.page.$('.status')), `a routine load posted a message: ${await statusText(c.page)}`);
  await shot(c.page, 'budget');
  return c;
});

await scenario('paginate opens the page, fronts it, then places', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'setView', 'budget');
  await click(c.page, 'paginate', 'A3');
  const ap = await calls(c.page, 'autoPaginatePage');
  expect(ap.length === 1, 'auto-paginate did not run');
  expect(ap[0].args[3] === 'wv_EXT_101726_A3.indd', `placed into the wrong document: ${ap[0].args[3]}`);
  expect((await calls(c.page, 'checkoutPage')).some((x) => x.args[0] === 'A3'), 'A3 was not opened first');
  expect(/Placed 4 of 4 stories on A3/.test(await statusText(c.page)), `paginate result: ${await statusText(c.page)}`);
  return c;
});

await scenario('a story opens into its own screen and back', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'setView', 'budget');
  await click(c.page, 'openStory', 'TESTED-story-01');
  expect(/STORY BLOCK/i.test(await text(c.page)), 'story tools not shown');
  await shot(c.page, 'budget-story');
  await click(c.page, 'placeBlock');
  expect(/Placed 4col_story_1photo_1mug/.test(await statusText(c.page)), `place block: ${await statusText(c.page)}`);
  await click(c.page, 'closeStory');
  expect(/52 stories/.test(await text(c.page)), 'back did not return to the list');
  return c;
});

await scenario('marketplace loads on first visit and places', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'setView', 'marketplace');
  const t = await text(c.page);
  expect(/Classifieds/.test(t) && /Maple Lake Dental/.test(t), 'marketplace not loaded');
  await shot(c.page, 'marketplace');
  await click(c.page, 'placeLiners', 'classifieds');
  expect(/Placed 30 classifieds/.test(await statusText(c.page)), `liners: ${await statusText(c.page)}`);
  await click(c.page, 'refreshPlacedAds');
  expect(/1 of 2 ad wells updated/.test(await statusText(c.page)), `refresh artwork: ${await statusText(c.page)}`);
  await click(c.page, 'publishPage');
  expect(/Published 2 ads/.test(await statusText(c.page)), `publish: ${await statusText(c.page)}`);
  // The latch that froze the old panel: after a SUCCESSFUL publish, buttons work.
  expect(!(await c.page.$eval(sel('placeAd', 'TESTED-ad-05'), (el) => el.hasAttribute('disabled'))), 'buttons stayed disabled after publishing');
  return c;
});

await scenario('the edition survives switching tabs', async () => {
  const c = await open({ persist: EDITION });
  for (const v of ['budget', 'marketplace', 'setup', 'pages']) await click(c.page, 'setView', v);
  expect(/Sat, Oct 17, 2026/.test(await text(c.page)), 'edition lost after switching tabs');
  expect(await c.page.$$eval('.row .cell-folio', (els) => els.length) >= 38, 'pages not back');
  return c;
});

await scenario('plan form: new edition, date picker, sections', async () => {
  const c = await open({ persist: EDITION });
  await click(c.page, 'setView', 'setup');
  await click(c.page, 'newEdition');
  expect(/New edition/.test(await text(c.page)), 'form did not open');
  await click(c.page, 'openDate');
  await shot(c.page, 'date-picker');
  await click(c.page, 'shiftMonth', '1');
  await click(c.page, 'pickDay', await c.page.$eval('[data-action="pickDay"]', (el) => el.getAttribute('data-arg')));
  await click(c.page, 'confirmDate');
  expect(!(await c.page.$('.overlay')), 'date dialog did not close');
  await click(c.page, 'addSection');
  expect(await c.page.$$eval('[data-input="typeSectionLetter"]', (els) => els.length) === 5, 'section not added');
  await shot(c.page, 'setup-form');
  await click(c.page, 'cancelForm');
  expect(/EDITIONS/i.test(await text(c.page)), 'cancel did not return to the list');
  // Editing an existing plan: the date is fixed, and the field says so.
  await click(c.page, 'selectEdition', 'EXT_101926');
  await click(c.page, 'editPlan');
  expect(/Edit plan/.test(await text(c.page)), 'edit form did not open');
  await click(c.page, 'openDate');
  await enter(c.page, 'openDate');
  expect(!(await c.page.$('.overlay')), 'the date of an existing edition could be changed');
  return c;
});

await scenario('colours follow the theme InDesign reports, with no host variables', async () => {
  // [theme, extra query, expected data-ui, expected text colour]
  const cases = [
    ['mediumlight', {}, null, 'rgb(27, 27, 27)'],            // the media query decides
    ['mediumdark', {}, null, 'rgb(242, 242, 242)'],
    // A release where no colour-scheme query matches: InDesign's brightness decides.
    ['light', { scheme: 'none', brightness: 1 }, 'light', 'rgb(27, 27, 27)'],
    ['mediumdark', { scheme: 'none', brightness: 0.5 }, 'dark', 'rgb(236, 236, 236)'],
  ];
  const errors = [];
  for (const [theme, query, ui, color] of cases) {
    const c = await open({ theme, query, persist: EDITION });
    const got = await c.page.evaluate(() => ({
      ui: document.documentElement.getAttribute('data-ui'),
      color: getComputedStyle(document.querySelector('.ctx-title')).color,
    }));
    await c.page.close();
    errors.push(...c.errors);
    expect(got.ui === ui && got.color === color,
      `${theme} ${JSON.stringify(query)}: data-ui=${got.ui}, text ${got.color}; wanted ${ui}, ${color}`);
  }
  return { errors };
});

// What is wrong with the frame right now, measured: rows of the frame that
// collapsed, content drawn over the tabs or under the footer, a tab label
// spilling out of its tab, list rows squashed below a usable height.
function frameProblems(page) {
  return page.evaluate(() => {
    const box = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
    const out = [];
    const ctx = box('.ctx');
    const tabs = box('.tabs');
    const content = box('.content');
    const below = box('.status') || box('.foot');
    if (ctx && ctx.height < 44) out.push(`the edition bar is ${Math.round(ctx.height)}px tall`);
    if (tabs && tabs.height < 30) out.push(`the tab bar is ${Math.round(tabs.height)}px tall`);
    if (tabs && content && content.top < tabs.bottom - 0.5) out.push('the content starts above the bottom of the tabs');
    if (below && content && content.bottom > below.top + 0.5) out.push('the content runs under the status bar or footer');
    for (const t of document.querySelectorAll('.tab')) {
      if (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) out.push(`the ${t.textContent.trim()} tab's label spills out`);
    }
    for (const r of document.querySelectorAll('.content .row')) {
      if (r.getBoundingClientRect().height < 30) { out.push(`a row is ${Math.round(r.getBoundingClientRect().height)}px tall`); break; }
    }
    for (const h of document.querySelectorAll('.content .section-head')) {
      if (h.getBoundingClientRect().height < 24) { out.push('a section heading is squashed'); break; }
    }
    return out;
  });
}

await scenario('the frame keeps its shape on every tab at the smallest panel size', async () => {
  // The manifest's minimum, with long lists — the case where UXP shrank the
  // tab bar to a sliver and drew the budget over it (2026-10-15).
  const c = await open({ width: 320, height: 400, persist: EDITION });
  // Fail at the first broken screen: with the content over the tabs, the next
  // click would land on the content and fail for a less useful reason.
  const check = async (where) => {
    const bad = await frameProblems(c.page);
    expect(!bad.length, `${where}: ${bad.join('; ')}`);
  };
  for (const v of ['pages', 'budget', 'marketplace', 'setup']) {
    await click(c.page, 'setView', v);
    await check(v);
  }
  await click(c.page, 'setView', 'pages');
  await click(c.page, 'openPage', 'A6');               // a checked-out page and a status message
  await check('pages, holding A6');
  await click(c.page, 'setView', 'budget');
  await click(c.page, 'openStory', 'TESTED-story-01');
  await check('a story');
  await shot(c.page, 'small-panel-story');
  return c;
});

await scenario('a click lands even when a background repaint arrives mid-click', async () => {
  const c = await open({ persist: EDITION });
  const box = await (await c.page.$(sel('setView', 'budget'))).boundingBox();
  await c.page.evaluate((s) => { document.querySelector(s).__marked = true; }, sel('setView', 'budget'));
  await c.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await c.page.mouse.down();
  // A background change between mouse-down and mouse-up — the clock tick, a
  // lock heartbeat. The old panel repainted here, replacing the tab under the
  // cursor, and the click never fired.
  await c.page.evaluate(() => window.__store.set({ now: Date.now() + 1 }));
  await new Promise((r) => setTimeout(r, 120));
  expect(await c.page.evaluate((s) => document.querySelector(s).__marked === true, sel('setView', 'budget')),
    'the panel repainted while the mouse button was down');
  await c.page.mouse.up();
  await idle(c.page);
  expect(/52 stories/.test(await text(c.page)), 'the click was lost');
  return c;
});

// ── Report ────────────────────────────────────────────────────────────

await browser.close();
server.close();

const pad = (s, n) => String(s).padEnd(n);
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${pad(r.name, 74)} ${String(r.ms).padStart(6)}ms`);
  if (!r.ok) { failed++; console.log(`    ${r.err.split('\n').join('\n    ')}`); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed${SHOTS ? ` — screenshots in ${path.relative(process.cwd(), SHOT_ROOT)}/` : ''}`);
process.exit(failed ? 1 : 0);
