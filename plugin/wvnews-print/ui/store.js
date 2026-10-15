// One state object, one way to change it.
//
// The old panel mutated a global `state` from 60-odd places and called
// render() by hand afterwards — sometimes twice, sometimes not at all, which is
// how a successful publish left every button disabled for the rest of the
// session. Here every change goes through set(), and set() is what tells the
// renderer to repaint. Nobody calls render() directly.

function createStore(initial) {
  const state = initial;
  const listeners = new Set();

  // set({ a: 1 }) merges; set(s => ({ a: s.a + 1 })) derives from current.
  function set(patch) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    if (p && typeof p === 'object') Object.assign(state, p);
    for (const fn of listeners) {
      try { fn(state); } catch (err) { console.error('[wvnews-print] store listener failed:', err); }
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { state, set, subscribe };
}

module.exports = { createStore };
