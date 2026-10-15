// Tabs, the status bar, and the date picker.

const VIEWS = ['pages', 'budget', 'marketplace', 'setup'];

function createNavigation(ctx) {
  const { store, fmt, persist } = ctx;

  // Opening a tab loads what it needs, once. Two tabs used to open on an
  // empty state whose only button had moved elsewhere (#27); there is nothing
  // to click now, the data simply arrives.
  function setView(view) {
    if (!VIEWS.includes(view)) return undefined;
    const s = store.state;
    if (view === 'pages' && !s.edition) view = 'setup';
    store.set({ view });
    persist.lastView = view;
    if (s.activity) return undefined;
    if (view === 'setup' && s.editionsLoadedFor !== s.siteId && !s.editionsLoading) return ctx.editions.load();
    if (view === 'budget' && s.edition && !s.budget) return ctx.budget.load();
    if (view === 'marketplace' && s.edition && !s.market) return ctx.marketplace.load();
    if (view === 'pages' && s.edition) return ctx.pages.refreshFiles();
    return undefined;
  }

  function dismissMessage() { store.set({ message: null, detailsOpen: false }); }
  function toggleDetails() { store.set({ detailsOpen: !store.state.detailsOpen }); }

  // Copy the message and its details. The clipboard API needs a manifest
  // permission this plugin does not ask for, so when it refuses, the details
  // box is opened and selected instead — Cmd-C does the rest.
  async function copyMessage() {
    const m = store.state.message;
    if (!m) return;
    const text = [m.text, m.details].filter(Boolean).join('\n\n');
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        store.set({ copied: Date.now() });
        setTimeout(() => store.set({ copied: 0 }), 1600);
        return;
      }
    } catch { /* fall back to selection */ }
    store.set({ detailsOpen: true });
    setTimeout(() => {
      try {
        const box = document.getElementById('status-details');
        if (box) { box.focus(); box.select(); }
      } catch { /* the box is visible either way */ }
    }, 0);
  }

  // ── Date picker ───────────────────────────────────────────────────
  //
  // UXP renders <input type="date"> as a plain text box with no calendar, so
  // the panel draws its own. A pending date changes as days are clicked and is
  // committed only on OK.

  function openDate() {
    const form = store.state.form;
    const current = (form && form.editionDate) || fmt.todayISO();
    const p = fmt.parseISO(current) || fmt.parseISO(fmt.todayISO());
    store.set({ datePicker: { pending: current, view: { y: p.y, m: p.m }, mode: 'days' } });
  }
  function patchDate(patch) {
    const dp = store.state.datePicker;
    if (dp) store.set({ datePicker: { ...dp, ...patch } });
  }
  function shiftMonth(delta) {
    const dp = store.state.datePicker;
    if (!dp) return;
    let { y, m } = dp.view;
    m += Number(delta);
    if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
    patchDate({ view: { y, m } });
  }
  function pickDay(iso) { patchDate({ pending: iso }); }
  function toggleYears() {
    const dp = store.state.datePicker;
    if (dp) patchDate({ mode: dp.mode === 'years' ? 'days' : 'years' });
  }
  function pickYear(y) {
    const dp = store.state.datePicker;
    if (dp) patchDate({ view: { y: Number(y), m: dp.view.m }, mode: 'days' });
  }
  function cancelDate() { store.set({ datePicker: null }); }
  function confirmDate() {
    const dp = store.state.datePicker;
    if (dp && dp.pending) ctx.editions.setFormDate(dp.pending);
    store.set({ datePicker: null });
  }

  return {
    VIEWS, setView, dismissMessage, toggleDetails, copyMessage,
    openDate, shiftMonth, pickDay, toggleYears, pickYear, cancelDate, confirmDate,
  };
}

module.exports = { createNavigation, VIEWS };
