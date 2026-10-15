// Marketplace tab: liners (classifieds, legals, obituaries) and display ads
// for the chosen edition.

function createMarketplaceView({ html, ui }) {
  const SECTIONS = [
    { key: 'classified', label: 'Classified section' },
    { key: 'legal', label: 'Legal section' },
    { key: 'rop', label: 'Run of paper' },
  ];

  function render(s) {
    const busy = !!s.activity;
    if (!s.edition) {
      return ui.empty({ title: 'No edition chosen', text: 'Choose an edition to see its marketplace.',
        actions: ui.button({ label: 'Choose Edition', action: 'goSetup', variant: 'primary' }) });
    }
    const m = s.market;
    if (!m) {
      const loading = busy && /marketplace/i.test(s.activity.label);
      return ui.empty({
        busy: loading,
        title: loading ? 'Loading the marketplace…' : 'Marketplace not loaded',
        text: loading ? '' : `Classifieds, legals, obituaries and display ads for ${s.edition.id}.`,
        actions: loading ? null : ui.button({ label: 'Load Marketplace', action: 'loadMarket', variant: 'primary', disabled: busy }),
      });
    }
    const count = (k) => ((m[k] && m[k].items) || []).length;
    const ads = (m.ads && m.ads.items) || [];

    return html`
      <div class="toolbar">
        <span class="toolbar-text">Select a frame in InDesign, then Place.</span>
        ${ui.action({ label: 'Refresh', action: 'loadMarket', disabled: busy })}
      </div>
      ${ui.section({
        title: 'Liners',
        body: html`<div class="list">
          ${liner('Classifieds', 'classifieds', count('classifieds'), busy)}
          ${liner('Legal notices', 'legals', count('legals'), busy)}
          ${liner('Obituaries', 'obits', count('obits'), busy)}
        </div>
        <div class="row-tools">
          ${ui.action({ label: 'Update Section Headers', action: 'updateHeaders', disabled: busy,
            title: 'After reshaping the classified columns, select a frame in the section and click to move each category banner to its column top.' })}
        </div>`,
      })}
      ${ui.section({
        title: 'Display ads',
        count: ads.length,
        body: html`
          <div class="row-tools row-tools--top">
            <span class="muted">Active page</span>
            ${ui.action({ label: 'Refresh Artwork', action: 'refreshPlacedAds', disabled: busy,
              title: 'Swap in ad artwork approved since the active page was built. Check the page in to publish the change.' })}
            ${ui.action({ label: 'Publish Ads', action: 'publishPage', disabled: busy,
              title: 'Mark every ad placed on the active page as published' })}
          </div>
          ${ads.length ? adGroups(s, ads, busy)
            : html`<div class="list-empty">${m.ads && m.ads.unavailable ? 'The display-ad feed did not respond.' : 'No scheduled ads with artwork for this edition.'}</div>`}`,
      })}`;
  }

  function liner(label, kind, n, busy) {
    return html`<div class="row">
      <span class="cell-main"><span class="row-title">${label}</span></span>
      <span class="cell-state">${ui.badge(String(n), 'neutral', `${n} available`)}</span>
      <span class="cell-actions">${ui.action({ label: 'Place', action: 'placeLiners', arg: kind, disabled: busy || !n, emphasis: !!n })}</span>
    </div>`;
  }

  // Liner sections first: this tab is the one open while laying out liners.
  // Run-of-paper ads are placed from the Page Grid.
  function adGroups(s, ads, busy) {
    const groups = { classified: [], legal: [], rop: [] };
    for (const a of ads) (groups[a.adSection] || groups.rop).push(a);
    return SECTIONS.filter((g) => groups[g.key].length).map((g) => html`
      <div class="group-label">${g.label} <span class="section-count">${groups[g.key].length}</span></div>
      <div class="list">${groups[g.key].map((a) => adRow(s, a, busy))}</div>`);
  }

  function adRow(s, a, busy) {
    const placedOn = (s.placedAds || {})[String(a.id)];
    const dims = a.widthIn && a.heightIn ? `${a.widthIn} × ${a.heightIn} in` : '';
    return html`<div class="row">
      <span class="cell-main">
        <span class="row-title">${a.advertiser || 'Display ad'}</span>
        <span class="row-meta">${[a.sizeCode, dims].filter(Boolean).join(' · ') || ' '}</span>
      </span>
      <span class="cell-state">
        ${a.colorRequired ? ui.badge('Color', 'accent', 'Must go on a full-colour page') : ''}
        ${a.adSectionSource === 'inferred' ? ui.light('Inferred', 'notice', 'Section inferred from the old Section field, not set on the order') : ''}
        ${placedOn ? ui.light(placedOn, 'positive', `Placed on ${placedOn} this session`) : ''}
      </span>
      <span class="cell-actions">${ui.action({ label: 'Place', action: 'placeAd', arg: String(a.id), disabled: busy })}</span>
    </div>`;
  }

  return { render };
}

module.exports = { createMarketplaceView };
