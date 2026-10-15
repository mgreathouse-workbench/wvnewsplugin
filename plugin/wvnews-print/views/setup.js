// Setup tab: choose a publication and an edition, or plan one.

function createSetupView({ html, cx, fmt, ui, foliosOf, previewEditionId }) {
  function render(s) {
    return s.form ? form(s) : list(s);
  }

  // ── Editions ──────────────────────────────────────────────────────

  function list(s) {
    const busy = !!s.activity;
    const site = s.sites.find((x) => x.id === s.siteId);
    const editions = (s.editions || [])
      .filter((e) => !s.siteId || e.siteId === s.siteId)
      .sort((a, b) => String(b.editionDate).localeCompare(String(a.editionDate)));

    const pub = ui.field('Publication', s.sites.length
      ? ui.picker({ id: 'pub-picker', change: 'setPublication', value: s.siteId,
        options: s.sites.map((x) => ({ value: x.id, label: x.name })), disabled: busy })
      : html`<div class="muted">${s.sitesLoading ? 'Loading publications…' : 'No publications available.'}</div>`);

    let body;
    if (s.editionsLoading) {
      body = ui.empty({ busy: true, title: 'Loading editions…' });
    } else if (!editions.length) {
      body = ui.empty({
        title: 'No editions planned',
        text: site ? `Nothing is planned for ${site.name} yet.` : 'Choose a publication.',
        actions: site ? ui.button({ label: 'New Edition', action: 'newEdition', variant: 'primary', disabled: busy }) : null,
      });
    } else {
      body = html`<div class="list">${editions.map((e) => editionRow(s, e))}</div>`;
    }

    return html`
      <div class="pad">${pub}</div>
      ${ui.section({
        title: 'Editions',
        count: editions.length || null,
        actions: html`${ui.action({ label: 'Refresh', action: 'loadEditions', disabled: busy })}${site ? ui.action({ label: 'New Edition', action: 'newEdition', disabled: busy, emphasis: true }) : ''}`,
        body,
      })}`;
  }

  function editionRow(s, e) {
    const current = s.edition && s.edition.id === e.id;
    const pages = (e.pages || []).length;
    const withSnippet = (e.pages || []).filter((p) => p.snippetId).length;
    return html`<div class="${cx('row', 'row--clickable', current && 'is-selected')}" data-action="selectEdition" data-arg="${e.id}">
      <span class="cell-main">
        <span class="row-title">${fmt.fmtDate(e.editionDate) || e.editionDate}</span>
        <span class="row-meta">${e.id} · ${fmt.plural(pages, 'page')} · ${withSnippet}/${pages} with snippets</span>
      </span>
      <span class="cell-state">
        ${current ? ui.badge('Current') : ''}
        ${ui.light(statusLabel(e.status), statusKind(e.status))}
      </span>
      <span class="chevron" aria-hidden="true">›</span>
    </div>`;
  }

  // ── The plan ──────────────────────────────────────────────────────

  function form(s) {
    const f = s.form;
    const busy = !!s.activity;
    const isEdit = f.mode === 'edit';
    const site = s.sites.find((x) => x.id === f.siteId);
    const id = isEdit ? f.editingId : previewEditionId(site && site.code, f.editionDate);
    const folios = foliosOf(f.sections);
    const eligible = (s.snippets || []).filter((x) => !x.siteId || x.siteId === f.siteId);
    const assigned = folios.filter((fo) => f.assignments[fo]).length;
    const snippetOptions = [
      { value: '', label: 'No snippet' },
      ...eligible.map((x) => ({ value: x.id, label: x.category ? `${x.name} · ${x.category}` : x.name })),
    ];

    return html`
      <div class="toolbar">
        ${ui.action({ label: '‹ Editions', action: 'cancelForm', disabled: busy })}
      </div>
      ${ui.head({ title: isEdit ? 'Edit plan' : 'New edition', meta: isEdit ? f.editingId : '' })}

      ${ui.section({
        title: 'Edition',
        body: html`<div class="stack pad-x">
          ${ui.field('Publication', ui.picker({ id: 'form-pub', change: 'setFormPublication', value: f.siteId,
            options: s.sites.map((x) => ({ value: x.id, label: x.code ? `${x.name} (${x.code})` : x.name })),
            disabled: isEdit || busy }))}
          ${ui.field('Date',
            html`<div class="${cx('date-field', (isEdit || busy) && 'is-disabled')}" role="button" tabindex="0"
              data-action="openDate" data-enter="openDate"${isEdit || busy ? html` aria-disabled="true"` : ''}>
              <span class="date-field-text">${fmt.fmtDate(f.editionDate) || 'Choose a date'}</span>
              <span class="date-field-icon" aria-hidden="true">▾</span>
            </div>`,
            id ? `Will be saved as ${id}` : (site && !site.code ? `${site.name} has no site code yet.` : ''))}
        </div>`,
      })}

      ${ui.section({
        title: 'Sections',
        count: fmt.plural(folios.length, 'page'),
        actions: ui.action({ label: 'Add Section', action: 'addSection', disabled: busy || f.sections.length >= 26 }),
        body: html`<div class="list">${f.sections.map((sec, i) => html`
          <div class="row row--form">
            ${ui.textfield({ id: `sec-letter-${i}`, input: 'typeSectionLetter', change: 'commitSections', arg: String(i), value: sec.letter, className: 'tf-letter mono' })}
            <span class="muted">×</span>
            ${ui.textfield({ id: `sec-count-${i}`, input: 'typeSectionCount', change: 'commitSections', arg: String(i), value: String(sec.pageCount), type: 'number', className: 'tf-count' })}
            <span class="muted grow">pages · ${sec.letter || '?'}1–${sec.letter || '?'}${sec.pageCount}</span>
            ${f.sections.length > 1 ? ui.action({ label: 'Remove', action: 'removeSection', arg: String(i), disabled: busy }) : ''}
          </div>`)}</div>`,
      })}

      ${ui.section({
        title: 'Snippets',
        count: `${assigned}/${folios.length}`,
        body: !f.siteId ? html`<div class="list-empty">Choose a publication to see its snippets.</div>`
          : !eligible.length ? html`<div class="callout callout--notice"><div class="callout-text">No snippets are uploaded for this publication. Upload .idms files at /admin/print-layout/snippets, then come back.</div></div>`
          : html`<div class="list">${folios.map((fo) => html`
            <div class="row row--form">
              <span class="cell-folio">${fo}</span>
              ${ui.picker({ id: `snip-${fo}`, change: 'assignSnippet', arg: fo, value: f.assignments[fo] || '', options: snippetOptions, disabled: busy })}
            </div>`)}</div>`,
      })}

      ${f.error ? html`<div class="callout callout--negative"><div class="callout-text">${f.error}</div></div>` : ''}

      <div class="form-actions">
        ${ui.button({ label: 'Cancel', action: 'cancelForm', variant: 'secondary', quiet: true, disabled: busy })}
        ${ui.button({ label: isEdit ? 'Save Plan' : (id ? `Create ${id}` : 'Create Edition'), action: 'submitForm', variant: 'cta', disabled: busy })}
      </div>`;
  }

  return { render };
}

function statusLabel(status) {
  return ({ planned: 'Planned', building: 'Building', built: 'Built', published: 'Published' })[status] || 'Planned';
}
function statusKind(status) {
  return ({ built: 'positive', published: 'positive', building: 'notice' })[status] || 'neutral';
}

module.exports = { createSetupView, statusLabel, statusKind };
