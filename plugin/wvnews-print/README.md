# WVNews Print — InDesign UXP Plugin

The WVNews replacement for Blox Digital's InDesign plugin. Runs inside Adobe InDesign 2023+ (UXP v6+, tested on InDesign 2025 / UXP 8) and lets layout artists pull editorial stories from the WVNews platform onto template frames in their page layouts.

For a complete progress + status snapshot of where this build is, see [PRINT-LAYOUT-SESSION.md](../../PRINT-LAYOUT-SESSION.md) at the repo root.

## What's in here

```
plugin/wvnews-print/
├── manifest.json        # UXP manifest v5, host "ID", min v18
├── index.html           # Panel root document: <div id="root"> and app.js
├── icons/               # 48px + 96px light + dark icons (placeholder art)
├── app.js               # Composition root — wires everything below, nothing else
├── ui/                  # The panel's machinery
│   ├── html.js          #   tagged template that escapes every value by default
│   ├── store.js         #   one state object; set() is the only way to change it
│   ├── renderer.js      #   batched paints that never land mid-click, keep scroll
│   ├── actions.js       #   run(): every user action, its busy state and outcome
│   ├── events.js        #   one delegated listener per event type (data-action=…)
│   ├── theme.js         #   colour-theme fallback (InDesign has no host colours)
│   └── format.js        #   dates, folio order, plurals
├── features/            # What each tab does: session, editions, pages, budget,
│                        #   marketplace, navigation
├── views/               # What each tab looks like: pure functions of state
├── auth.js              # PKCE OAuth — pure-JS SHA-256 (UXP 8 has no crypto.subtle)
├── api.js               # /api/print/* + /api/plugin/oauth/* fetch wrappers
├── indesign.js          # The InDesign DOM — placement, flow, build, documents
├── config.js            # SERVER_BASE + client_id
├── storage.js           # Tokens via UXP secureStorage / localStorage fallback
├── styles.css           # Theme-aware styles for all four InDesign colour themes
└── README.md            # This file
```

**No bundler, no `npm install` in the plugin folder.** Plain CommonJS, loaded by UXP directly.

Only `app.js` requires local modules. Everything in `ui/`, `features/` and
`views/` receives what it needs as arguments, because UXP resolves `require()`
relative to `index.html` rather than to the requiring file (see quirks below);
`tests/structure.test.js` enforces it. The header of `app.js` lists the five
rules that keep the panel from freezing, each the answer to a bug that shipped.

The panel can run outside InDesign: `npm run preview` and `npm run test:ui`
at the repo root load this folder unchanged in Chrome against fakes.

## Architecture

```
┌──────────────────────┐   PKCE auth (browser leg)   ┌──────────────────────────┐
│  UXP panel           │ ─────────────────────────▶  │  /api/plugin/oauth/      │
│  in InDesign 2023+   │ ◀── access + refresh JWT ── │   authorize + token      │
└────────┬─────────────┘                             └──────────────────────────┘
         │ fetch with Bearer <jwt>
         ▼
┌──────────────────────────────────────────────────┐
│  /api/print/sites                                │
│  /api/print/budget/{site}/{date}                 │
│  /api/print/templates  /templates/{id}           │
│  /api/print/placements (PUT)                     │
└──────────────────────────────────────────────────┘
```

## Three placement modes

Pick whichever matches the page design. The plugin reads each frame's **Script Label** (Window → Utilities → Script Label) to know what each frame is for.

### 1. Per-field flow into the currently selected frame

Click the **Headline / Deck / Byline / Dateline / Body** buttons in the panel — the selected field flows into whatever frame you have selected in InDesign. Used for ad-hoc flow into existing frames.

### 2. Place full story into labelled frames

Click **Place full story into labelled frames**. The plugin walks every frame on the active spread, reads its Script Label, and flows the matching story field in. Each labelled frame populates in one click.

### 3. Combined Blox-style `storyFrame`

Label a single text frame `storyFrame`. The plugin pours **byline + dateline + body** into it as a continuous story and stamps each region with its paragraph style from your style map. Used for the typical Blox model where one big text frame contains the running copy. Headline / deck / kicker still go in their own labelled frames.

## Script Label conventions

| Label | What flows in |
|---|---|
| `headlineFrame` | Headline |
| `deckFrame` | Deck/subhead |
| `kickerFrame` | Kicker / eyebrow |
| `storyFrame` | **Combined** byline + dateline + body, with paragraph styles per region |
| `bylineFrame` | Byline (if not using storyFrame) |
| `datelineFrame` | Dateline (if not using storyFrame) |
| `bodyFrame` | Story body (if not using storyFrame) |
| `pullquoteFrame` | Pull quote |
| `photoFrame` / `photo2Frame` / `photo3Frame` | Image |
| `captionFrame` / `caption2Frame` / `caption3Frame` | Caption |
| `creditFrame` | Photo credit |
| `turnlineFrame` | Source page: "See SLUG, A4" jump-out line (Dead Drop) |
| `jumpKeywordFrame` | Destination page: big bold keyword "CENTER" (Dead Drop) |
| `jumpContinuedFrame` | Destination page: "(Continued from Page A1)" (Dead Drop) |

Unlabeled frames are left untouched — useful for static furniture like rule lines, page numbers, mastheads.

## Develop / install

### 1. Install Adobe UXP Developer Tool

Open Creative Cloud Desktop → **Apps** tab → install **UXP Developer Tool**. Tested with v2.2.1.

### 2. Run the platform locally

```bash
cd /path/to/wvnews-platform-main
npm run dev
```

`.env.local` has `WVNEWS_DEV_DEMO=1` baked in for local testing — that bypasses Firebase entirely and serves canned demo stories. To test with real data, see "Production cutover" below.

### 3. Sideload the plugin

1. Launch **InDesign 2023+** (any document or just the start screen)
2. Open **UXP Developer Tool** (must launch InDesign first so UXP DT detects it)
3. Click **Add Plugin…** → pick `plugin/wvnews-print/manifest.json`
4. Click **Load** on the row that appears
5. In InDesign: **Window → Extensions → WVNews Print**

The panel reloads automatically when you edit any file. No build step.

### 4. Sign in

1. Click **Open Sign-In Page**
2. Your default browser opens with a one-time code on a styled page
3. Copy the code, paste it into the panel, click **Sign In**

Tokens are persisted in the OS keychain via UXP's `secureStorage`. They survive InDesign restarts. **Sign out** in the panel clears them.

## Package for distribution

```bash
npm run build
# → dist/wvnews-print-<version>.ccx
```

The script zips this folder into a `.ccx`, the package for Adobe Exchange and Creative Cloud, which Adobe must sign before it can be installed anywhere. **A `.ccx` is not how you sideload — UXP builds one, it does not open one.** To install on a machine, load `manifest.json` as in step 3 above; see the repo root README.

## Production cutover (TODO)

When you're done testing in demo mode:

1. **Firebase credentials**:
   - Generate a service-account key in Firebase Console → wvnews-crm → ⚙️ → Service Accounts
   - Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` locally, or `FIREBASE_SERVICE_ACCOUNT_KEY=<json>` on Vercel
2. **Remove `WVNEWS_DEV_DEMO=1`** from `.env.local`
3. **Set `PLUGIN_TOKEN_SECRET`** to a strong random string in Vercel env vars
4. **Update [config.js](config.js)** — change `SERVER_BASE` from `http://localhost:3000` to your production origin (e.g. `https://wvnews-platform-lgg2.vercel.app`)
5. **Update [manifest.json](manifest.json)**:
   - Replace `http://localhost:3000` in `requiredPermissions.network.domains` with your production origin
   - Add `https://storage.googleapis.com` to allow Firebase Storage signed URLs (for photo + snippet binaries)
6. **Re-pack the CCX** (`npm run plugin:pack`) and distribute to layout-desk machines

## UXP 8 / InDesign 2025 quirks encountered

- `host.app` in manifest must be the literal short code `"ID"` — not `"InDesign"` or `"indesign"`
- Plugin needs the `launchProcess` permission to call `shell.openExternal` (for the OAuth browser leg)
- `crypto.subtle` is **not** a global — the plugin includes a pure-JS SHA-256
- `TextEncoder` / `TextDecoder` are **not** globals — the plugin polyfills them at the top of `app.js`
- `require()` resolves relative to `index.html`, not the requiring file — that's why only `app.js` requires local modules
- InDesign does not set the `--uxp-host-*` theme variables other hosts provide; theme with `@media (prefers-color-scheme: darkest | dark | light | lightest)` instead (InDesign 2026 reports Light as `light`)
- Network domains in `requiredPermissions.network.domains` are enforced **after** HTTP redirects — list both pre- and post-redirect hosts if applicable
- UXP Developer Tool's per-row **Debug** action opens DevTools for the panel; the top-level "Debug Script" button is for legacy `.idjs` files only

## Dead Drop (cross-document jump)

Newspaper layouts routinely run a story across two pages — start on A1, continue on A4 with a "See CANVASS, A4" line on the front page and "(Continued from Page A1)" on the jump page. WV News structures each section as a separate `.indd` file, so the plugin uses a **two-phase capture-and-drop** workflow instead of InDesign's frame threading (which doesn't work across files).

**Required Script Labels on master pages:**
- `bodyFrame` — the body column (both source and destination pages)
- `turnlineFrame` — small frame on the source page that will hold "See CAPTION, A4"
- `jumpKeywordFrame` — frame on the destination page for the big bold keyword
- `jumpContinuedFrame` — frame on the destination page for "(Continued from Page A1)"

**Workflow:**

*Phase 1 — Capture in the source `.indd`:*
1. Flow the full story; the body overflows
2. Type the jump caption in the panel (e.g. `CANVASS`) and click **Dead Drop (capture)**
3. Plugin truncates `bodyFrame` to its visible content (paragraph styles preserved) and populates `turnlineFrame` with `See CANVASS, [DESTPAGE]` styled `JTL Jump Turnline`. The overflow body is stashed in plugin memory.

*Phase 2 — Drop in the destination `.indd`:*
1. Open the destination file
2. Select its `bodyFrame`
3. Click **Drop into selected frame**
4. Plugin populates: `jumpKeywordFrame` with `CANVASS` (style `JC1 Continued Keyword`), `jumpContinuedFrame` with `(Continued from Page A1)` (style `JC2 Continued`), and `bodyFrame` with the overflow body (style `BCJ Body Copy Justified`). The `[DESTPAGE]` placeholder in the source's turnline is patched with the real destination page label.

The editor — not the plugin — picks the jump caption; the input starts empty and the button stays disabled until something's typed.

## Roadmap (not built yet)

- CopyFit / HeadFit auto-fit equivalents (Blox's `copyFit.jsxbin` / `headFit.jsxbin`)
- "Update placed story" — re-pull latest text for a story already on a page
- E-edition tagging
- Distributed production — split a page across multiple operators
