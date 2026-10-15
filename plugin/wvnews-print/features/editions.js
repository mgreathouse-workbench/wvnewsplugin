// The edition: choosing it, and planning it.
//
// One edition is the context for the whole panel. Every tab acts on it, the
// context bar shows it, and it changes in exactly one place. Choosing one also
// sets the publication and date the Budget and Marketplace tabs use, so they
// cannot point at a different paper than Pages does.

function createEditions(ctx) {
  const { store, run, api, fmt, persist, fail } = ctx;

  // The editions list and the snippet library for the chosen publication.
  async function load(siteId = store.state.siteId) {
    store.set({ editionsLoading: true });
    try {
      const [eds, snips] = await Promise.all([
        api.listEditions({ siteId: siteId || undefined }),
        api.listSnippets({ siteId: siteId || undefined }),
      ]);
      setSnippets((snips && snips.snippets) || []);
      store.set({ editions: (eds && eds.editions) || [], editionsLoadedFor: siteId || '' });
    } catch (err) {
      store.set({ message: { kind: 'error', text: `Could not load editions: ${err.message}` } });
    } finally {
      store.set({ editionsLoading: false });
    }
  }

  function setSnippets(snippets) {
    store.set({ snippets, snippetsById: Object.fromEntries(snippets.map((s) => [s.id, s])) });
  }

  function setPublication(siteId) {
    if (!siteId || siteId === store.state.siteId) return undefined;
    store.set({ siteId });
    return load(siteId);
  }

  // Make an edition the context and go to its pages.
  async function select(editionId, { quiet = false, view = 'pages' } = {}) {
    const work = async () => {
      const res = await api.getEdition(editionId);
      const edition = res && res.edition;
      if (!edition) throw fail(`Edition ${editionId} was not found.`);
      const changed = !store.state.edition || store.state.edition.id !== edition.id;
      store.set({
        edition,
        siteId: edition.siteId || store.state.siteId,
        view,
        form: null,
        confirmBuild: false,
        // A budget or marketplace loaded for a DIFFERENT edition must not
        // survive the switch — the old panel kept showing the previous
        // edition's stories under the new one's name.
        ...(changed ? { budget: null, market: null, storyId: null, placedAds: {}, pageFiles: {} } : {}),
      });
      persist.lastEditionId = edition.id;
      persist.lastView = view;
      // Snippet names for the page list; the library is per publication.
      if (store.state.editionsLoadedFor !== edition.siteId || !store.state.snippets.length) {
        try { setSnippets(((await api.listSnippets({ siteId: edition.siteId })) || {}).snippets || []); }
        catch { /* names fall back to "snippet not in library" */ }
      }
      await ctx.pages.refreshFiles();
      // The context bar now names the edition; that is the confirmation.
      return null;
    };
    if (quiet) {
      try { await work(); }
      catch (err) {
        // A remembered edition that no longer exists is not worth an alarm.
        persist.lastEditionId = null;
        store.set({ view: 'setup' });
        await load();
        console.warn('[wvnews-print] could not restore edition:', err.message);
      }
      return undefined;
    }
    return run(`Opening ${editionId}`, work);
  }

  // Re-read the current edition from the server without changing the view.
  // The Page Grid is a separate web app: an ad dropped there a minute ago is
  // not in the copy this panel loaded, so every build starts from a fresh read.
  async function refreshCurrent() {
    const ed = store.state.edition;
    if (!ed) return null;
    const res = await api.getEdition(ed.id);
    if (res && res.edition) store.set({ edition: res.edition });
    return store.state.edition;
  }

  // Go and pick a different edition. The current one stays the context until
  // another is chosen — leaving nothing selected in between helped nobody.
  function change() {
    store.set({ view: 'setup', form: null });
    persist.lastView = 'setup';
    if (store.state.editionsLoadedFor !== store.state.siteId) return load();
    return undefined;
  }

  // ── The plan form ─────────────────────────────────────────────────

  function openNew() {
    const s = store.state;
    const site = s.sites.find((x) => x.id === s.siteId);
    store.set({
      view: 'setup',
      form: {
        mode: 'create',
        editingId: null,
        siteId: s.siteId || '',
        editionDate: fmt.todayISO(),
        sections: site && site.defaultSections && site.defaultSections.length
          ? site.defaultSections.map((x) => ({ letter: x.letter, pageCount: x.pageCount }))
          : [{ letter: 'A', pageCount: 8 }],
        assignments: {},
        error: '',
      },
    });
  }

  function openEdit() {
    const ed = store.state.edition;
    if (!ed) return;
    const assignments = {};
    for (const p of ed.pages || []) assignments[p.folio] = p.snippetId || '';
    store.set({
      view: 'setup',
      form: {
        mode: 'edit',
        editingId: ed.id,
        siteId: ed.siteId,
        editionDate: ed.editionDate,
        sections: (ed.sections || []).map((x) => ({ letter: x.letter, pageCount: x.pageCount })),
        assignments,
        error: '',
      },
    });
  }

  function cancelForm() {
    store.set({ form: null });
  }

  function patchForm(patch) {
    const form = store.state.form;
    if (!form) return;
    store.set({ form: { ...form, ...patch, error: '' } });
  }

  function setFormPublication(siteId) {
    const form = store.state.form;
    if (!form || form.mode !== 'create') return undefined;
    const site = store.state.sites.find((x) => x.id === siteId);
    const untouched = form.sections.length === 1 && form.sections[0].letter === 'A';
    patchForm({
      siteId,
      ...(untouched && site && site.defaultSections && site.defaultSections.length
        ? { sections: site.defaultSections.map((x) => ({ letter: x.letter, pageCount: x.pageCount })) }
        : {}),
    });
    return api.listSnippets({ siteId }).then((r) => setSnippets((r && r.snippets) || [])).catch(() => {});
  }

  function setFormDate(iso) { patchForm({ editionDate: iso }); }

  // Typing updates the form silently; leaving the field (change) repaints.
  // A repaint on every keystroke would replace the Spectrum textfield under
  // the caret — type "12" fast enough and it becomes "21".
  function typeSectionLetter(value, index) {
    const sec = store.state.form && store.state.form.sections[Number(index)];
    if (sec) sec.letter = String(value || '').toUpperCase().slice(0, 1);
  }

  function typeSectionCount(value, index) {
    const sec = store.state.form && store.state.form.sections[Number(index)];
    if (sec) sec.pageCount = Math.max(1, Math.min(200, Math.floor(Number(value)) || 1));
  }

  function commitSections() {
    if (store.state.form) patchForm({ sections: store.state.form.sections.slice() });
  }

  function addSection() {
    const sections = store.state.form.sections.slice();
    const last = sections.length ? sections[sections.length - 1].letter : '@';
    const next = String.fromCharCode((last || '@').charCodeAt(0) + 1);
    if (next > 'Z') return;
    sections.push({ letter: next, pageCount: 4 });
    patchForm({ sections });
  }

  function removeSection(index) {
    const sections = store.state.form.sections.slice();
    if (sections.length <= 1) return;
    sections.splice(Number(index), 1);
    patchForm({ sections });
  }

  function assignSnippet(snippetId, folio) {
    const form = store.state.form;
    patchForm({ assignments: { ...form.assignments, [folio]: snippetId || '' } });
  }

  function submitForm() {
    const s = store.state;
    const form = s.form;
    if (!form) return undefined;
    const site = s.sites.find((x) => x.id === form.siteId);
    const invalid = !form.siteId || !site ? 'Choose a publication.'
      : !fmt.parseISO(form.editionDate) ? 'Choose an edition date.'
      : !form.sections.length ? 'Add at least one section.'
      : form.sections.some((x) => !/^[A-Z]$/.test(x.letter)) ? 'Every section needs a letter, A to Z.'
      : (form.mode === 'create' && !/^[A-Z]{3}$/.test(site.code || ''))
        ? `${site.name} has no three-letter site code yet, so its editions cannot be named.`
      : '';
    if (invalid) { store.set({ form: { ...form, error: invalid } }); return undefined; }

    return run(form.mode === 'edit' ? `Saving ${form.editingId}` : 'Creating edition', async () => {
      const sections = form.sections.map((x) => ({ letter: x.letter, pageCount: Number(x.pageCount) || 0 }));
      const pages = foliosOf(sections).map((folio) => ({ folio, snippetId: form.assignments[folio] || null }));
      let id;
      if (form.mode === 'edit') {
        await api.updateEdition(form.editingId, { sections, pages });
        id = form.editingId;
      } else {
        const res = await api.createEdition({
          siteId: form.siteId, siteCode: site.code, editionDate: form.editionDate, sections, pages,
        });
        id = res && res.edition && res.edition.id;
      }
      store.set({ form: null });
      await load(form.siteId);
      if (id) await select(id, { quiet: true });
      return form.mode === 'edit' ? `Saved the plan for ${id}.` : `Created ${id || 'the edition'}.`;
    });
  }

  return {
    load, setPublication, select, refreshCurrent, change,
    openNew, openEdit, cancelForm, setFormPublication, setFormDate,
    typeSectionLetter, typeSectionCount, commitSections, addSection, removeSection, assignSnippet, submitForm,
  };
}

function foliosOf(sections) {
  const out = [];
  for (const s of sections || []) {
    for (let i = 1; i <= (Number(s.pageCount) || 0); i++) out.push(`${s.letter}${i}`);
  }
  return out;
}

// EXT_101726 for site code EXT on 2026-10-17. Mirrors editionId() on the platform.
function previewEditionId(siteCode, editionDate) {
  if (!/^[A-Z]{3}$/.test(siteCode || '')) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(editionDate || '');
  return m ? `${siteCode}_${m[2]}${m[3]}${m[1].slice(2)}` : '';
}

module.exports = { createEditions, foliosOf, previewEditionId };
