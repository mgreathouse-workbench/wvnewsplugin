# Print Plugin Asset Library

This folder holds the InDesign templates and snippets that the WVNews Print plugin uses to build publications. It's the post-TownNews home for assets that previously lived in `/Volumes/tcms_indesign/theet_local/` (TownNews TCMS share at `smb://10.10.20.125/tcms_indesign/`).

**Context:** the project is migrating off TownNews TCMS. These assets are copied (not linked) so the plugin runs without any TownNews dependency. See [PUBLICATION-LAYOUT-CATALOG.md](../../../PUBLICATION-LAYOUT-CATALOG.md) for full background.

## Current scope

Currently populated for **The Exponent Telegram (ET)** only — the first pub being migrated end-to-end. Other pubs (Mineral, Preston, Jackson, etc.) will be added one at a time as the plugin proves itself.

## Layout

```
assets/
├── templates/
│   └── exponent/
│       ├── telegram2026.indt              # Daily Exponent template
│       ├── telegram2026_master.indd       # Reference master document
│       ├── sunday2026.indt                # Sunday/Weekend Exponent template
│       └── sunday2026_master.indd         # Reference master document
│
├── snippets/
│   ├── chrome/                            # Per-pub, per-page standing chrome
│   │   ├── exponent-daily/                # Mon–Sat ET pages
│   │   │   ├── a1daily.idms               # A1 front-page chrome (nameplate, INSIDE strip, masthead)
│   │   │   ├── a2.idms                    # A2 staff masthead block
│   │   │   ├── opinion.idms               # Opinion page chrome
│   │   │   ├── sports.idms                # Sports section banner
│   │   │   ├── tvgrid.idms                # TV grid layout
│   │   │   ├── stocks_daily.idms          # Money & Markets page chrome
│   │   │   ├── bpn_masthead_2024.idms     # Bridgeport News section masthead (B5)
│   │   │   └── fmn_masthead_2024.idms     # Fairmont News section masthead (B6)
│   │   │
│   │   └── exponent-weekend/              # Sunday ET pages
│   │       ├── a1sunday.idms              # Sunday A1 front-page chrome
│   │       ├── a2.idms                    # Sunday A2 masthead
│   │       ├── sports.idms                # Sunday sports
│   │       ├── tvgrid.idms                # Sunday TV grid
│   │       ├── business.idms              # Sunday business section (replaces Mon–Sat Money&Markets)
│   │       ├── stocks_weekend.idms        # Weekend stocks
│   │       ├── across_the_state_2025.idms # "Across the State" section masthead
│   │       ├── corridor_c3.idms           # Corridor C3 community section masthead
│   │       ├── mountain_statesman.idms    # Grafton community section masthead
│   │       ├── ncwv_life.idms             # NCWV Life section masthead
│   │       ├── record_delta.idms          # Buckhannon community section masthead
│   │       ├── west_virginia.idms         # WV community section masthead
│   │       └── weston_democrat.idms       # Weston community section masthead
│   │
│   ├── story-blocks/                      # Cross-pub reusable story layouts
│   │   ├── 2col_story.idms                # 2-column story (small)
│   │   ├── 4col_story.idms                # 4-column story
│   │   ├── 4col_story_1mug.idms           # 4-col + 1 mugshot
│   │   ├── 4col_story_1photo_1mug.idms    # 4-col + 1 photo + 1 mug
│   │   ├── 4col_story_2photos.idms        # 4-col + 2 photos
│   │   ├── 4col_story_2photos_boxed.idms  # 4-col + 2 photos + box around the group
│   │   └── 6col_story.idms                # 6-column (large feature)
│   │
│   └── modular/
│       └── exponent/                      # ET-specific modular elements
│           ├── dailydogear.idms           # Date dogear corner graphic
│           ├── transparency.idms          # Print-transparency utility overlay
│           └── dogears/                   # Decorative corner branding graphics
│               ├── bonappetit.idms        # "Bon Appetit" food-section dogear
│               ├── vote_dogear_2018.idms  # Voting/election dogear
│               ├── veterans_dogear_2018.idms
│               ├── breast_cancer_awarness_2018.idms
│               ├── pancreatic_cancer_dogear_2018.idms
│               ├── labordaydogear.idms
│               ├── (...sponsor-brand dogears: aldersonbroaddus, americasmattress, chenoweth, etc.)
│               └── ...
```

## File-type guide

- **`.indt`** — InDesign template. Opening creates a new untitled document based on the template (preserves master pages, paragraph styles, swatches, etc. defined inside).
- **`.indd`** — InDesign document. The `*_master.indd` files are reference copies of the template's master document for inspection / debugging.
- **`.idms`** — InDesign Markup Snippet. XML-based; a self-contained group of page items + their styles. Placed onto a document via `script.place()` or operator drag-and-drop.

## Naming convention (this folder)

- **All lowercase, underscores for spaces.** Original TCMS files used mixed case + spaces (`4col story, 1 photo, 1 mug.idms`) which makes scripting fragile. Renamed at copy time.
- Per-pub subfolders use the lowercase short pub name (`exponent-daily`, `exponent-weekend`).

## What's intentionally NOT here

- **`.meta` files** — TownNews TCMS UUIDs and content hashes. Meaningless outside TCMS; not carried forward.
- **`.DS_Store` and `._*` files** — macOS resource forks, filtered out at copy.
- **TCMS `.jsx` scripts** — for folio refresh, PDF/print presets, etc. These called TCMS APIs and won't work post-migration; their *functions* are being re-implemented inside the plugin's TypeScript/JS code.
- **TownNews "Old Snippets" / "Backups"** — archives we don't need.
- **117 `Jumps/` subfolders** from TCMS — purpose unknown (possibly orphaned/temporary); not migrated.

## Placeholder-text binding convention

Story Block snippets carry **named placeholder text** that the plugin replaces at placement time:

| Placeholder | Bound to story field |
|------|-------|
| `print_headline` | `story.headline` |
| `print_subheadline` | `story.deck` |
| `nameline` | `story.byline` |
| `caption` | `story.photo.caption` |
| `main story` | `story.bodyText` |

This pattern was established by TownNews TCMS and is being **kept** for the new system — it's a clean design.

## Story Block style usage

Story Block snippets ship with the right paragraph styles already applied:

| Element | Paragraph style |
|---------|-----------------|
| Headline | `HD HDB Head Bold` |
| Body | `BCJ Body Copy Justified` |
| Mug caption | `IMN Image Mugshot Name` |

The plugin doesn't need to re-apply styles; just replace placeholder text and let the styles carry.

## Provenance

All files in this directory were copied from `/Volumes/tcms_indesign/theet_local/` on **2026-05-21**. Original modification dates on the source range from 2015 (oldest Story Blocks) to May 2026 (most recent chrome edits). If the source is updated, this folder needs to be re-synced (or eventually deprecated entirely once we have native asset management).

## Next steps (planned)

1. **Folio engine** — re-implement what `Refresh Folio Text Variables.jsx` did, native to the plugin.
2. **Snippet placer** — small utility that, given a story object + a Story Block file, places the snippet and binds the placeholders.
3. **Print/PDF preset manager** — capture the current preset definitions from TCMS and reproduce in the plugin export pipeline.
4. **Publication-plan editor** — Next.js UI for assigning stories to pages and Story Block sizes.
5. **Multi-page orchestrator** — read plan, open template, place chrome + Story Blocks + ads, thread jumps, output multi-page INDD.
6. **Page splitter** — multi-page INDD → per-page INDDs for Layout Artist polish.
