# Pagination — hand-off to Brian

Everything needed to bring `bjarvis-lab/wvnews-platform` up to date and install the plugin. **Start with `BRIAN-HANDOFF.md`.**

| File | What it is |
|---|---|
| `print-module-up-to-date.patch` | The one code patch to apply (7 files, +617/−77). Verified `git apply --check` clean on `main`. Server endpoints + plugin source, current since PR #1. |
| `wvnews-print-0.1.0.ccx` | Prebuilt plugin installer, pointed at **staging.wvnews.com**. Sideload via Adobe UXP Developer Tool → Add Plugin, or upload on Print Layout → Plugin Releases. Rebuild with `PLUGIN_SERVER_BASE=https://wvnews.com` for production. |
| `BRIAN-HANDOFF.md` | Apply + install steps, what it adds, what's intentionally excluded, caveats. |
| `CONTENT-FLOW.md` | The content wiring + the new `obituary-body` / `legal-body` snippet frame labels designers must add. |
| `DEFERRED-FIXES.md` | What is intentionally NOT included. |

## TL;DR
```bash
git checkout -b print/update main
git apply "print-module-up-to-date.patch"
npm run build && # deploy to staging
# then: sideload wvnews-print-0.1.0.ccx in UXP Developer Tool
```
Adds: the **Sync from budget** bridge, the **Marketplace** endpoint/tab, Build-Pages-to-website, plugin-create-editions, classifieds text headers. The `.ccx` + Sync/Marketplace need the **server deployed to staging** first. Needs a real-Firestore run. Excludes his env config files (`config.js`/`manifest.json`) on purpose.
