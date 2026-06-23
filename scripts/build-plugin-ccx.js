// scripts/build-plugin-ccx.js
//
// Bundles plugin/wvnews-print/ into a .ccx for sideloading via Adobe
// UXP Developer Tool. A `.ccx` is just a zip archive with a specific
// internal layout (manifest.json at root, plus plugin assets).
//
// Usage:
//   node scripts/build-plugin-ccx.js [outdir]
//
// Output:
//   dist/wvnews-print-<version>.ccx
//   dist/wvnews-print-<version>.zip   (same contents — UXP Dev Tool
//                                       can import either)
//
// Note on signing: Adobe-distributed plugins (sold/free on Adobe
// Exchange) must be signed via Adobe's signing pipeline. Sideloading
// in UXP Developer Tool does NOT require signing — UXP Developer
// Tool can take this unsigned .ccx and sign it for you on the way to
// Exchange, or you can install it for in-house use as-is.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const pluginDir = path.join(repoRoot, 'plugin', 'wvnews-print');
const distDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'dist');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Sanity: required files present ─────────────────────────────────
const required = [
  'manifest.json',
  'index.html',
  'app.js',
  'auth.js',
  'api.js',
  'indesign.js',
  'config.js',
  'storage.js',
  'styles.css',
  'icons/icon-light.png',
  'icons/icon-light@2x.png',
  'icons/icon-dark.png',
  'icons/icon-dark@2x.png',
];
for (const f of required) {
  if (!fs.existsSync(path.join(pluginDir, f))) fail(`missing required file: plugin/wvnews-print/${f}`);
}

// ── Read version from manifest ─────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
const version = manifest.version || '0.0.0';
const pluginId = manifest.id || 'com.wvnews.print';
console.log(`✓ ${pluginId} v${version}`);

// ── Production-URL injection ──────────────────────────────────────
//
// If PLUGIN_SERVER_BASE is set in the env, rewrite plugin/config.js
// AND plugin/manifest.json before packaging so the shipped .ccx talks
// to the right backend AND its UXP network.domains allowlist includes
// the new host. The source tree is left untouched (we stage into a
// temp dir, zip from there). Without the env var, the build uses
// whatever is currently in source — fine for sideload + dev.
const serverBaseOverride = process.env.PLUGIN_SERVER_BASE || '';
let buildDir = pluginDir;          // default: zip the source tree directly
let tempBuildDir = null;
if (serverBaseOverride) {
  if (!/^https?:\/\//.test(serverBaseOverride)) {
    fail(`PLUGIN_SERVER_BASE must start with http:// or https:// (got "${serverBaseOverride}")`);
  }
  // Refuse to ship a build pointed at localhost — Adobe auto-rejects
  // localhost-targeting plugins.
  if (/localhost|127\.0\.0\.1/.test(serverBaseOverride)) {
    fail(`PLUGIN_SERVER_BASE points at localhost — refusing to package a build that won't work for end users.`);
  }
  // Stage everything into a sibling temp dir, rewrite the two files,
  // zip from there.
  tempBuildDir = path.join(repoRoot, '.build-plugin-tmp');
  if (fs.existsSync(tempBuildDir)) {
    fs.rmSync(tempBuildDir, { recursive: true, force: true });
  }
  fs.cpSync(pluginDir, tempBuildDir, { recursive: true });
  buildDir = tempBuildDir;

  // config.js: replace SERVER_BASE line.
  const cfgPath = path.join(buildDir, 'config.js');
  const cfgSrc = fs.readFileSync(cfgPath, 'utf8');
  const cfgNew = cfgSrc.replace(
    /SERVER_BASE:\s*['"][^'"]*['"]/,
    `SERVER_BASE: '${serverBaseOverride}'`,
  );
  if (cfgNew === cfgSrc) {
    fail(`Failed to rewrite SERVER_BASE in config.js — the file's shape may have drifted.`);
  }
  fs.writeFileSync(cfgPath, cfgNew);

  // manifest.json: ensure the prod URL's origin is in network.domains.
  // Also strip localhost (and demo placehold hosts if anyone re-adds
  // them) so the shipped manifest doesn't carry dev-only entries.
  const manPath = path.join(buildDir, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const newOrigin = new URL(serverBaseOverride).origin;
  const domains = (man?.requiredPermissions?.network?.domains) || [];
  const cleaned = domains.filter(d =>
    !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(d) &&
    !/placehold\.(co|com)$/.test(d)
  );
  if (!cleaned.includes(newOrigin)) cleaned.push(newOrigin);
  man.requiredPermissions.network.domains = cleaned;
  // Tighten launchProcess to https only (already done in source, but
  // belt-and-suspenders for a release build).
  if (man.requiredPermissions.launchProcess) {
    man.requiredPermissions.launchProcess.schemes = ['https'];
  }
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');

  console.log(`✓ Injected SERVER_BASE = ${serverBaseOverride}`);
  console.log(`✓ network.domains = [${cleaned.join(', ')}]`);
} else {
  console.log(`ℹ Building from source tree (SERVER_BASE stays as-is in config.js).`);
  console.log(`  For a release build, set PLUGIN_SERVER_BASE=https://wvnews.com.`);
}

// ── Prepare output ─────────────────────────────────────────────────
fs.mkdirSync(distDir, { recursive: true });
const stem = `wvnews-print-${version}`;
const ccxOut = path.join(distDir, `${stem}.ccx`);
const zipOut = path.join(distDir, `${stem}.zip`);
for (const f of [ccxOut, zipOut]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ── Files to bundle (everything under pluginDir except README + .DS_Store) ──
const includeGlob = [
  'manifest.json',
  'index.html',
  'app.js',
  'auth.js',
  'api.js',
  'indesign.js',
  'config.js',
  'storage.js',
  'styles.css',
  'icons',
];
const excludePatterns = ['README.md', '.DS_Store', '*.log'];

// Use system `zip` for reliability. It's available on macOS + Linux
// out of the box; on Windows the user is expected to use UXP Developer
// Tool's built-in packaging instead.
const zipBin = which('zip');
if (!zipBin) fail('`zip` not found on PATH — use UXP Developer Tool to package instead');

const args = [
  '-r', '-X', '-q',          // recurse, no extra attrs, quiet
  zipOut,
  ...includeGlob,
];
for (const pat of excludePatterns) {
  args.push('-x', `*/${pat}`, '-x', pat);
}
const result = spawnSync(zipBin, args, { cwd: buildDir, stdio: 'inherit' });
if (result.status !== 0) fail(`zip exited with status ${result.status}`);

// ── Clean up the staged temp dir (if we built one) ─────────────────
if (tempBuildDir && fs.existsSync(tempBuildDir)) {
  fs.rmSync(tempBuildDir, { recursive: true, force: true });
}

// ── Duplicate the zip as .ccx (same bytes, different extension) ─────
fs.copyFileSync(zipOut, ccxOut);

// ── Report ─────────────────────────────────────────────────────────
const ccxSize = fs.statSync(ccxOut).size;
const sizeKb = (ccxSize / 1024).toFixed(1);
console.log(`✓ Wrote ${path.relative(repoRoot, ccxOut)} (${sizeKb} KB)`);
console.log(`✓ Wrote ${path.relative(repoRoot, zipOut)} (${sizeKb} KB)`);
console.log('');
console.log('Next steps:');
console.log('  Sideload: drop the .ccx into Adobe UXP Developer Tool → Add Plugin');
console.log('  Distribute: re-package with UXP Developer Tool to add Adobe signature');

function which(cmd) {
  try {
    return execSync(`command -v ${cmd}`).toString().trim() || null;
  } catch {
    return null;
  }
}
