// Pages: checking out, checking in, building, and keeping locks alive.
//
// Everything here that changed the old controller's behaviour has a reason in
// the version history; the short form:
//
//   * check-in reads the saved file when the window is already closed (#29)
//   * closing a page's window checks it in by itself, if enabled (#30)
//   * held pages keep their heartbeat across a panel reload (#31)
//   * a build re-reads the edition first — the Page Grid is a separate app (#12)
//   * a build closes the page's window BEFORE it saves over the file (#19)
//   * a build retires the operator's superseded copy afterwards (#16)
//
// New here: the background work (heartbeat, close sweep) never runs while a
// user action is running, and never repaints unless something changed.

const PHASE = {
  checkout: 'locking the page',
  create: 'opening the template',
  download: 'downloading the snippet',
  place: 'placing content',
  save: 'checking in',
};
const HEARTBEAT_MS = 5 * 60 * 1000;   // server lock TTL is 90 minutes
const SWEEP_MS = 10 * 1000;

function createPages(ctx) {
  const { store, run, api, id, fmt, persist, fail, host } = ctx;

  // ── Check-out records ─────────────────────────────────────────────
  //
  // Kept on the global so a panel reload does not forget which pages are open.
  // Keyed `<editionId>::<folio>`.

  const key = (editionId, folio) => `${editionId}::${folio}`;
  const held = () => Object.values(store.state.checkouts || {});
  const heldFor = (editionId) => held().filter((c) => c.editionId === editionId);
  const recordFor = (editionId, folio) => (store.state.checkouts || {})[key(editionId, folio)] || null;

  function keep(co) {
    const checkouts = { ...store.state.checkouts, [key(co.editionId, co.folio)]: co };
    persist.checkouts = checkouts;
    store.set({ checkouts });
  }
  function forget(editionId, folio) {
    const checkouts = { ...store.state.checkouts };
    delete checkouts[key(editionId, folio)];
    persist.checkouts = checkouts;
    store.set({ checkouts });
    if (!Object.keys(checkouts).length) stopTimers();
  }
  function setPageFile(folio, page) {
    if (!page) return;
    store.set({ pageFiles: { ...store.state.pageFiles, [folio]: page } });
  }

  function currentEdition() {
    const ed = store.state.edition;
    if (!ed) throw fail('Choose an edition first.');
    return ed;
  }

  async function refreshFiles() {
    const ed = store.state.edition;
    if (!ed) return;
    store.set({ pageFilesLoading: true });
    try {
      const rows = await api.listEditionPages(ed.id);
      store.set({ pageFiles: Object.fromEntries((rows || []).map((r) => [r.folio, r])), pageFilesLoaded: true });
      refreshOpenDocs();
    } catch (err) {
      store.set({ pageFilesLoaded: false, message: { kind: 'error', text: `Could not load page status: ${err.message}` } });
    } finally {
      store.set({ pageFilesLoading: false });
    }
  }

  // Which page windows are open, for the "Open in InDesign / Window closed"
  // line. Asked of InDesign here, never from inside a render.
  function refreshOpenDocs() {
    let names = [];
    try { names = id.openDocumentNames(); } catch { return; }
    let front = '';
    const ed = store.state.edition;
    if (ed && names.length) {
      try {
        const name = String(id.activeDocument().name || '');
        const prefix = fmt.pageFileName(ed.id, '').replace(/\.indd$/, '');
        if (name.indexOf(prefix) === 0 && /\.indd$/.test(name)) front = name.slice(prefix.length, -'.indd'.length);
      } catch { /* nothing in front */ }
    }
    const prev = store.state.openDocs || [];
    const same = prev.length === names.length && prev.every((n) => names.includes(n));
    if (!same || front !== (store.state.frontFolio || '')) store.set({ openDocs: names, frontFolio: front });
  }

  // ── Open (check out) ──────────────────────────────────────────────

  // Lock, download, open. Used by the Open button and by auto-paginate.
  async function openPage(folio, progress = () => {}) {
    const ed = currentEdition();
    progress('locking the page');
    let co;
    try {
      co = await api.checkoutPage({ editionId: ed.id, folio, host: host.hostname() });
    } catch (err) {
      if (err.statusCode === 423 && err.lock) {
        throw fail(`${folio} is open by ${err.lock.displayName || err.lock.email || 'someone else'}`
          + ` for another ${fmt.minutesLeft(err.lock.expiresAt)} min.`);
      }
      throw err;
    }
    let opened;
    let blank = false;
    if (co.downloadUrl) {
      progress('downloading the page');
      const bytes = await api.fetchPageBinary(co.downloadUrl);
      progress('opening it in InDesign');
      opened = await id.openDownloadedPage({ editionId: ed.id, folio, arrayBuffer: bytes });
    } else {
      opened = await id.createBlankPage({ editionId: ed.id, folio });
      blank = true;
    }
    keep({
      editionId: ed.id,
      folio,
      tempPath: opened.tempPath,
      fileName: opened.fileName,
      lock: co.page && co.page.lock,
      // Length of the file as downloaded. If it is unchanged when the window
      // closes, nothing was saved, and auto check-in adds no version.
      openedBytes: opened.bytes == null ? null : opened.bytes,
    });
    setPageFile(folio, co.page);
    startTimers();
    refreshOpenDocs();
    return blank;
  }

  function open(folio) {
    return run(`Opening ${folio}`, async ({ progress }) => {
      const blank = await openPage(folio, progress);
      return blank
        ? `${folio} opened as a blank page — this publication has no template yet, so your first check-in becomes v1.`
        : `${folio} is open in InDesign.`;
    });
  }

  // Bring an already-open page's window to the front.
  function show(folio) {
    const ed = store.state.edition;
    if (!ed) return;
    if (!id.bringPageToFront(ed.id, folio)) {
      store.set({ message: { kind: 'error', text: `${folio}'s window is not open. Use Open to download it again.` } });
    }
  }

  // Make `folio` the front document, opening it if it is not checked out.
  // Auto-paginate places into whatever is in front, so this runs first.
  async function ensureFront(folio, progress = () => {}) {
    const ed = currentEdition();
    if (id.activeDocIsPage(ed.id, folio).ok) return;
    const co = recordFor(ed.id, folio);
    if (co) {
      if (id.findOpenDocByTempPath(co.tempPath)) {
        if (id.bringPageToFront(ed.id, folio)) return;
        throw fail(`${folio} is open but InDesign would not bring it to the front. Click its window, then try again.`);
      }
      throw fail(`${folio} is checked out but its window is closed. Check it in from the Pages tab, then try again.`);
    }
    progress(`opening ${folio}`);
    await openPage(folio, progress);
    if (!id.activeDocIsPage(ed.id, folio).ok && !id.bringPageToFront(ed.id, folio)) {
      throw fail(`${folio} opened, but it is not the front document. Click its window, then try again.`);
    }
  }

  // ── Check in ──────────────────────────────────────────────────────

  // Upload one held page. The window may be open (save it, then read it) or
  // already closed (read the file that was saved). Reading the folio's own
  // file is unambiguous, which the old activeDocument() fallback never was.
  async function checkinRecord(co, note = '') {
    const doc = id.findOpenDocByTempPath(co.tempPath);
    let bytes;
    let fromDisk = false;
    if (doc) {
      bytes = await id.saveAndReadPageBytes({ doc, fileName: co.fileName });
    } else {
      try {
        bytes = await id.readPageBytes(co.fileName);
        fromDisk = true;
      } catch {
        forget(co.editionId, co.folio);
        refreshFiles().catch(() => {});
        throw fail(`${co.folio} is not open and has no saved file, so there was nothing to upload. `
          + 'It has been released — use Open to download it again.');
      }
    }
    let result;
    try {
      result = await api.checkinPage({ editionId: co.editionId, folio: co.folio, bytes, note });
    } catch (err) {
      if (err.statusCode === 423) {
        forget(co.editionId, co.folio);
        // Do NOT tell them to reopen the page: opening downloads the server's
        // copy over this same temp file, which would destroy the work this
        // message is about. Save As first, then reopen.
        throw fail(`Your lock on ${co.folio} had expired or was taken, so the page was NOT uploaded. `
          + 'Your work is safe in the InDesign window. Use File → Save As to keep a copy BEFORE '
          + `opening ${co.folio} again — opening it downloads the website's version over the file.`);
      }
      throw err;
    }
    setPageFile(co.folio, result.page);
    if (doc) await id.closePageDoc(doc);
    forget(co.editionId, co.folio);
    refreshOpenDocs();
    return { version: result.page && result.page.currentVersion, fromDisk };
  }

  function checkin(folio) {
    const ed = store.state.edition;
    const co = ed && recordFor(ed.id, folio);
    if (!co) {
      store.set({ message: { kind: 'error', text: `${folio} is not checked out in this panel.` } });
      return undefined;
    }
    return run(`Checking in ${folio}`, async () => {
      const r = await checkinRecord(co);
      return `${folio} checked in as v${r.version}${r.fromDisk ? ' from the file you saved' : ''}.`;
    });
  }

  // Sequential on purpose: each check-in saves and closes a window, and two of
  // those racing inside InDesign is how a modal ends up owned by the wrong one.
  function checkinAll() {
    const ed = store.state.edition;
    const list = ed ? heldFor(ed.id).sort((a, b) => fmt.compareFolio(a.folio, b.folio)) : [];
    if (!list.length) return undefined;
    return run(`Checking in ${fmt.plural(list.length, 'page')}`, async ({ progress }) => {
      const done = [];
      for (const co of list) {
        progress(`${co.folio} (${done.length + 1} of ${list.length})`);
        try {
          const r = await checkinRecord(co);
          done.push(`${co.folio} → v${r.version}`);
        } catch (err) {
          throw fail(`Stopped at ${co.folio}: ${err.message}`,
            [...done.map((d) => `✓ ${d}`), `✗ ${co.folio}: ${err.message}`]);
        }
      }
      return { text: `Checked in ${fmt.plural(done.length, 'page')}.`, details: done.join('\n') };
    });
  }

  // ── Build ─────────────────────────────────────────────────────────

  function resultLine(r) {
    if (!r.saved) return `✗ ${r.folio} — ${r.error || 'failed'}`;
    const bits = [`✓ ${r.folio}${r.version ? ` v${r.version}` : ''}`];
    if (!r.placed) bits.push('no snippet placed');
    if (r.assets && r.assets.placed) bits.push(`+${fmt.plural(r.assets.placed, 'asset')}`);
    if (r.assets && r.assets.missed) bits.push(`${r.assets.missed} missing`);
    return bits.join(' · ');
  }

  // A build checks the page out, writes it and checks it in by itself. A copy
  // the operator still had open is now superseded — saving it would put the
  // old layout back — so close it and forget its check-out record.
  function retireSuperseded(editionId, folio) {
    const co = recordFor(editionId, folio);
    if (!co) return null;
    let note = null;
    try {
      const stale = id.findOpenDocByTempPath(co.tempPath);
      if (stale) {
        id.closePageDoc(stale);
        if (id.findOpenDocByTempPath(co.tempPath)) {
          note = `${folio}: your older copy would not close — close it WITHOUT saving.`;
        }
      }
    } catch { note = `${folio}: close your older copy without saving.`; }
    forget(editionId, folio);
    return note;
  }

  function closeForBuild(editionId, folios) {
    const stuck = [];
    for (const folio of folios) {
      const shut = id.closeOpenPageDoc(editionId, folio);
      if (shut.found > shut.closed) stuck.push(folio);
    }
    if (stuck.length) {
      throw fail(`Close ${stuck.join(', ')} in InDesign WITHOUT saving, then build again — `
        + 'the build saves over those files and InDesign will not while they are open.');
    }
  }

  function rebuild(folio) {
    return run(`Rebuilding ${folio}`, async ({ progress }) => {
      const ed = await ctx.editions.refreshCurrent();
      if (!ed) throw fail('Choose an edition first.');
      const page = (ed.pages || []).find((p) => p.folio === folio);
      if (!page) throw fail(`${folio} is not a page of ${ed.id}.`);
      closeForBuild(ed.id, [folio]);
      const result = await id.buildEditionPages({ ...ed, pages: [page] }, store.state.snippetsById,
        (p) => progress(PHASE[p.phase] || p.phase));
      const r = (result.results || [])[0];
      if (!r) throw fail('The build reported nothing for this page.');
      const note = r.saved ? retireSuperseded(ed.id, folio) : null;
      setPageFile(folio, r.page || null);
      await refreshFiles();
      const details = [resultLine(r), ...(r.diag || []).map((d) => `   ${d}`), ...(note ? [note] : [])];
      if (!r.saved) throw fail(`${folio} did not build: ${r.error || 'unknown error'}`, details);
      return { text: `Rebuilt ${folio}${r.version ? ` as v${r.version}` : ''}.`, details: details.join('\n') };
    });
  }

  // Rebuilding an edition that is already built replaces every page on the
  // website and discards manual edits, so it asks first.
  function requestBuild() {
    const ed = store.state.edition;
    if (!ed) return undefined;
    if (ed.status === 'built' && !store.state.confirmBuild) {
      store.set({ confirmBuild: true });
      return undefined;
    }
    return build();
  }
  function cancelBuild() { store.set({ confirmBuild: false }); }

  function build() {
    store.set({ confirmBuild: false });
    return run('Building pages', async ({ progress }) => {
      progress('reading the latest page plan');
      const ed = await ctx.editions.refreshCurrent();
      if (!ed) throw fail('Choose an edition first.');
      const pages = ed.pages || [];
      if (!pages.length) throw fail(`${ed.id} has no pages to build.`);
      closeForBuild(ed.id, pages.map((p) => p.folio));
      const result = await id.buildEditionPages(ed, store.state.snippetsById,
        (p) => progress(`${p.index + 1} of ${p.total} · ${p.folio} · ${PHASE[p.phase] || p.phase}`));
      const lines = [];
      for (const r of result.results || []) {
        lines.push(resultLine(r));
        for (const d of r.diag || []) lines.push(`   ${d}`);
        if (r.saved) {
          const note = retireSuperseded(ed.id, r.folio);
          if (note) lines.push(`   ! ${note}`);
        }
      }
      if (!result.failed) {
        try {
          await api.updateEditionStatus(ed.id, 'built');
          store.set({ edition: { ...store.state.edition, status: 'built' } });
        } catch (err) {
          lines.push(`(Pages built, but the edition could not be marked built: ${err.message})`);
        }
      }
      await refreshFiles();
      const n = (result.results || []).length;
      if (result.failed) {
        throw fail(`${result.failed} of ${n} pages did not build.`, lines);
      }
      return { text: `Built ${fmt.plural(n, 'page')} and checked them in.`, details: lines.join('\n') };
    });
  }

  // Swap real artwork into ad wells on the active page, for proofs approved
  // after it was built. Changes the open window only — check in to publish.
  function refreshPlacedAds() {
    return run('Refreshing ad artwork', async () => {
      const ed = currentEdition();
      const r = await id.refreshPlacedAdsOnActivePage(ed.id);
      if (!r.checked) return { kind: 'info', text: 'The active page has no labelled ad wells.' };
      return {
        text: `${r.replaced} of ${fmt.plural(r.checked, 'ad well')} updated${r.failed ? `, ${r.failed} failed` : ''}.`
          + (r.replaced ? ' Check the page in to publish the change.' : ''),
        details: (r.details || []).join('\n'),
      };
    });
  }

  function setAutoCheckin(on) {
    persist.autoCheckin = !!on;
    store.set({ autoCheckin: !!on });
  }

  // ── Background: lock heartbeat and the close sweep ────────────────
  //
  // Timers live on the global and are cleared before new ones start, so a
  // panel reload in a surviving context can never stack two of each.

  function stopTimers() {
    for (const k of ['heartbeatTimer', 'sweepTimer']) {
      if (persist[k]) { clearInterval(persist[k]); persist[k] = null; }
    }
  }

  function startTimers() {
    stopTimers();
    persist.sweepTimer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
    persist.heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, HEARTBEAT_MS);
  }

  // After a reload: resume the timers for pages still held, and sweep once
  // straight away — a page closed before the reload is already waiting.
  function resume() {
    if (held().length) {
      console.log(`[wvnews-print] resuming for ${fmt.plural(held().length, 'held page')}`);
      startTimers();
      sweep().catch(() => {});
    }
  }

  async function heartbeat() {
    const list = held();
    if (!list.length) { stopTimers(); return; }
    for (const co of list) {
      try {
        const r = await api.heartbeatPage({ editionId: co.editionId, folio: co.folio });
        if (r && r.page && r.page.lock) {
          keep({ ...co, lock: r.page.lock });
          if (store.state.edition && store.state.edition.id === co.editionId) setPageFile(co.folio, r.page);
        }
      } catch (err) {
        if (err.statusCode === 423) {
          forget(co.editionId, co.folio);
          store.set({ message: { kind: 'error', text: `Your lock on ${co.folio} was broken by someone else. Your copy has NOT been uploaded.` } });
        }
      }
    }
  }

  // Check in pages whose window the operator has closed.
  async function sweep() {
    if (store.state.activity) return;
    refreshOpenDocs();
    if (!store.state.autoCheckin) return;
    for (const co of held()) {
      if (store.state.activity) return;                       // a user action started
      if (id.findOpenDocByTempPath(co.tempPath)) continue;    // still open
      let bytes;
      try { bytes = await id.readPageBytes(co.fileName); }
      catch { continue; }                                     // closed, nothing saved
      if (co.openedBytes != null && bytes.byteLength === co.openedBytes) continue;  // looked at, not edited
      try {
        const r = await api.checkinPage({
          editionId: co.editionId, folio: co.folio, bytes,
          note: 'Checked in automatically when the page was closed',
        });
        if (store.state.edition && store.state.edition.id === co.editionId) setPageFile(co.folio, r.page);
        forget(co.editionId, co.folio);
        store.set({ message: { kind: 'success', text: `${co.folio} checked in as v${r.page && r.page.currentVersion} when you closed it.` } });
      } catch (err) {
        // Once per page, not every ten seconds.
        if (store.state.sweepWarned !== co.folio) {
          store.set({
            sweepWarned: co.folio,
            message: { kind: 'error', text: `${co.folio} was closed but could not be checked in: ${err.message}` },
          });
        }
      }
    }
  }

  return {
    held, heldFor, recordFor, refreshFiles, refreshOpenDocs,
    open, show, ensureFront, checkin, checkinAll,
    rebuild, requestBuild, cancelBuild, build, refreshPlacedAds,
    setAutoCheckin, resume, stopTimers, sweep, heartbeat,
  };
}

module.exports = { createPages };
