# WVNews Print — Adobe InDesign UXP plugin

The layout-artist plugin for the WV News print-production platform. Artists sign in, pick an edition, and the plugin builds each newspaper page — placing the page snippet over the master template and flowing budget stories, classifieds, legals, obituaries, and photos into labeled frames, then checks each page in to the platform (Firebase Storage).

- Host: **Adobe InDesign** (`manifestVersion: 5`, min InDesign 18.0 / 2023), single dockable panel.
- Auth: out-of-band **PKCE OAuth** against the platform (`/api/plugin/oauth/*`); tokens stored in the OS keychain via UXP secure storage. No third-party trackers.
- Talks only to the platform API + Firebase Storage.

## Layout

```
plugin/wvnews-print/      the plugin source (manifest.json, app.js, indesign.js, api.js, auth.js, …)
scripts/build-plugin-ccx.js   packages the plugin into a .ccx
scripts/gen-plugin-icons.js   regenerates panel icons
```

## Install the plugin on a machine

In UXP: **Add Plugin → select `plugin/wvnews-print/manifest.json` → Load.**

That is the whole procedure, on your machine and on anyone else's. No
packaging and no signing: the folder is self-contained, and **Reload** picks
up a `git pull`. To put it on a machine without the repo, copy
`plugin/wvnews-print/` across and load the `manifest.json` there.

## Build a .ccx

A `.ccx` is the **distribution** package, for Adobe Exchange and Creative
Cloud, and Adobe must **sign** it before it can be installed anywhere.
**UXP does not open a `.ccx` — it builds one.** It is not how you sideload.

```bash
PLUGIN_SERVER_BASE=https://staging.wvnews.com node scripts/build-plugin-ccx.js
# → dist/wvnews-print-<version>.ccx   (for Adobe signing, not for sideloading)
```

`config.js` defaults `SERVER_BASE` to the dev server; the build script rewrites it to the injected `PLUGIN_SERVER_BASE`, strips `localhost` from the manifest, and locks `launchProcess` to `https`. Use `https://wvnews.com` for production builds.

## Key features

- **Build Pages** → opens the template, places the snippet, flows assigned content, and **checks each page in to the website** as a new version (not a local volume).
- **Marketplace tab** — pull + place classifieds / legals / obits into a selected frame (classifieds grouped by category with text headers).
- **Editions** — list/create editions, check pages out/in, per-page lock badges, Refresh.
- Story jump/continuation, auto-columns, combined caption+credit, per-paragraph styling.

## Notes

- The server side lives in the platform repo (`bjarvis-lab/wvnews-platform`); this repo is just the plugin client.
- `dist/` and `node_modules/` are git-ignored.
