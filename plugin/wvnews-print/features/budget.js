// Budget: the edition's stories, auto-pagination, and placing story content.

// siteId → layout-config folder under assets/layouts/. Only the ET is wired so
// far; tabloids and the State Journal join when their layout configs land.
// The canonical id is `exponent-telegram`; the legacy slugs still resolve.
// (The weekend ET should eventually use 'exponent-weekend' by day of week.)
const SITE_TO_PUB_PROFILE = {
  'exponent-telegram': 'exponent-daily',
  exponent: 'exponent-daily',
  theet: 'exponent-daily',
};

const VERIFY_MS = 5000;

function createBudget(ctx) {
  const { store, run, api, id, fmt, persist, fail } = ctx;

  const edition = () => {
    const ed = store.state.edition;
    if (!ed) throw fail('Choose an edition first.');
    return ed;
  };
  const story = () => {
    const s = store.state;
    const a = s.budget && s.budget.assets.find((x) => x.id === s.storyId);
    if (!a) throw fail('Choose a story first.');
    return a;
  };

  async function fetchInto() {
    const ed = edition();
    const budget = await api.fetchBudget(ed.siteId, ed.editionDate);
    const keepStory = budget.assets.some((a) => a.id === store.state.storyId);
    store.set({ budget, ...(keepStory ? {} : { storyId: null }) });
    await verifyPlacements();
    return budget;
  }

  // A load that works says nothing: the list it fills is the result.
  function load() {
    return run('Loading the budget', async () => { await fetchInto(); });
  }

  // ── Which stories are really on a page ────────────────────────────
  //
  // A placement recorded on the server can be deleted in InDesign. When the
  // document it was recorded in is open, look for the stamped frames and trust
  // what is actually there.

  async function verifyPlacements() {
    let result;
    try { result = await id.verifyPlacedAssets(); }
    catch { return; }                                  // InDesign busy: try next time
    const docs = (result && result.docNames) || [];
    const ids = (result && result.assetIds) || [];
    const prev = store.state.placement;
    const same = prev && prev.checked
      && sameSet(prev.docs, docs) && sameSet(prev.ids, ids);
    // Repaint only when something changed. The old panel repainted the whole
    // panel every four seconds regardless, and a repaint mid-click eats the click.
    if (!same) store.set({ placement: { checked: true, docs, ids } });
  }

  function isPlaced(a) {
    if (!a || !a.placement) return false;
    const p = store.state.placement;
    if (!p || !p.checked) return true;               // not verified yet: trust the server
    const doc = a.placement.documentName || '';
    if (doc && p.docs.includes(doc)) return p.ids.includes(a.id);
    return true;                                      // its document is not open: cannot check
  }

  function startVerifier() {
    if (persist.verifyTimer) clearInterval(persist.verifyTimer);
    persist.verifyTimer = setInterval(() => {
      const s = store.state;
      if (!s.user || s.view !== 'budget' || !s.budget || s.activity) return;
      if (isEditing()) return;
      verifyPlacements().catch(() => {});
      ctx.pages.refreshOpenDocs();
    }, VERIFY_MS);
  }

  function isEditing() {
    try {
      const tag = String((document.activeElement && document.activeElement.tagName) || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'sp-textfield' || tag === 'sp-picker';
    } catch { return false; }
  }

  // ── Navigation ────────────────────────────────────────────────────

  function selectStory(storyId) { store.set({ storyId }); }
  function back() { store.set({ storyId: null }); }

  function pagesWithStories() {
    const b = store.state.budget;
    const byPage = {};
    for (const a of (b && b.assets) || []) {
      const f = fmt.normalizeFolio(a.pageAssignment);
      if (f) (byPage[f] = byPage[f] || []).push(a);
    }
    return byPage;
  }

  // ── Auto-paginate ─────────────────────────────────────────────────
  //
  // It places into the FRONT document, so it now makes the page the front
  // document first — opening (checking out) the page if it is not already
  // open. That was three steps across two tabs, and getting the order wrong
  // either refused or, before #28, paginated onto the wrong page.

  function paginate(folio) {
    return run(`Paginating ${folio}`, async ({ progress }) => {
      const ed = edition();
      const profile = SITE_TO_PUB_PROFILE[ed.siteId];
      if (!profile) throw fail(`${ed.siteId} has no layout profile yet, so it cannot be auto-paginated.`);
      const stories = pagesWithStories()[folio] || [];
      if (!stories.length) throw fail(`No stories are assigned to ${folio}.`);

      await ctx.pages.ensureFront(folio, progress);
      progress(`placing ${fmt.plural(stories.length, 'story', 'stories')}`);
      const result = await id.autoPaginatePage(profile, folio, stories);

      const docName = safe(() => id.activeDocument().name, '');
      for (const p of result.placements) {
        if (!p.placed) continue;
        await api.recordPlacement({
          assetId: p.story.id,
          siteId: ed.siteId,
          editionDate: ed.editionDate,
          pageAssignment: folio,
          documentName: docName,
          frameLabel: `block:${p.position.defaultBlock}@${p.position.id}:${(p.framesBound || []).join(',')}`,
          status: 'placed',
        }).catch(() => { /* the page is right; the tracker catches up on the next load */ });
      }

      // Each placed story is grouped; one that could not be says why.
      const ungrouped = result.placements.filter((p) => p.placed && p.grouped === false);
      const lines = result.placements.map((p) =>
        `${p.placed ? '✓' : '✗'} ${p.position.id} (${p.position.defaultBlock}) — ${p.story.headline}`
        + `${p.error ? ` — ${p.error}` : ''}`
        + `${p.placed && p.grouped === false ? ` — left ungrouped: ${p.groupNote || 'no reason given'}` : ''}`);
      for (const u of result.unplaced || []) lines.push(`· skipped “${u.story.headline}” — ${u.reason}`);
      if (result.overBudgeted && result.overBudgetMessage) lines.push('', result.overBudgetMessage);

      try { await fetchInto(); } catch { /* the placement stands; badges refresh next load */ }
      const text = `Placed ${result.successCount} of ${fmt.plural(result.totalStories, 'story', 'stories')} on ${folio}.`
        + (ungrouped.length ? ` ${ungrouped.length === 1 ? 'One was' : `${ungrouped.length} were`} left ungrouped — see Details.` : '');
      const complete = result.successCount === result.totalStories && !ungrouped.length;
      return { kind: complete ? 'success' : 'warning', text, details: lines.join('\n') };
    });
  }

  // ── Placing one story ─────────────────────────────────────────────

  async function record(a, result, frameLabel, extra = {}) {
    const ed = edition();
    await api.recordPlacement({
      assetId: a.id,
      siteId: ed.siteId,
      editionDate: ed.editionDate,
      pageAssignment: (result && result.page) || safe(() => id.activePageLabel(), '') || a.pageAssignment || 'A-1',
      documentName: (result && result.documentName) || safe(() => id.activeDocument().name, ''),
      frameLabel,
      status: 'placed',
      ...extra,
    });
  }

  function placeTemplate(templateId) {
    return run('Placing from template', async () => {
      const a = story();
      const t = (store.state.budget.templates || []).find((x) => x.id === templateId);
      if (!t) throw fail('That template is no longer available. Reload the budget.');
      const result = await id.placeTemplate(t, a, store.state.budget.styleMap);
      await record(a, result, (result.framesBound || []).join(','), { templateId: t.id });
      await fetchInto();
      return `Placed “${a.headline}” using ${t.label}.`;
    });
  }

  function placePackage() {
    return run('Building the story package', async () => {
      const a = story();
      const result = await id.placeStoryIntoSelectedFrame(a, store.state.budget.styleMap);
      const bound = result.framesBound || [];
      await record(a, result, `story:${bound.join(',')}`);
      await fetchInto();
      return { text: `Built “${a.headline}” in ${fmt.plural(bound.length, 'frame')}.`, details: bound.join(', ') };
    });
  }

  function setBlock(blockId) {
    persist.blockId = blockId;
    store.set({ blockId });
  }

  function placeBlock() {
    return run('Placing the story block', async () => {
      const a = story();
      const blockId = store.state.blockId;
      const result = await id.placeAndBindStoryBlock(blockId, a);
      await record(a, null, `block:${blockId}:${(result.framesBound || []).join(',')}`);
      await fetchInto();
      const bound = result.framesBound || [];
      const ungrouped = result.grouped === false ? `Left ungrouped: ${result.groupNote || 'no reason given'}` : '';
      return bound.length
        ? { kind: ungrouped ? 'warning' : 'success', text: `Placed ${blockId} for “${a.headline}”.`,
          details: [`Filled: ${bound.join(', ')}`, ungrouped].filter(Boolean).join('\n') }
        : { kind: 'warning', text: `Placed ${blockId}, but none of its placeholders matched this story.` };
    });
  }

  function flowAll() {
    return run('Filling labelled frames', async () => {
      const a = story();
      const result = await id.flowFullStoryIntoLabelledFrames(a, store.state.budget.styleMap);
      const bound = result.framesBound || [];
      const missing = result.missing || [];
      if (!bound.length) {
        throw fail('No labelled frames on this page. Label frames in Window → Utilities → Script Label.');
      }
      await record(a, result, bound.join(','));
      await fetchInto();
      return {
        text: `Placed “${a.headline}” into ${fmt.plural(bound.length, 'frame')}.`,
        details: [`Filled: ${bound.join(', ')}`, ...(missing.length ? [`Skipped: ${missing.join('; ')}`] : [])].join('\n'),
      };
    });
  }

  function flowField(kind) {
    return run(`Placing the ${kind}`, async () => {
      const a = story();
      const result = await id.flowIntoSelectedFrame(a, store.state.budget.styleMap, kind);
      await record(a, result, `${kind}:${(result.framesBound || []).join(',')}`);
      await fetchInto();
      return `Placed the ${kind} of “${a.headline}” in the selected frame.`;
    });
  }

  function placePhoto() {
    return run('Placing the photo', async () => {
      const a = story();
      if (!a.photo) throw fail('This story has no photo.');
      const result = await id.placePhotoInSelection(a.photo, a);
      await record(a, result, 'photo');
      return `Placed the photo for “${a.headline}”.`;
    });
  }

  // ── Jumps (Dead Drop) ─────────────────────────────────────────────
  //
  // Capture on the source page, drop on the destination page. The pending jump
  // lives on the global so it survives a reload between the two halves.

  function setJumpSlug(value) {
    store.state.jumpSlug = String(value || '').toUpperCase();  // typing does not need a repaint
  }

  function captureJump() {
    const slug = String(store.state.jumpSlug || '').trim().toUpperCase();
    if (!slug) {
      store.set({ message: { kind: 'error', text: 'Type the jump word first, e.g. COUNCIL.' } });
      return undefined;
    }
    return run('Capturing the jump', async () => {
      const a = story();
      const c = await id.captureSourceForJump(slug, store.state.budget.styleMap);
      persist.pendingJump = {
        slug: c.slug, sourceDocName: c.sourceDocName, sourcePage: c.sourcePage,
        overflowText: c.overflowText, overflowChars: c.overflowChars,
        assetId: a.id, headline: a.headline, capturedAt: Date.now(),
      };
      store.set({ pendingJump: persist.pendingJump });
      return {
        kind: c.turnlinePlaced ? 'success' : 'warning',
        text: `Captured ${c.overflowChars} characters from ${c.sourcePage}. Open the destination page, select its body frame, and click Drop Jump.`,
        details: c.turnlinePlaced ? '' : 'The jump line could not be added to the end of the source frame. Add it by hand.',
      };
    });
  }

  function completeJump() {
    const pending = persist.pendingJump;
    if (!pending) return undefined;
    return run('Dropping the jump', async () => {
      const r = await id.completeJumpToFrame(pending, store.state.budget && store.state.budget.styleMap);
      const ed = edition();
      await api.recordPlacement({
        assetId: pending.assetId, siteId: ed.siteId, editionDate: ed.editionDate,
        pageAssignment: pending.sourcePage, documentName: pending.sourceDocName,
        frameLabel: `jump:${pending.slug} → ${r.destDocName}/${r.destPage}`, status: 'placed',
      });
      persist.pendingJump = null;
      store.set({ pendingJump: null });
      return {
        kind: r.patchedInDoc ? 'success' : 'warning',
        text: `“${pending.headline}” now jumps ${pending.sourcePage} → ${r.destPage} as ${pending.slug}.`,
        details: r.patchedInDoc ? '' : 'The source turnline still reads [DESTPAGE] — its document was not open.',
      };
    });
  }

  function cancelJump() {
    persist.pendingJump = null;
    store.set({ pendingJump: null, message: { kind: 'info', text: 'Jump cancelled.' } });
  }

  return {
    SITE_TO_PUB_PROFILE, load, verifyPlacements, isPlaced, startVerifier,
    selectStory, back, pagesWithStories, paginate,
    placeTemplate, placePackage, setBlock, placeBlock, flowAll, flowField, placePhoto,
    setJumpSlug, captureJump, completeJump, cancelJump,
  };
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

module.exports = { createBudget, SITE_TO_PUB_PROFILE };
