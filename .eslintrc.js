// Static analysis for the plugin. There was none until 2026-10-12.
//
// 9,170 lines of JavaScript with no linter, including indesign.js at 5,108
// lines — the file that drives the InDesign DOM and, per docs/print-layout-
// status.md, has never had a single DOM call executed. Checking it with
// `node --check` catches a missing brace and nothing else: not an undefined
// variable, not a typo'd property, not a duplicate key. Those are exactly the
// three bugs that reached production in the platform before it had a working
// lint of its own.
//
// ── `env` is load-bearing ───────────────────────────────────────────
//
// Without it, no-undef flags Set, Map, Promise and every other builtin, and
// 900 lines of noise buries the handful of real findings. Same lesson as the
// platform's .eslintrc.json.
//
//   commonjs  the plugin is require()/module.exports — UXP has no bundler
//   browser   app.js drives the panel's DOM (index.html)
//   es2022    async/await, optional chaining, ?? — all used throughout
//
// JS rather than JSON so this reasoning can live next to the config. ESLint 8
// loads .eslintrc.js the same way.
module.exports = {
  root: true,
  env: {
    browser: true,
    commonjs: true,
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  extends: 'eslint:recommended',
  rules: {
    // Warnings, not errors: the point of turning the lint on is to find the
    // CORRECTNESS problems (no-undef, no-dupe-keys, no-dupe-class-members),
    // and failing the gate on tidiness would mean nobody runs it. `npm run
    // lint` is --quiet, so it reports errors only.
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // The plugin is full of `try { … } catch (e) {}` around InDesign DOM
    // calls that legitimately throw when a property is unsupported on a given
    // object — that is the idiom, not an oversight.
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-console': 'off',
    // OFF because the rule is wrong for this code, not to make the gate green.
    //
    // It flags `function` declared inside a block, which mattered in ES5 where
    // the behaviour was implementation-defined. All three hits in indesign.js
    // are closures over local state — makeTextFrame/makeImageFrame close over
    // `y`, `page` and `created` while walking a page top to bottom. Moving them
    // to the function root as the rule asks would break them.
    'no-inner-declarations': 'off',
  },
  ignorePatterns: ['dist/', 'node_modules/', '.build-plugin-tmp/'],
};
