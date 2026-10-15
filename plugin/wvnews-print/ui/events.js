// One listener per event type, on the panel root, for the life of the panel.
//
// The old controller re-bound a handler to every button after every paint:
// `$('btn-load').onclick = …`. When #25 made some buttons conditional, a
// binding to an element that was no longer rendered threw
//
//     TypeError: Cannot set properties of null (setting 'onchange')
//
// and took the whole panel down. Delegation removes the class of bug: markup
// says what it does with data-action / data-change / data-input, and the
// handler is looked up when the event arrives. An element that is not on
// screen simply never sends one.
//
//   <sp-button data-action="checkin" data-arg="A6">Check In</sp-button>
//   <sp-checkbox data-change="toggleAutoCheckin">…</sp-checkbox>
//   <sp-textfield data-input="setJumpSlug">…</sp-textfield>
//
// Handlers receive (arg, element, event). `arg` is data-arg, the one value most
// actions need — a folio, an id, a kind.
//
// Listeners are on the CAPTURE phase. Capture reaches #root on the way down to
// the target whether or not the event bubbles, and whether a Spectrum
// widget's change event bubbles in every UXP release is not something the
// panel should have to depend on.

function createEvents({ root, handlers, log = console }) {
  // Walk up by hand: Element.closest() is not guaranteed in every UXP release.
  function find(el, attr) {
    while (el && el !== root.parentNode) {
      try {
        if (el.getAttribute && el.getAttribute(attr) != null) return el;
      } catch { /* text node or detached */ }
      el = el.parentNode;
    }
    return null;
  }

  function isDisabled(el) {
    try {
      return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    } catch { return false; }
  }

  // Look up a handler and call it. A throw — or a rejected promise — is
  // logged, never left to escape into UXP.
  function invoke(kind, name, el, args) {
    const fn = handlers[kind] && handlers[kind][name];
    if (!fn) {
      log.warn(`[wvnews-print] no ${kind} handler for "${name}"`);
      return;
    }
    try {
      const out = fn(...args);
      if (out && typeof out.catch === 'function') {
        out.catch((err) => log.error(`[wvnews-print] ${name} failed:`, err));
      }
    } catch (err) {
      log.error(`[wvnews-print] ${name} failed:`, err);
    }
  }

  function dispatch(kind, attr, e, read) {
    const el = find(e.target, attr);
    if (!el || isDisabled(el)) return;
    const arg = el.getAttribute('data-arg');
    invoke(kind, el.getAttribute(attr), el, read ? [read(el), arg, el, e] : [arg, el, e]);
  }

  root.addEventListener('click', (e) => dispatch('click', 'data-action', e), true);
  root.addEventListener('change', (e) => dispatch('change', 'data-change', e, valueOf), true);
  root.addEventListener('input', (e) => dispatch('input', 'data-input', e, valueOf), true);
  // Enter on a field or control runs the click action it names in data-enter.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = find(e.target, 'data-enter');
    if (!el || isDisabled(el)) return;
    invoke('click', el.getAttribute('data-enter'), el, [el.getAttribute('data-arg'), el, e]);
  }, true);
}

// The value a control holds, across plain inputs and Spectrum widgets.
function valueOf(el) {
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'sp-checkbox' || tag === 'sp-switch' || el.type === 'checkbox') return !!el.checked;
  if (tag === 'sp-picker' || tag === 'select') {
    if (el.value != null && el.value !== '') return el.value;
    // Older UXP pickers expose only selectedIndex.
    try {
      const items = el.querySelectorAll('sp-menu-item, option');
      const i = el.selectedIndex;
      if (i != null && i >= 0 && items[i]) return items[i].getAttribute('value') || '';
    } catch { /* fall through */ }
    return '';
  }
  return el.value == null ? '' : el.value;
}

module.exports = { createEvents, valueOf };
