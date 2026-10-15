// The frame every screen sits in:
//
//   context bar   the edition you are working in, and Change
//   tabs          Pages · Budget · Marketplace · Setup
//   activity      what is running right now, by name
//   content       the tab, scrolling on its own
//   status bar    the outcome of the last action, with details on request
//   footer        server, version, sign out
//
// Messages live in the status bar at the bottom instead of being pushed into
// the top of the content, where a long build summary used to shove the page
// list off screen.

function createShell({ html, cx, fmt, ui, views, meta }) {
  const TABS = [
    { id: 'pages', label: 'Pages' },
    { id: 'budget', label: 'Budget' },
    { id: 'marketplace', label: 'Marketplace' },
    { id: 'setup', label: 'Setup' },
  ];

  function render(s, d) {
    if (s.booting) return html`<div class="app"><div class="content">${ui.empty({ busy: true, title: 'Starting…' })}</div></div>`;
    if (!s.user) {
      return html`<div class="app">
        <div class="content" data-scroll-key="signin">${views.overlays.signIn(s)}</div>
        ${status(s)}
        ${footer(s, false)}
      </div>`;
    }
    const view = s.view === 'pages' && !s.edition ? 'setup' : s.view;
    let body;
    if (view === 'pages') body = views.pages.render(s, d);
    else if (view === 'budget') body = views.budget.render(s, d);
    else if (view === 'marketplace') body = views.marketplace.render(s, d);
    else body = views.setup.render(s, d);

    return html`<div class="app">
      ${context(s)}
      ${tabs(s, view)}
      ${activity(s)}
      <div class="content" data-scroll-key="${view}${view === 'budget' && s.storyId ? ':story' : ''}">${body}</div>
      ${status(s)}
      ${footer(s, true)}
      ${views.overlays.datePicker(s)}
    </div>`;
  }

  function context(s) {
    const ed = s.edition;
    if (!ed) {
      return html`<div class="ctx ctx--empty">
        <div class="ctx-main">
          <div class="ctx-title">No edition chosen</div>
          <div class="ctx-meta">Choose one in Setup to start.</div>
        </div>
      </div>`;
    }
    const site = s.sites.find((x) => x.id === ed.siteId);
    return html`<div class="ctx">
      <div class="ctx-main">
        <div class="ctx-title">${fmt.fmtDate(ed.editionDate) || ed.editionDate}</div>
        <div class="ctx-meta" title="${ed.id}">${[site && site.name, fmt.plural((ed.pages || []).length, 'page'), ed.id].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="ctx-side">
        ${ui.light(statusLabel(ed.status), statusKind(ed.status))}
        ${ui.action({ label: 'Change', action: 'changeEdition', disabled: !!s.activity, title: 'Work in a different edition' })}
      </div>
    </div>`;
  }

  function tabs(s, view) {
    return html`<div class="tabs" role="tablist">
      ${TABS.map((t) => {
        const disabled = t.id === 'pages' && !s.edition;
        return html`<div class="${cx('tab', view === t.id && 'is-active', disabled && 'is-disabled')}" role="tab"
          aria-selected="${view === t.id ? 'true' : 'false'}" data-action="setView" data-arg="${t.id}"${disabled ? html` aria-disabled="true"` : ''}>${t.label}${badgeFor(s, t.id)}</div>`;
      })}
    </div>`;
  }

  // A count on Pages while you hold pages, so the tab says "you have work open".
  function badgeFor(s, tab) {
    if (tab !== 'pages' || !s.edition) return '';
    const n = Object.values(s.checkouts || {}).filter((c) => c.editionId === s.edition.id).length;
    return n ? html`<span class="tab-count">${n}</span>` : '';
  }

  function activity(s) {
    const a = s.activity;
    return html`<div class="${cx('activity', a && 'is-on')}">
      <div class="activity-bar"><div class="activity-fill"></div></div>
      ${a ? html`<div class="activity-text"><b>${a.label}</b>${a.detail ? html` — ${a.detail}` : ''}</div>` : ''}
    </div>`;
  }

  function status(s) {
    const m = s.message;
    if (!m) return '';
    const kind = m.kind || 'info';
    return html`<div class="${cx('status', `status--${kind}`)}" role="status">
      <div class="status-row">
        <span class="status-dot" aria-hidden="true"></span>
        <span class="status-text">${m.text}</span>
        <span class="status-actions">
          ${m.details ? ui.action({ label: s.detailsOpen ? 'Hide' : 'Details', action: 'toggleDetails' }) : ''}
          ${ui.action({ label: s.copied ? 'Copied' : 'Copy', action: 'copyMessage', title: 'Copy this message' })}
          ${ui.action({ label: '✕', action: 'dismissMessage', title: 'Dismiss' })}
        </span>
      </div>
      ${m.details && s.detailsOpen ? html`<textarea id="status-details" class="status-details" readonly rows="${detailRows(m.details)}">${m.details}</textarea>` : ''}
    </div>`;
  }

  // Tall enough for the text as it wraps at panel width, up to a limit.
  function detailRows(text) {
    const lines = String(text).split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 44)), 0);
    return Math.min(12, Math.max(3, lines));
  }

  function footer(s, signedIn) {
    return html`<div class="foot">
      <span class="foot-text">${meta.server}${meta.version ? ` · v${meta.version}` : ''}</span>
      ${signedIn ? ui.action({ label: 'Sign Out', action: 'signOut', disabled: !!s.activity }) : ''}
    </div>`;
  }

  function statusLabel(st) {
    return ({ planned: 'Planned', building: 'Building', built: 'Built', published: 'Published' })[st] || 'Planned';
  }
  function statusKind(st) {
    return ({ built: 'positive', published: 'positive', building: 'notice' })[st] || 'neutral';
  }

  return { render };
}

module.exports = { createShell };
