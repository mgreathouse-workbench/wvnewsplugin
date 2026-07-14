// Plugin runtime config.
//
// SERVER_BASE points at the platform's API. The default is the local
// dev server so the plugin works against `npm run dev` out of the box.
// For a production build, `scripts/build-plugin-ccx.js` overwrites the
// SERVER_BASE line at package-time via the PLUGIN_SERVER_BASE env var:
//
//   PLUGIN_SERVER_BASE=https://wvnews.com node scripts/build-plugin-ccx.js
//
// The build script also adds the prod hostname to the manifest's
// `network.domains` allowlist if it isn't already there. Result: the
// shipped .ccx talks to prod, the source tree stays dev-friendly.
//
// Adobe rejects plugins that target localhost — so make sure the
// PLUGIN_SERVER_BASE override is applied to any .ccx submitted for
// review.
const CONFIG = {
  SERVER_BASE: 'https://staging.wvnews.com',
  CLIENT_ID:   'wvnews-print',
  OOB_REDIRECT: 'urn:ietf:wg:oauth:2.0:oob',
};

module.exports = { CONFIG };
