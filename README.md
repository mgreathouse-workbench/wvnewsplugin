# WVNews Print — Adobe InDesign UXP plugin

The layout-artist plugin for the WV News print-production platform. Artists sign in, pick an edition, and the plugin builds each newspaper page — placing the page snippet over the master template and flowing budget stories, classifieds, legals, obituaries, and photos into labeled frames, then checks each page in to the platform (Firebase Storage).

- Host: **Adobe InDesign** (`manifestVersion: 5`, min InDesign 18.0 / 2023), single dockable panel.
- Auth: out-of-band **PKCE OAuth** against the platform (`/api/plugin/oauth/*`); tokens stored in the OS keychain via UXP secure storage. No third-party trackers.
- Talks only to the platform API + Firebase Storage.

## Layout

```
plugin/wvnews-print/          the plugin source — see its README for the module map
scripts/build-plugin-ccx.js   packages the plugin into a .ccx
scripts/gen-plugin-icons.js   regenerates panel icons
tests/                        unit tests (node:test, no InDesign needed)
dev/                          the panel in Chrome: preview server, fakes, smoke tests
```

## Develop

```bash
npm install          # dev tools only; the plugin itself has no dependencies
npm run lint         # ESLint, errors only (lint:all shows warnings too)
npm test             # unit tests: the InDesign bridge's document lookups, the
                     # action runner, templating, theming, module rules
npm run test:ui      # the real panel in headless Chrome against fake InDesign
                     # and website, driven with real mouse clicks (~1.5 min)
npm run preview      # the same panel at http://localhost:4747/dev/preview/
```

`test:ui` needs Google Chrome installed (`CHROME_PATH` overrides the macOS
default). Add `-- --shots` to write a screenshot of each screen to
`dev/screenshots/<theme>/`, and set `THEME=dark|mediumdark|mediumlight|light`
for InDesign's other colour themes.

The preview runs the panel's own code unchanged; only InDesign, the website
and sign-in are faked (`dev/preview/fixtures.js`). Spectrum widgets are
approximated in Chrome, so it is right about behaviour and layout and close —
not exact — about how the widgets look. Check visual changes in InDesign.

## Build a .ccx

```bash
PLUGIN_SERVER_BASE=https://staging.wvnews.com node scripts/build-plugin-ccx.js
# → dist/wvnews-print-<version>.ccx   (sideload via Adobe UXP Developer Tool → Add Plugin)
```

`config.js` defaults `SERVER_BASE` to the dev server; the build script rewrites it to the injected `PLUGIN_SERVER_BASE`, strips `localhost` from the manifest, and locks `launchProcess` to `https`. Use `https://wvnews.com` for production builds.

## Key features

- **Build Pages** → opens the template, places the snippet, flows assigned content, and **checks each page in to the website** as a new version (not a local volume).
- **Marketplace tab** — pull + place classifieds / legals / obits into a selected frame (classifieds grouped by category with text headers).
- **One edition as context, four tabs** — Pages (check out/in, rebuild, automatic check-in when a page's window closes), Budget (auto-paginate per page, story tools), Marketplace (liners and display ads), Setup (editions and their plans).
- Story jump/continuation, auto-columns, combined caption+credit, per-paragraph styling.

## Notes

- The server side lives in the platform repo (`bjarvis-lab/wvnews-platform`); this repo is just the plugin client.
- `dist/` and `node_modules/` are git-ignored.
