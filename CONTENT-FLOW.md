# Content flow — wiring real stories/classifieds/obits/legals into the plugin

_Added 2026-06-18. Connects the print module's content endpoints to the colleague's real Firestore collections so editorial content flows into InDesign. Ads deferred by decision._

## What now flows (production / non-demo path)

| Kind | Source collection (his repo) | How it's selected for an edition |
|---|---|---|
| **Story** | `stories` | `includeInPrintBudget == true` AND `editionDate == <date>` AND (`sites` contains site OR `printSiteId == site`). Per-pub `printCuts[siteId]` overlay applied (alt headline/body/page). |
| **Classified** | `print_classifieds_queue` | `status in [queued, in-layout]` AND `paperSlug == siteId`. |
| **Obituary** | `print_obits_queue` | `status in [queued, in-layout]` AND `targetEditions` contains siteId. |
| **Legal** | `legals` | `status == 'Published'` AND `targetPublications`/`publicationIds` contains siteId AND edition date within `startDate..endDate`. |
| **Display ad** | `orders` | **Deferred** — `order` kind returns 501; the ad-desk workflow for slating ads to an edition/size is undecided. |

## Files changed (already in the tarball)

1. **`src/app/api/print/budget/[siteId]/[date]/route.js`** — `loadAssets()` now merges stories + classifieds + obits + legals (was stories-only). New helpers `loadQueueKind()` and `loadLegals()`. Each non-story query is wrapped so a missing collection/index can't break the whole budget feed.
2. **`src/app/api/print/editions/[id]/asset/[kind]/[assetId]/route.js`** — the production path was a `501 "not implemented"` stub; now reads `stories` / `print_classifieds_queue` / `print_obits_queue` / `legals` and returns the per-kind content the plugin flows. Stories apply `printCuts[edition.siteId]`.
3. **`plugin/wvnews-print/indesign.js`** — added `placeObituaryAsset` + `placeLegalAsset` (the build loop previously logged `kind not yet wired` and skipped them) and routed `obituary`/`legal` to them.

## ⚠️ New snippet frame labels designers must add

Obits and legals flow as text blocks, like classifieds. The plugin looks for these Script Labels (falling back to `classified-body` if absent):

- **`obituary-body`** — receives name + city + obituary text + funeral info.
- **`legal-body`** — receives the notice title + legal text.

Add these labels on the relevant snippet frames, same way `classified-body` / `story-N` / `headline-N` are labeled today.

## How to verify (requires real Firestore — NOT demo mode)

This path reads the colleague's live collections, so it can only be exercised against his Firebase (staging or a scratch project), not the main-2 demo bed. Demo mode is unchanged and still uses `print-demo.js`.

1. In his repo with the module integrated, create a print edition for a `(siteId, date)` that has real content.
2. `GET /api/print/budget/<siteId>/<date>` → assets array should now include `assetType` values `story`, `classified`, `obituary`, `legal`.
3. Assign one of each kind to a page in the edition editor.
4. `GET /api/print/editions/<id>/asset/<kind>/<id>` for each → returns content (200), not 501.
5. In the plugin, Build Pages → story flows into `story-N`/`headline-N`/`body-N`, classified into `classified-body`, obit into `obituary-body`, legal into `legal-body`.

## Notes / follow-ups

- **No new shared-file merges.** The endpoints query his collections directly by name (like the existing story query already did), so they don't depend on his `*-db.js` lib signatures — only that the collections exist (they do).
- **Story selection via cut-only pubDate not covered.** A story slated for this paper *only* through `printCuts[siteId].pubDate` (with a different top-level `editionDate`) won't appear — the query matches top-level `editionDate`. Matches the module's prior behavior; revisit if editors rely on cut-only dates.
- **Legals now have extra statuses.** Main added `'Running'`/`'Completed'` to the legals lifecycle (commit 7e9d794). `loadLegals` filters `status == 'Published'`, which matches the platform's own `listPublishedLegals()` and is still correct. If the print workflow later treats `'Running'` as "live in this edition," widen the filter to include it.
- **Ads** — when ready, implement the `order` branch in both routes + (already-present) `placeOrderAsset`, once the ad→edition/size slating rule is decided.
