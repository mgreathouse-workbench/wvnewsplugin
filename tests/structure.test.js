// Rules about how the panel's modules fit together, checked statically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', 'plugin', 'wvnews-print');
const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
const jsIn = (dir) => fs.readdirSync(path.join(PLUGIN, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);

// UXP resolves require() relative to index.html, not to the file calling it.
// A module in ui/ that required './format.js' would load fine in Node and
// fail inside InDesign. So only app.js — at the root, beside index.html —
// requires local modules, and hands them to everything else.
test('nothing under ui/, features/ or views/ calls require()', () => {
  const offenders = [...jsIn('ui'), ...jsIn('features'), ...jsIn('views')]
    .filter((f) => /\brequire\s*\(/.test(read(f)));
  assert.deepEqual(offenders, []);
});

test('every local module app.js requires exists', () => {
  const missing = [...read('app.js').matchAll(/require\('(\.\/[^']+)'\)/g)]
    .map((m) => m[1])
    .filter((rel) => !fs.existsSync(path.join(PLUGIN, rel)));
  assert.deepEqual(missing, []);
});

// InDesign does not provide the --uxp-host-* colour variables (Adobe, on the
// UXP developer forum), so the stylesheet must not depend on them.
test('the stylesheet does not depend on host colour variables', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/var\(--uxp-host/.test(css), false);
});
