# Deferred fixes — print-layout (do later)

Small changes parked for a later pass. None are blocking. Both land in the colleague's repo (bjarvis-lab/wvnews-platform) when ready.

---

## 1. Let the plugin create editions (relax the plugin-token guard) — ✅ DONE (2026-06-23)

**Status:** ACTIVE — shipped in `print-module-up-to-date.patch`. The `POST /api/print/editions` guard (`if (authz.kind === 'plugin') 403`) was removed, so the plugin's "New Edition" form now works. Delete-edition, snippet/template upload, and break-lock stay web-admin-only.

---

## 2. Fix the misleading "Delete edition" helper text

**Status:** deferred — cosmetic/accuracy. The delete itself works correctly; only the description is stale.

**Why:** since Build Pages now checks pages in to the website (Firebase Storage) instead of writing local TCMS `.indd` files, deleting an edition **does** permanently delete the cloud page binaries (all versions) + page records via `deletePagesAndBinariesForEdition`. But the UI still says the opposite.

**Change:** `src/app/admin/print-layout/editions/[id]/EditionEditor.jsx` (~line 250).
- **Current (wrong):** "Delete this edition plan. The built `.indd` files (if any) are not touched."
- **Replace with:** something like: "Delete this edition plan. This permanently deletes every page and all its saved versions from the website (Firebase Storage). This cannot be undone."

---

_When picking these up: apply in `~/Downloads/wvnews-platform-main 2`, then hand to Brian (patch or branch) the same way as the content-flow follow-up in `2-content-flow/`._
