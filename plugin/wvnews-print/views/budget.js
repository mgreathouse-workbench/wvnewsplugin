// Budget tab: the edition's stories, grouped by the page they are budgeted
// for, with Paginate on each page. A story opens into its own screen with the
// placement tools, rather than appending them under a 50-story list.

function createBudgetView({ html, cx, fmt, ui }) {
  function render(s, d) {
    const busy = !!s.activity;
    if (!s.edition) {
      return ui.empty({
        title: 'No edition chosen',
        text: 'Choose an edition to see its budget.',
        actions: ui.button({ label: 'Choose Edition', action: 'goSetup', variant: 'primary' }),
      });
    }
    if (!s.budget) {
      const loading = busy && /budget/i.test(s.activity.label);
      return ui.empty({
        busy: loading,
        title: loading ? 'Loading the budget…' : 'Budget not loaded',
        text: loading ? '' : `Stories budgeted for ${s.edition.id}.`,
        actions: loading ? null : ui.button({ label: 'Load Budget', action: 'loadBudget', variant: 'primary', disabled: busy }),
      });
    }
    const story = s.storyId && s.budget.assets.find((a) => a.id === s.storyId);
    return story ? detail(s, d, story, busy) : list(s, d, busy);
  }

  // ── The list ──────────────────────────────────────────────────────

  function list(s, d, busy) {
    const assets = s.budget.assets;
    if (!assets.length) {
      return ui.empty({ title: 'No stories budgeted', text: `Nothing is budgeted for ${s.edition.id} yet.`,
        actions: ui.action({ label: 'Refresh', action: 'loadBudget', disabled: busy }) });
    }
    const byPage = d.pagesWithStories();
    const folios = Object.keys(byPage).sort(fmt.compareFolio);
    const unassigned = assets.filter((a) => !fmt.normalizeFolio(a.pageAssignment));
    const canPaginate = !!d.profile;
    const front = s.frontFolio;

    return html`
      <div class="toolbar">
        <span class="toolbar-text">${fmt.plural(assets.length, 'story', 'stories')} on ${fmt.plural(folios.length, 'page')}</span>
        ${ui.action({ label: 'Refresh', action: 'loadBudget', disabled: busy })}
      </div>
      ${!canPaginate ? html`<div class="callout callout--notice"><div class="callout-text">${s.edition.siteId} has no layout profile yet, so its pages cannot be auto-paginated.</div></div>` : ''}
      ${folios.map((f) => ui.section({
        title: f,
        count: fmt.plural(byPage[f].length, 'story', 'stories'),
        actions: html`${front === f ? ui.light('Active', 'accent', 'The active document in InDesign') : ''}${canPaginate
          ? ui.action({ label: 'Paginate', action: 'paginate', arg: f, disabled: busy, emphasis: true,
            title: `Place ${f}'s stories automatically. Opens ${f} first if it is not open.` }) : ''}`,
        body: html`<div class="list">${byPage[f].map((a) => storyRow(a, d))}</div>`,
      }))}
      ${unassigned.length ? ui.section({
        title: 'Not assigned to a page',
        count: unassigned.length,
        body: html`<div class="list">${unassigned.map((a) => storyRow(a, d))}</div>`,
      }) : ''}`;
  }

  function storyRow(a, d) {
    const placed = d.isPlaced(a);
    const removed = a.placement && !placed;
    return html`<div class="${cx('row', 'row--clickable', 'row--story', placed && 'is-done')}" data-action="openStory" data-arg="${a.id}">
      <span class="cell-main">
        <span class="row-title">${a.headline || 'Untitled'}</span>
        <span class="row-meta">${[a.byline, a.printOnly ? 'Print only' : ''].filter(Boolean).join(' · ') || ' '}</span>
      </span>
      <span class="cell-state">
        ${placed ? ui.light('Placed', 'positive') : ''}
        ${removed ? ui.light('Removed', 'negative', 'Recorded as placed, but its frames are no longer on the page') : ''}
      </span>
      <span class="chevron" aria-hidden="true">›</span>
    </div>`;
  }

  // ── One story ─────────────────────────────────────────────────────

  function detail(s, d, a, busy) {
    const folio = fmt.normalizeFolio(a.pageAssignment);
    const templates = s.budget.templates || [];
    const words = fmt.wordCount(a.bodyText);
    const pending = s.pendingJump;

    return html`
      <div class="toolbar">
        ${ui.action({ label: '‹ Stories', action: 'closeStory' })}
      </div>
      ${ui.head({
        title: a.headline || 'Untitled',
        meta: [a.byline, a.dateline, `${words.toLocaleString()} words`].filter(Boolean).join(' · '),
        badges: html`${folio ? ui.badge(folio) : ui.badge('No page')}${a.printOnly ? ui.badge('Print only') : ''}${d.isPlaced(a) ? ui.light('Placed', 'positive') : ''}`,
      })}
      ${a.photo && a.photo.url ? html`<div class="pad"><img class="story-photo" src="${a.photo.url}" alt="${a.photo.alt || ''}" /></div>` : ''}

      ${folio && d.profile ? ui.section({
        title: 'Paginate',
        body: html`<div class="stack">
          ${ui.hint(`Places every story budgeted for ${folio}, including this one, in ${folio}'s designed blocks.`)}
          ${ui.button({ label: `Paginate ${folio}`, action: 'paginate', arg: folio, variant: 'primary', disabled: busy })}
        </div>`,
      }) : ''}

      ${ui.section({
        title: 'Story block',
        body: html`<div class="stack">
          ${ui.hint('Places a designed block and fills its placeholders with this story.')}
          ${ui.picker({ id: 'block-picker', change: 'setBlock', value: s.blockId,
            options: d.blockIds.map((b) => ({ value: b, label: b.replace(/_/g, ' ') })) })}
          ${ui.button({ label: 'Place Block', action: 'placeBlock', variant: 'secondary', disabled: busy })}
        </div>`,
      })}

      ${ui.section({
        title: 'Into a frame you select',
        body: html`<div class="stack">
          ${ui.hint('Select a text frame in InDesign first.')}
          <div class="button-row">
            ${ui.button({ label: 'Story Package', action: 'placePackage', variant: 'secondary', disabled: busy,
              title: 'Replace the selected frame with headline, byline, photo and body frames' })}
            ${ui.button({ label: 'Labelled Frames', action: 'flowAll', variant: 'secondary', disabled: busy,
              title: 'Fill frames labelled headlineFrame, bodyFrame, photoFrame… on this page' })}
          </div>
          <div class="field-label">Or one part at a time</div>
          <div class="chip-row">
            ${['headline', ...(a.deck ? ['deck'] : []), ...(a.byline ? ['byline'] : []), ...(a.dateline ? ['dateline'] : []), 'body']
              .map((k) => ui.action({ label: k[0].toUpperCase() + k.slice(1), action: 'flowField', arg: k, disabled: busy, quiet: false, title: `Place only the ${k}` }))}
            ${a.photo && a.photo.url ? ui.action({ label: 'Photo', action: 'placePhoto', disabled: busy, quiet: false }) : ''}
          </div>
        </div>`,
      })}

      ${templates.length ? ui.section({
        title: 'From a template',
        count: templates.length,
        body: html`<div class="list">${templates.map((t) => html`
          <div class="row row--clickable" data-action="placeTemplate" data-arg="${t.id}">
            <span class="cell-main"><span class="row-text">${t.label}</span></span>
            <span class="cell-state">${ui.badge(t.kind, 'neutral')}</span>
            <span class="chevron" aria-hidden="true">›</span>
          </div>`)}</div>`,
      }) : ''}

      ${ui.section({
        title: 'Jump',
        body: pending ? html`<div class="stack">
            <div class="callout callout--info"><div class="callout-text">
              <b>${pending.slug}</b> captured from ${pending.sourcePage}: ${pending.overflowChars.toLocaleString()} characters waiting.
              Open the destination page, select its body frame, then drop.
            </div></div>
            <div class="button-row">
              ${ui.button({ label: 'Drop Jump', action: 'completeJump', variant: 'primary', disabled: busy })}
              ${ui.button({ label: 'Cancel', action: 'cancelJump', variant: 'secondary', quiet: true, disabled: busy })}
            </div>
          </div>` : html`<div class="stack">
            ${ui.hint('Select the overflowing body frame, type the jump word, then capture.')}
            <div class="inline">
              ${ui.textfield({ id: 'jump-slug', input: 'setJumpSlug', value: s.jumpSlug || '', placeholder: 'COUNCIL', enter: 'captureJump', className: 'grow mono' })}
              ${ui.button({ label: 'Capture', action: 'captureJump', variant: 'secondary', disabled: busy })}
            </div>
          </div>`,
      })}`;
  }

  return { render };
}

module.exports = { createBudgetView };
