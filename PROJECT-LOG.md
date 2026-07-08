# WVNews Print plugin — project log

_Working record of the print-pagination build, so context lives with the repo. Last updated 2026-07-08._

---

## What this is

`wvnews-print` is the Adobe InDesign UXP plugin layout artists use to build newspaper pages for the WV News print platform: sign in → pick an edition → it places the page snippet over the master template, flows budget content (stories, classifieds, legals, obits, photos) into labeled frames, and **checks each finished page back into the website** (Firebase Storage).

The plugin is the **client**. The server lives in the platform repo (`bjarvis-lab/wvnews-platform`).

---

## Where everything lives (git)

| Repo / folder | Remote | Role |
|---|---|---|
| `~/Downloads/wvnewsplugin` (this repo) | `mgreathouse-workbench/wvnewsplugin` (public) | **Plugin source of truth.** Edit here, push. |
| `~/Downloads/wvnews-platform` | `bjarvis-lab/wvnews-platform` (Brian's, pull-only) | Server/platform working copy. Has its own `plugin/wvnews-print/` copy (his staging config). |

- The `brian-handoff` branch of this repo holds the hand-off package (the patch + `.ccx` + docs) we gave Brian.
- The old `wvnews-platform-main 2` zip and the scratch hand-off folders were retired/trashed once Brian merged — everything is captured in the two repos above.

**Rule of thumb:** edit the plugin in `wvnewsplugin`; if a plugin change must also ship in Brian's platform, send it to his repo via PR/patch (his repo has its own copy with staging `SERVER_BASE`).

---

## Dev / build workflow

The plugin = the source files in `plugin/wvnews-print/` (`app.js` UI, `indesign.js` engine, `api.js` fetch wrapper, `auth.js`/`storage.js`, `config.js`, `manifest.json`, `index.html`, `styles.css`, `icons/`, `assets/`).

The `.ccx` is a **build artifact**, never edited directly:

```
plugin/wvnews-print/  --(node scripts/build-plugin-ccx.js)-->  dist/wvnews-print-<ver>.ccx
```

- `config.js` defaults `SERVER_BASE` to the localhost dev server; the build script rewrites it via `PLUGIN_SERVER_BASE` and strips localhost from the manifest.
- Staging build: `PLUGIN_SERVER_BASE=https://staging.wvnews.com node scripts/build-plugin-ccx.js`
- Production build: `PLUGIN_SERVER_BASE=https://wvnews.com node scripts/build-plugin-ccx.js`
- Sideload the `.ccx` via Adobe UXP Developer Tool → Add Plugin. **UXP does not hot-reload** — unload + re-add after a rebuild.

---

## What was built this round (all MERGED to Brian's main, commit `57a1572`)

**Server (in the platform repo):**
- **Content flow** — real stories/classifieds/obits/legals content now served to the plugin (the asset endpoint was a 501 stub before).
- **Budget→edition bridge** — `POST /api/print/editions/[id]/sync-budget` + a **"Sync from budget"** button in the edition editor. Auto-seeds each page's `assets` from editorial assignments: stories from `pageAssignment` (+`printCuts`), classifieds/obits/legals from `autopagePage`. Normalizes `A-1`→`A1`, additive merge, reports unmatched.
- **Marketplace endpoint** — `GET /api/print/marketplace/[siteId]/[kind]` (classifieds|legals|obits) for the plugin's Marketplace tab.
- **Plugin-create-editions** — relaxed the `POST /api/print/editions` guard so artists can create editions from the panel. (Delete/upload/break-lock stay web-admin-only.)

**Plugin (this repo):**
- **Build Pages → website** — each built page is checked in to Firebase Storage as a new version, instead of saving `.indd` files to a local TCMS volume.
- **Marketplace tab** (Budget · Editions · **Marketplace**) — pull + place classifieds/legals/obits into the selected text frame; classifieds grouped by category with text headers.
- **Editions Refresh button**, **obituary/legal placement handlers**, **classifieds grouped-by-category** section.

**Deliberately NOT shipped to Brian:** `config.js` + `manifest.json` (his staging `SERVER_BASE` / dropped-localhost are intentional and must stay).

---

## Current status

- Brian merged everything (commit `57a1572`); Vercel deployed to **staging.wvnews.com**.
- The staging `.ccx` (built against staging) is on the `brian-handoff` branch and was given to Brian for pilot distribution.

## Steps still on Brian / the team

1. **Grant `printlayout` to the pilot designer's account** — the plugin checks `hasPermission(profile,'printlayout')`. Gotcha: accounts with an explicit `permissions` array don't pick up role-default grants — add the module directly in `/admin/users` (or re-select the role).
2. **Snippet frame labels** — designers must add `obituary-body` and `legal-body` (and ensure `classified-body`) to the relevant snippets, or those kinds silently don't place.
3. **Real-Firestore smoke test** on staging (create edition → publish a classified to print → Sync from budget → Build Pages → confirm check-in).
4. **Distribute the `.ccx`** (sideload / upload on Print Layout → Plugin Releases). **Production cutover later:** rebuild the `.ccx` against `wvnews.com`.

---

## Deferred / not yet built

- Classifieds **category graphics** (the "WHEELS"-style art) — needs the actual asset files; text headers are in for now.
- **True multi-column** classifieds section flow (v1 places grouped text into one frame).
- **Finer classified subcategories** (Auto/Motorcycles vs the flat "Vehicles") — would need a new subcategory field on the platform's classifieds.
- The budget→edition bridge's auto-seed of **section-named/free-text folios** (e.g. "Opinion", "Sports-1") — currently reported as unmatched; could add an alias map.
- Fix the stale "Delete edition" helper text (it says built files aren't touched; they are now).

---

## Key conventions & gotchas

- **Folio notation differs:** editorial uses `A-1` (hyphen); InDesign editions use `A1`. The bridge normalizes between them.
- **Two page-assignment fields:** stories → `pageAssignment` (print-budget sheet); classifieds/legals/obits → `autopagePage` (`/admin/autopage`).
- **Classifieds only reach print** when **Published with a specific target paper** (the publish action writes `print_classifieds_queue`). The `wv-news` umbrella is dropped — must target a member paper. The plugin filters `paperSlug == siteId`, so the publication selected in the plugin must match.
- **Classified categories** are the flat 13-item list, editable at `/admin/pricing → Classifieds → Categories` (Firestore-backed). Print headers group by that same list.
- **Plugin tokens** are least-privilege: can read + check-out/in + (now) create editions; cannot delete editions, manage snippets/templates, or break locks.

---

## Print data model — dates & publications per content type (2026-07-08 survey)

Full survey of what date + publication data exists on each content type, and **what the marketplace API actually exposes to the plugin** vs. what only lives on the source doc. The plugin's feed is `GET /api/print/marketplace/[siteId]/[kind]`.

**Only 3 of 5 kinds are served today:** `classifieds`, `legals`, `obits`. **Ad orders and news stories are NOT in the API** — yet they carry the richest print scheduling metadata.

### Run / edition date (most important for print)

| Type | Run date? | Field(s) | Exposed / usable by plugin |
|---|---|---|---|
| **Legals** | ✅ computed | `firstRunDate` + `runsReq` → `nextLegalRunDates()` (one/week statutory); optional explicit `runDates[]` | **Server-side date filter via `?date=`** (dates not sent, but filtering works end-to-end) |
| **Obits** | ✅ editorial | `printRunDate` (source, YYYY-MM-DD) | ❌ ignored — obits filter only by `targetEditions`, run date not sent or filtered |
| **Ad orders** | ✅ explicit | `runDates[]` or `startDate`/`endDate` | ❌ orders not in API |
| **News stories** | ✅ explicit | `editionDate` (YYYY-MM-DD); per-cut `printCuts[site].pubDate` | ❌ news not in API |
| **Classifieds** | ❌ none pre-print | `weeks` + `createdAt`/`publishedAt` (compute); `printedRunDate` set only AFTER placement | ❌ no dates sent |

→ Legals are the only type where date-driven availability works today. Classifieds have no real run date (start + weeks only).

### Publication / paper — THREE coexisting ID schemes (normalize before cross-type work)

- **Site slugs (print queues):** `exponent-telegram`, `your-bulletin-board`, `wv-news` — classifieds/legals/obits.
- **Site slugs (news stories):** `exponent`, `theet`, `morgantown` — **different from the queue slugs! ⚠️**
- **Canonical `publicationId`** (orders `print.publicationId`) and **legacy numeric `paper` 0–20** (`getPublicationByNumericIndex()`).
- `wv-news` is the online-only umbrella everywhere; never a print run.

Fields: classifieds/legals `targetPublications[]` + `publicationIds[]`; obits `targetEditions[]`; orders `print.publicationId` / `print.paper`; stories `sites[]` / `printSiteId` / `printCutSites[]`.

### Content fields the plugin receives (per kind)

- **Classifieds** (exposed): `category`, `headline` (bold lead-in), `text`, `body`, `phone`, `city`.
- **Legals** (exposed): `title`, `noticeType`, `text` (plain) + `richText[]` (bold/italic/underline/align), `columnCount` (1–4), `border`. Best-formatted feed.
- **Obits** (exposed): `name`, `city`, `dob`, `dod`, `text` (HTML→plain), `funeral`. No photo / no rich text sent (though `photoUrl`/`photoUrls` exist on doc).
- **Ad orders** (on doc, NOT exposed): `print.sz`, `print.sec`, `print.color`, `print.adCopy`, `print.artworkStatus`, `print.autopagePage`/`Position`, artwork URLs.
- **News stories** (on doc, NOT exposed): `pageAssignment`, `printSection`, `printBody` vs `webBody`, `printCuts[site].{headline,deck,body,byline,dateline,pageAssignment}`, `coordination`, `processStatus`.

### E-edition model (print output side)
`eeditions` collection keyed **`{siteId}_{YYYY-MM-DD}`** via `getEdition(siteId, dateKey)` → `{ pdfUrl, thumbnailUrl, pages, status }`. Natural key to align to: **(publication, edition date)**.

### Build-out order if extending the feed
1. Legals — already complete.
2. Obits — small server change: honor `printRunDate` (filter + expose).
3. Classifieds — denormalize a computed run date (`startDate` + `weeks` + paper schedule) so they're edition-filterable.
4. Ad orders & news stories — the big one: add `orders`/`stories` kinds to the marketplace endpoint with their `print.*` / `editionDate`+`printCuts` metadata.
5. Normalize paper IDs first (`exponent` vs `exponent-telegram`) or cross-type pulls silently miss.

---

## Quick start to pick this back up

```bash
cd ~/Downloads/wvnewsplugin && git pull          # latest plugin source
# edit plugin/wvnews-print/*.js
PLUGIN_SERVER_BASE=https://staging.wvnews.com node scripts/build-plugin-ccx.js
# sideload dist/wvnews-print-0.1.0.ccx in UXP Developer Tool
git add -A && git commit -m "..." && git push     # back to your GitHub
# if it should ship to the platform too: PR/patch into bjarvis-lab/wvnews-platform
```
