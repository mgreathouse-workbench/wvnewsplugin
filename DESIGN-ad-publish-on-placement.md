# Design: Publish display ads by placing them in InDesign

**Status:** Proposed — blocked on upstream work (see §7)
**Date:** 2026-07-10
**Owner:** Michael Greathouse
**Repos touched:** `bjarvis-lab/wvnews-platform` (API + state machine), `mgreathouse-workbench/wvnewsplugin` (UXP plugin)

---

## 1. Concept

Let the InDesign plugin be the thing that marks a display ad **Published**.

Today an ad's adboard state (`/admin/adboard`) only reaches **Published** when a
human clicks the "→ Published" button. A `publish-scheduled` cron exists but only
publishes *stories*, never *orders* — the state-machine comment in
`ad-board.js` that says "cron flips when run date passes" is aspirational for ads.

The proposal: the plugin pulls **Scheduled** ads, the operator places the
print-ready artwork on a page, and an explicit **"Publish Page"** action flips
those ads to **Published** — stamping exactly where each one ran.

### Why this is the right signal (vs. a date-based cron)
"Published" for a print ad should mean *it physically made it onto a page that
shipped*. A scheduled run date only *predicts* that; a saved layout with the ad
on it *proves* it. This makes the board's Published column reflect ground truth
and gives free reconciliation data (which ad ran on which page of which edition).

---

## 2. Locked design decisions

| # | Decision | Choice | Implication |
|---|----------|--------|-------------|
| 1 | **Trigger** — when does an ad flip to Published? | **Explicit "Publish Page" button** in the plugin | Placement records happen on drop; the *state flip* is a separate, deliberate action. Operator can lay out / rearrange freely, then commit the page. |
| 2 | **Source column** — what does the plugin pull? | **Scheduled only** | A rep must move the ad `approved → scheduled` first. The Scheduled column becomes the "ready to place" queue. |
| 3 | **Un-publish** — ad removed before print? | **Revert to Scheduled** | Deleting the placement flips the order `published → scheduled`. Requires making `published → scheduled` a legal transition. Board never shows a Published ad that isn't on a page. |
| 4 | **Artwork** — what gets placed? | **Print-ready source file** (`production.sourceFiles`) | Place the high-res designer artwork, not the customer web proof. Gate on the proof being approved. |

---

## 3. The flow

```
Rep (adboard)         Plugin (InDesign)                    Platform API
────────────          ─────────────────                    ────────────
approved
   │  click "Schedule"
   ▼
scheduled ──────────▶ appears in marketplace panel  ◀────  GET marketplace ?kind=ads
                      (Scheduled only, color-gated)         (state==scheduled, for pub)
                          │
                          │ operator drops print-ready
                          │ source onto the page
                          ▼
                      PUT /print/placements  ─────────────▶ record page/edition/frame
                          │                                  (asset marked 'placed')
                          │ operator clicks "Publish Page"
                          ▼
                      POST /print/ads/publish ────────────▶ scheduled → PUBLISHED
                                                             (idempotent)
                          │ (later) ad removed from page
                          ▼
                      DELETE /print/placements ───────────▶ published → scheduled
```

---

## 4. How it maps onto existing infrastructure

This is mostly **reuse**, not green-field:

- **`PUT /api/print/placements`** already exists and the plugin already calls it
  on every drop. It records "asset X on page Y in doc Z, frame F," is idempotent
  (id = assetId + editionDate + page), and **already has a state side-effect**
  (advances a *story's* `processStatus` to `'placed'`). We extend the same
  mechanism to orders.
- **Marketplace API** (`/api/print/marketplace/[siteId]/[kind]`) already serves
  `classifieds | legals | obits`. We add an `ads` kind. (Reference:
  `KINDS = new Set(['classifieds','legals','obits'])`.)
- **Plugin auth** is solved: `authorize(request, 'printlayout')` verifies the
  plugin OAuth/PKCE token (`plugin-oauth.js`) — the plugin already authenticates
  to every `/api/print/*` route.
- **`color-placement.js`** (already built in the plugin) gates which ads are
  offered — color ads only on FC folios.

---

## 5. What to build (once unblocked)

### Platform (`wvnews-platform`)
1. **Ads marketplace feed** — add `ads` to the marketplace `KINDS`. Return orders
   where `production.state == 'scheduled'` for the site, with: source-file URL,
   size code + resolved dimensions, advertiser, order id. Apply color-placement
   gating server-side or expose the color flag for the plugin to gate.
2. **Publish endpoint** — `POST /api/print/ads/publish` (plugin-token auth).
   Body: list of order ids (or a page/edition). For each: `transitionState(id,
   { to: 'published' })`, idempotent (no-op if already published).
3. **Revert hook** — placement `DELETE` side-effect for orders → `transitionState(id,
   { to: 'scheduled' })`. Add `'scheduled'` to `TRANSITIONS['published']` in
   `ad-board.js` (currently `published: []`).
4. **Placement PUT** — extend to accept order assets (today it's story-centric)
   and record them without flipping state (state flip is the explicit button).

### Plugin (`wvnewsplugin`)
1. **Ads in the marketplace panel** — new `ads` source, Scheduled only, place
   print-ready source into a frame sized from the ad's dimensions.
2. **"Publish Page" button** — gather the ad orders placed on the active page/
   spread, POST them to the publish endpoint, reflect success in the panel.
3. **Color gating** — reuse `color-placement.js` so color ads only offer on FC
   folios of the current edition.

---

## 6. Data notes / smaller confirmations

- **Which artwork:** `production.sourceFiles[]` (designer uploads via
  `/api/admin/adboard/source-upload`) is the print-ready file; `production.proofs[]`
  is the customer-facing proof. Place source, gate on proof approval. Confirm the
  uploaded formats are InDesign-placeable (PDF/EPS/TIFF/AI/PSD/JPG all fine).
- **Ad dimensions:** need a mapping from the order size code (`print.sz`, e.g.
  "Quarter", "Half") → real column×inch dimensions per publication, to build the
  frame. Locate or create this table.
- **Idempotency everywhere:** the "Publish Page" button may be clicked twice; the
  publish endpoint must no-op on already-published orders. Placement PUT is
  already idempotent by id.

---

## 7. ⚠️ Upstream work that must land FIRST (the blockers)

This feature sits on top of a scheduling model that **does not exist yet for
display ads**. These are the "major changes in other areas" — do them before the
placement→publish loop is worth building.

### 7.1 Orders have no per-edition run date (the big one)
Retail display orders are authored in the **external CRM**, not the platform, and
get publication/page/date assigned later in `/admin/autopage` — *not* at creation.
There is **no clean per-order run date** (same gap as classifieds). For the plugin
to pull "Scheduled ads for **this edition**," a scheduled order must carry
**which publication + which edition/run-date** it belongs to.
- **Fast v1 fallback:** pull *all* Scheduled ads for the **publication** (by
  `print.paper`); operator places the ones that belong. Ships without a date model.
- **Full fix:** capture publication + edition/run-date on the `approved →
  scheduled` step (date picker on the schedule action). Folds into the broader
  ad-scheduling work.
- Refs: `reference_ad_creation_scheduling`, `reference_print_data_model`.

### 7.2 Adboard state machine vs. autopage are two decoupled systems
`/admin/adboard` (the `production.state` workflow) and `/admin/autopage` (the
page-builder that reads orders by `print` component and assigns `print.autopagePage`)
are **parallel and unsynced**. An order can be "scheduled" in one and unassigned
in the other. Decide the single source of truth for "this ad belongs on this page
of this edition" before the plugin pulls from it. Likely: adboard `scheduled` = the
queue, autopage assignment = the page target — but they must be reconciled.

### 7.3 The `approved → scheduled` step needs to mean something
Today it's just a state flip with no edition/date attached. It must capture the
target edition (see 7.1) for "Scheduled only" pulling to work.

### 7.4 Three clashing paper-ID schemes
Per `reference_print_data_model`, there are 3 different publication/paper-ID
conventions across the data (numeric `print.paper`, slug ids, legacy ids). The
plugin filters by publication, so these must be reconciled/canonicalized
(`canonical-pub.js` exists as a start) before "ads for this publication" is reliable.

### 7.5 Print-ready source file guarantee
Confirm designers *always* upload a print-ready source (not just a proof) before
an ad can be scheduled. Otherwise the plugin has nothing placeable. Possibly gate
`approved → scheduled` on `sourceFiles.length > 0`.

### 7.6 (Tracked separately) adboard `listOrders` limit:300
The board query caps at 300 orders by recency — a state-scoped query is the
durable fix. Tracked in `project_adboard_limit_followup`. Not a hard blocker for
this feature but related to how "Scheduled" ads are queried at scale.

---

## 8. Suggested sequencing

1. **Prereqs first (§7):** settle the ad scheduling/edition-targeting model and
   the adboard↔autopage source-of-truth question. This is the real work.
2. **Platform, fast-v1:** ads marketplace feed (pull-by-publication), publish +
   revert endpoints, `published → scheduled` transition.
3. **Plugin:** ads in the panel + "Publish Page" button + color gating.
4. **Full edition targeting:** add run-date/edition capture at schedule time;
   switch the feed from pull-by-publication to pull-by-edition.
5. **Polish:** dimensions table, source-format validation, idempotency hardening,
   reconciliation view (placed vs. scheduled-but-unplaced ads).

---

## 9. Related references

- `reference_ad_creation_scheduling` — how each ad type is created/scheduled;
  retail display authored in external CRM, no run date at creation.
- `reference_print_data_model` — date/publication fields per type; 3 paper-ID schemes.
- `reference_orders_updatedat_invariant` — orders.updatedAt must be an ISO string;
  adboard state-machine auto-advance gotcha (PR #17).
- `project_adboard_limit_followup` — deferred: state-scoped board query.
- `color-placement.js` (plugin) — FC/BW page gating, ready to wire in.
