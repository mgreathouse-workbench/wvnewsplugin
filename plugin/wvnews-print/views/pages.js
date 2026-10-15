// Pages tab: the folio list for the chosen edition. The screen that is open
// all day, so it leads with what you are holding and keeps every row to one
// line: folio, snippet, state, actions.

function createPagesView({ html, cx, fmt, ui }) {
  function render(s, d) {
    const ed = s.edition;
    const pages = (ed.pages || []).slice().sort((a, b) => fmt.compareFolio(a.folio, b.folio));
    const busy = !!s.activity;
    const mine = d.heldFor(ed.id).sort((a, b) => fmt.compareFolio(a.folio, b.folio));
    const noSnippet = pages.filter((p) => !p.snippetId).length;
    const built = ed.status === 'built';

    return html`
      ${!built && pages.length ? buildPrompt(pages.length, busy) : ''}
      ${mine.length ? checkedOut(s, mine, busy) : ''}
      ${ui.section({
        title: 'Pages',
        count: pages.length,
        actions: s.pageFilesLoading ? html`<span class="muted">Updating…</span>`
          : ui.action({ label: 'Refresh', action: 'refreshPages', disabled: busy, title: 'Reload locks and versions from the website' }),
        body: html`<div class="list">${pages.map((p) => pageRow(s, ed, p, busy))}</div>`,
      })}
      ${noSnippet ? html`<div class="callout callout--notice">
          <div class="callout-text"><strong>${fmt.plural(noSnippet, 'page')} without a snippet</strong> will build from the master only, with no frames for stories or ads.</div>
          ${!built ? ui.action({ label: 'Assign Snippets', action: 'editPlan', disabled: busy }) : ''}
        </div>` : ''}
      ${built ? rebuildAll(s, ed, busy) : ''}`;
  }

  function buildPrompt(count, busy) {
    return html`<div class="callout callout--info">
      <div class="callout-text">These pages have not been built yet. Building creates all ${count} pages from the template and their snippets, and checks them in.</div>
      <div class="callout-actions">
        ${ui.button({ label: 'Build Pages', action: 'buildPages', variant: 'cta', disabled: busy })}
        ${ui.action({ label: 'Edit Plan', action: 'editPlan', disabled: busy })}
      </div>
    </div>`;
  }

  function checkedOut(s, mine, busy) {
    const openNames = s.openDocs || [];
    return ui.section({
      title: 'Checked out',
      count: mine.length,
      actions: mine.length > 1 ? ui.action({ label: 'Check In All', action: 'checkinAll', disabled: busy, emphasis: true }) : null,
      body: html`
        <div class="list">
          ${mine.map((co) => {
            const isOpen = openNames.includes(co.fileName);
            const mins = fmt.minutesLeft(co.lock && co.lock.expiresAt, s.now);
            return html`<div class="row">
              <span class="cell-folio">${co.folio}</span>
              <span class="cell-main">
                <span class="row-meta">${isOpen ? 'Open in InDesign' : 'Window closed'} · ${mins} min left</span>
              </span>
              <span class="cell-actions">
                ${isOpen ? ui.action({ label: 'Show', action: 'showPage', arg: co.folio, disabled: busy, title: 'Bring this page to the front' }) : ''}
                ${ui.action({ label: 'Check In', action: 'checkin', arg: co.folio, disabled: busy, emphasis: true })}
              </span>
            </div>`;
          })}
        </div>
        <div class="row-tools">
          <sp-checkbox size="s" data-change="setAutoCheckin"${s.autoCheckin ? html` checked` : ''}>Check in automatically when I close a page</sp-checkbox>
        </div>`,
    });
  }

  function pageRow(s, ed, p, busy) {
    const file = s.pageFiles[p.folio];
    const lock = file && file.lock;
    const co = (s.checkouts || {})[`${ed.id}::${p.folio}`];
    const lockLive = lock && !lock.expired && fmt.minutesLeft(lock.expiresAt, s.now) > 0;
    const mineHeld = !!co;
    const theirs = lockLive && !mineHeld;

    let state;
    // "No file" only once the list has actually loaded — a failed or pending
    // load is not evidence that 38 pages are missing their files.
    if (!file && s.pageFilesLoaded) state = ui.badge('No file', 'negative', 'This page has no file on the website, so it cannot be opened or built. Re-save the plan in Setup.');
    else if (!file) state = ui.badge('…', 'neutral', 'Loading page status');
    else if (mineHeld) state = ui.badge('You', 'accent', `Checked out to you · ${fmt.minutesLeft(co.lock && co.lock.expiresAt, s.now)} min left`);
    else if (theirs) state = ui.light((lock.displayName || lock.email || 'Locked').split(' ')[0], 'notice', `Open by ${lock.displayName || lock.email || 'someone else'} · ${fmt.minutesLeft(lock.expiresAt, s.now)} min left`);
    else if (lock && !lockLive) state = ui.badge(`v${file.currentVersion || 0}`, 'neutral', 'An expired lock is still recorded; opening the page clears it.');
    else state = file.currentVersion ? ui.badge(`v${file.currentVersion}`, 'neutral', `Version ${file.currentVersion} on the website`) : ui.badge('Empty', 'neutral', 'No version yet');

    const snip = p.snippetId ? s.snippetsById[p.snippetId] : null;
    const snipLabel = snip ? snip.name : (p.snippetId ? 'Snippet missing from library' : 'No snippet');

    const primary = mineHeld
      ? ui.action({ label: 'Check In', action: 'checkin', arg: p.folio, disabled: busy, emphasis: true })
      : ui.action({
        label: 'Open', action: 'openPage', arg: p.folio, disabled: busy || !file,
        title: theirs ? `${lock.displayName || 'Someone'} has this page. If the lock is yours from another session, it will open.` : 'Check out and open in InDesign',
      });

    return html`<div class="${cx('row', mineHeld && 'is-mine')}">
      <span class="cell-folio">${p.folio}</span>
      <span class="cell-main"><span class="${cx('row-text', !snip && 'is-dim')}">${snipLabel}</span></span>
      <span class="cell-state">${state}</span>
      <span class="cell-actions">
        ${theirs ? '' : ui.action({ label: 'Rebuild', action: 'rebuildPage', arg: p.folio, disabled: busy || !file, secondary: true, title: 'Rebuild only this page from the latest grid' })}
        ${primary}
      </span>
    </div>`;
  }

  function rebuildAll(s, ed, busy) {
    if (s.confirmBuild) {
      return html`<div class="callout callout--negative">
        <div class="callout-text"><strong>Rebuild all ${(ed.pages || []).length} pages?</strong> Every page is rebuilt from the grid and checked in as a new version. Changes made by hand in InDesign are replaced.</div>
        <div class="callout-actions">
          ${ui.button({ label: 'Cancel', action: 'cancelBuild', variant: 'secondary', quiet: true })}
          ${ui.button({ label: 'Rebuild All Pages', action: 'confirmBuild', variant: 'warning', disabled: busy })}
        </div>
      </div>`;
    }
    return html`<div class="section-foot">
      ${ui.action({ label: 'Rebuild All Pages…', action: 'buildPages', disabled: busy, title: 'Rebuild every page from the latest grid' })}
    </div>`;
  }

  return { render };
}

module.exports = { createPagesView };
