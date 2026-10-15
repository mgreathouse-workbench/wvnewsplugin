// Paints the panel, without fighting the person using it.
//
// The panel is drawn by replacing #root's innerHTML — the simplest thing UXP
// reliably supports. The old controller did that synchronously on every state
// change, which caused three of the problems reported against it:
//
//   * LOST CLICKS. A background timer repainted the whole panel every four
//     seconds. A repaint between mouse-down and mouse-up replaces the button
//     under the cursor, so the click never fires. "Clicking around freezes it."
//   * SCROLL JUMPS. Every repaint reset a scrolled list to the top.
//   * FOCUS LOSS. Typing into a field during a repaint dropped the caret.
//
// So paints are BATCHED (any number of state changes in one tick become one
// paint), DEFERRED while a mouse button is down (the paint happens on release,
// after the click has been delivered), and they PRESERVE the scroll position
// of every container marked data-scroll-key and the focused field by id.
//
// A render that throws does not leave the last frame on screen pretending to be
// live — that froze the panel on "Loading…" for a full afternoon. It paints an
// error screen with the stack in a selectable box instead.

function createRenderer({ root, render, onError }) {
  let scheduled = false;
  let pointerDown = false;
  let pending = false;
  const scrollByKey = new Map();

  // Mouse events, not pointer events: UXP's support for the latter varies by
  // version, and these two are all that is needed.
  root.addEventListener('mousedown', () => { pointerDown = true; }, true);
  const release = () => {
    if (!pointerDown) return;
    pointerDown = false;
    // Let the click that follows mouse-up be delivered to the element that is
    // still on screen, then paint whatever accumulated meanwhile.
    if (pending) { pending = false; setTimeout(schedule, 0); }
  };
  root.addEventListener('mouseup', release, true);
  try { document.addEventListener('mouseup', release, true); } catch { /* panel-only is fine */ }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // setTimeout rather than requestAnimationFrame: availability of the latter
    // has varied across UXP releases, and a 0ms timeout batches just as well.
    setTimeout(flush, 0);
  }

  function flush() {
    scheduled = false;
    if (pointerDown) { pending = true; return; }
    paint();
  }

  function captureFocus() {
    try {
      const el = document.activeElement;
      if (!el || !el.id || !root.contains(el)) return null;
      let start = null;
      let end = null;
      try { start = el.selectionStart; end = el.selectionEnd; } catch { /* not a text field */ }
      return { id: el.id, start, end };
    } catch { return null; }
  }

  function restoreFocus(f) {
    if (!f) return;
    try {
      const el = document.getElementById(f.id);
      if (!el || typeof el.focus !== 'function') return;
      el.focus();
      if (f.start != null && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(f.start, f.end);
      }
    } catch { /* focus is a nicety, never a failure */ }
  }

  function paint() {
    try {
      for (const el of root.querySelectorAll('[data-scroll-key]')) {
        scrollByKey.set(el.getAttribute('data-scroll-key'), el.scrollTop);
      }
    } catch { /* first paint: nothing to keep */ }
    const focus = captureFocus();

    let markup;
    try {
      markup = render();
    } catch (err) {
      markup = errorScreen(err);
      try { onError && onError(err); } catch { /* never let the reporter throw */ }
    }
    root.innerHTML = markup;

    try {
      for (const el of root.querySelectorAll('[data-scroll-key]')) {
        const top = scrollByKey.get(el.getAttribute('data-scroll-key'));
        if (top) el.scrollTop = top;
      }
    } catch { /* a container that cannot scroll needs nothing restored */ }
    restoreFocus(focus);
  }

  // Deliberately plain concatenation with no helpers: whatever just failed
  // might BE a helper, and a second throw here would be a silent freeze again.
  function errorScreen(err) {
    const msg = String((err && (err.stack || err.message)) || err)
      .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<div class="crash">'
      + '<div class="crash-title">The panel could not draw this screen.</div>'
      + '<div class="crash-text">This is a bug in the plugin. Nothing on the website has changed. '
      + 'Switch tabs to try again, or reload the plugin. Copy the text below when reporting it.</div>'
      + '<textarea class="crash-trace" readonly rows="10">' + msg + '</textarea>'
      + '</div>';
  }

  return { schedule, paintNow: paint };
}

module.exports = { createRenderer };
