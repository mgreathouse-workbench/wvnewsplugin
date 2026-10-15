// Every user action runs through run(). Nothing else sets `activity`.
//
// The old controller had twenty-one hand-written copies of
//
//     state.busy = true; render();
//     try { … } catch { … } finally { state.busy = false; render(); }
//
// and one of them put the reset in the catch instead of the finally. A publish
// that SUCCEEDED therefore left every button in the panel disabled for the rest
// of the session, with nothing on screen and nothing in the console, because
// nothing had gone wrong. With one runner there is one finally, and the bug
// cannot be written again.
//
// It also gives every action:
//   * a NAME on screen while it runs ("Checking in A6…"), not "Working…"
//   * progress text the action can update as it goes
//   * exactly one outcome message, success or error, replacing the last
//   * refusal to start while another action is running — InDesign scripting
//     is single-threaded, and two operations interleaving inside it is how a
//     place gun ends up owned by the wrong one
//
// An action returns either nothing, a string, or { kind, text, details }.
// Throwing reports an error; err.details carries multi-line detail (a build
// summary, a stack) that the status bar keeps behind a "Details" toggle.

function createActions({ store, log = console }) {
  async function run(label, fn) {
    if (store.state.activity) {
      store.set({
        message: { kind: 'info', text: `Wait for “${store.state.activity.label}” to finish.` },
      });
      return undefined;
    }
    store.set({ activity: { label, detail: '' }, message: null, detailsOpen: false });
    const progress = (detail) => {
      if (store.state.activity) store.set({ activity: { label, detail: String(detail || '') } });
    };
    try {
      const result = await fn({ progress });
      const message = toMessage(result);
      if (message) store.set({ message });
      return result;
    } catch (err) {
      // An outcome the code anticipated and explained (fail()) is a warning;
      // anything else is a bug or an outage, logged with its stack.
      if (err && err.expected) log.warn(`[wvnews-print] ${label}: ${err.message}`);
      else log.error(`[wvnews-print] ${label} failed:`, err);
      store.set({
        message: {
          kind: 'error',
          text: (err && err.message) || String(err),
          details: (err && err.details) || '',
        },
      });
      return undefined;
    } finally {
      store.set({ activity: null });
    }
  }

  return { run };
}

function toMessage(result) {
  if (!result) return null;
  if (typeof result === 'string') return { kind: 'success', text: result };
  if (typeof result === 'object' && result.text) {
    return { kind: result.kind || 'success', text: result.text, details: result.details || '' };
  }
  return null;
}

// An anticipated failure, worded for the operator, optionally carrying detail
// the status bar can show on request.
function fail(text, details) {
  const err = new Error(text);
  err.expected = true;
  if (details) err.details = Array.isArray(details) ? details.join('\n') : String(details);
  return err;
}

module.exports = { createActions, fail };
