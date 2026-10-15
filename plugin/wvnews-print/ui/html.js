// HTML templating for the panel.
//
// `html` is a tagged template that ESCAPES every interpolated value unless it
// was itself produced by `html` (or wrapped in `raw`). The old panel built
// markup by concatenating strings and calling escapeHtml() by hand at each
// site — forget it once and a headline containing `<` or `"` breaks the panel.
// Escaping by default turns that from a discipline into a property.
//
//   html`<div title=${story.headline}>${story.headline}</div>`   // safe
//   html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`         // arrays join
//   html`${cond && html`<b>shown when cond</b>`}`                 // false/null → ''
//
// Pure and dependency-free: required only by app.js and handed to the views,
// so no module under ui/ or views/ ever resolves a relative path itself.

const SAFE = Symbol('wvnews.safe-html');

function raw(value) {
  return { [SAFE]: true, value: value == null ? '' : String(value) };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function isSafe(v) {
  return !!(v && typeof v === 'object' && v[SAFE]);
}

// null, undefined, false and true all render as nothing, so `cond && html`…``
// works in both directions. 0 is a value and renders as "0".
function toHtml(v) {
  if (v == null || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (isSafe(v)) return v.value;
  return escapeHtml(v);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return raw(out);
}

// Space-separated class list from truthy entries: cx('row', on && 'is-on').
function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

// Boolean attribute: present when true, absent otherwise. Spectrum widgets
// read `disabled`, `checked`, `selected`, `quiet` as presence, not value.
function flag(name, on) {
  return raw(on ? ` ${name}` : '');
}

// The final string for root.innerHTML.
function render(v) {
  return toHtml(v);
}

module.exports = { html, raw, escapeHtml, cx, flag, render, isSafe };
