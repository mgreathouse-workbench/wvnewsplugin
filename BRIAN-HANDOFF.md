# Print-module update — for Brian

Two things in this folder:
1. **`print-module-up-to-date.patch`** — the code (server + plugin source), 7 files, +617/−77. `git apply --check` clean on `main`.
2. **`wvnews-print-0.1.0.ccx`** — the prebuilt plugin installer, pointed at **staging.wvnews.com**, for designers to sideload (no build step needed).

## 1) Apply the code patch + deploy

```bash
git checkout -b print/update main
git apply "print-module-up-to-date.patch"
npm run build      # surfaces any issue; print routes are dynamic
# deploy to staging
```

## 2) Install the plugin (.ccx)

`wvnews-print-0.1.0.ccx` is built against **https://staging.wvnews.com** — hand it to a pilot designer to **sideload via Adobe UXP Developer Tool → Add Plugin**, or upload it on the admin **Print Layout → Plugin Releases** page so others can download it. The Marketplace tab + "Sync from budget" need the patched **server deployed to staging** (step 1) or they'll 404.

**For production:** rebuild the .ccx from the patched plugin source —
`PLUGIN_SERVER_BASE=https://wvnews.com node scripts/build-plugin-ccx.js` — and distribute that instead.

## What it adds

**Server (new endpoints — must be deployed for the plugin features to work):**
- `POST /api/print/editions/[id]/sync-budget` + a **"Sync from budget"** button in the edition editor — auto-seeds each page's `assets` from editorial assignments (stories ← `pageAssignment`/`printCuts`; classifieds/obits ← `autopagePage`; legals ← `legals.autopagePage`). Normalizes `A-1`→`A1`, additive merge (deduped, never clobbers manual assignments), skips checked-out folios, reports unmatched.
- `GET /api/print/marketplace/[siteId]/[kind]` (classifieds|legals|obits) — backs the plugin's new Marketplace tab.
- **Plugin tokens may now create editions** — relaxed the `POST /api/print/editions` guard (was 403 "Plugin tokens cannot create publications"). Layout artists can build an edition from the InDesign panel's "New Edition" form. Delete-edition, snippet/template upload, and break-lock stay web-admin-only.

**Plugin (`plugin/wvnews-print/*.js` — keeps your repo's plugin copy current; the running build is the sideloaded .ccx):**
- Build Pages now **checks pages in to the website** (Firebase Storage versions) instead of writing to a local TCMS folder.
- New **Marketplace tab** — pull + place classifieds/legals/obits into a selected frame; classifieds grouped by category with **text headers** (graphics later).
- **Refresh** button on Editions; obituary/legal placement handlers; classifieds grouped section.

## Intentionally EXCLUDED (do not want to overwrite your config)
- `plugin/wvnews-print/config.js` — keeps your `SERVER_BASE=https://staging.wvnews.com` default.
- `plugin/wvnews-print/manifest.json` — keeps `localhost` dropped from `network.domains`.

The patch touches neither; your staging/prod plugin config stays as you set it.

## Notes
- All endpoints are `force-dynamic`; no new npm deps.
- **Needs a real-Firestore run** (staging) — not locally testable. The sync-budget + marketplace queries read `stories` / `print_classifieds_queue` / `print_obits_queue` / `legals` (+ source-doc `autopagePage` joins).
- The bridge's merge is **additive** (re-sync adds new assignments; it doesn't remove ones de-assigned since the last sync).
- Still deferred (not in this patch): the WHEELS-style category graphics, true multi-column classifieds flow, finer classified subcategories, and the stale Delete-edition helper text (`DEFERRED-FIXES.md`).

## Already in `main` (no action)
- The content-flow follow-up (story/classified/obit/legal content fetch) — merged earlier.

---
_Complete hand-off: apply `print-module-up-to-date.patch` + install `wvnews-print-0.1.0.ccx`. `CONTENT-FLOW.md` covers the new `obituary-body`/`legal-body` snippet frame labels; `DEFERRED-FIXES.md` lists what's intentionally NOT included._
