// Shared building blocks. Every control is a Spectrum UXP widget, so buttons,
// checkboxes and pickers look and behave like the rest of InDesign and follow
// its interface brightness setting without any styling of ours.

function createCommon({ html, cx, flag }) {
  // Call-to-action, primary, secondary. One CTA per screen at most.
  function button({ label, action, arg = '', variant = 'secondary', quiet = false, disabled = false, title = '', wide = false }) {
    return html`<sp-button class="${cx('btn', wide && 'btn--wide')}" variant="${variant}" size="s"${flag('quiet', quiet)}${flag('disabled', disabled)}
      data-action="${action}" data-arg="${arg}" title="${title}">${label}</sp-button>`;
  }

  // Compact action inside a row or a section header. Quiet unless it stands
  // alone as a chip. `secondary` dims an action repeated on every row so the
  // row's main action reads first; hovering the row brings it up.
  function action({ label, action: name, arg = '', disabled = false, title = '', emphasis = false, secondary = false, quiet = true }) {
    return html`<sp-action-button class="${cx('act', emphasis && 'act--emphasis', secondary && 'act--secondary', !quiet && 'act--chip')}" size="s"${flag('quiet', quiet)}${flag('disabled', disabled)}
      data-action="${name}" data-arg="${arg}" title="${title}">${label}</sp-action-button>`;
  }

  // A label: neutral (a version, a count) or a solid fill for the few that
  // must stand out — accent | positive | notice | negative.
  function badge(text, kind = 'neutral', title = '') {
    return html`<span class="${`badge badge--${kind}`}" title="${title}">${text}</span>`;
  }

  // A status (Built, Placed, whose lock): Spectrum's status light, a coloured
  // dot beside text in the normal colour. Coloured text itself is unreadable
  // on InDesign's medium themes. neutral | accent | positive | notice | negative
  function light(text, kind = 'neutral', title = '') {
    return html`<span class="${`light light--${kind}`}" title="${title}"><span class="light-dot" aria-hidden="true"></span>${text}</span>`;
  }

  function section({ title, count = null, actions = null, body, flush = false }) {
    // Plain divs: UXP's built-in styles cannot be relied on to make
    // <section> and <header> blocks the way a browser does.
    return html`<div class="${cx('section', flush && 'section--flush')}">
      <div class="section-head">
        <span class="section-title">${title}${count != null ? html` <span class="section-count">${count}</span>` : ''}</span>
        ${actions ? html`<span class="section-actions">${actions}</span>` : ''}
      </div>
      ${body}
    </div>`;
  }

  function empty({ title, text = '', actions = null, busy = false }) {
    return html`<div class="empty">
      ${busy ? html`<div class="spinner" aria-hidden="true"></div>` : ''}
      <div class="empty-title">${title}</div>
      ${text ? html`<div class="empty-text">${text}</div>` : ''}
      ${actions ? html`<div class="empty-actions">${actions}</div>` : ''}
    </div>`;
  }

  function hint(text) {
    return html`<div class="hint">${text}</div>`;
  }

  function divider() {
    return html`<sp-divider size="small" class="divider"></sp-divider>`;
  }

  // A labelled field: <label> above the control.
  function field(label, control, note = '') {
    return html`<div class="field">
      <div class="field-label">${label}</div>
      ${control}
      ${note ? html`<div class="field-note">${note}</div>` : ''}
    </div>`;
  }

  // Spectrum picker. `options` = [{ value, label }]. UXP marks the chosen item
  // with `selected` on the menu item.
  function picker({ id, change, arg = '', value, options, placeholder = 'Choose…', disabled = false, wide = true }) {
    return html`<sp-picker id="${id}" class="${cx('picker', wide && 'picker--wide')}" size="s" label="${placeholder}"${flag('disabled', disabled)}
      data-change="${change}" data-arg="${arg}">
      <sp-menu slot="options">
        ${options.map((o) => html`<sp-menu-item value="${o.value}"${flag('selected', o.value === value)}>${o.label}</sp-menu-item>`)}
      </sp-menu>
    </sp-picker>`;
  }

  function textfield({ id, input, change = '', arg = '', value = '', placeholder = '', type = 'text', enter = '', className = '' }) {
    return html`<sp-textfield id="${id}" class="${cx('textfield', className)}" size="s" type="${type}" placeholder="${placeholder}"
      value="${value}" data-input="${input}" data-arg="${arg}"${change ? html` data-change="${change}"` : ''}${enter ? html` data-enter="${enter}"` : ''}></sp-textfield>`;
  }

  // The heading of a screen you drilled into: a story, the plan form.
  function head({ title, meta = '', badges = null }) {
    return html`<div class="head">
      <div class="head-title">${title}</div>
      ${meta ? html`<div class="head-meta">${meta}</div>` : ''}
      ${badges ? html`<div class="head-badges">${badges}</div>` : ''}
    </div>`;
  }

  return { button, action, badge, light, section, empty, hint, divider, field, picker, textfield, head };
}

module.exports = { createCommon };
