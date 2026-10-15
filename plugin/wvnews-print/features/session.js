// Sign-in, sign-out, publications, and getting back to where you were.

function createSession(ctx) {
  const { store, run, api, auth, host, persist } = ctx;

  // Restore the panel to the edition and tab it was on.
  //
  // Reloading the panel used to drop you on an empty Setup screen, and every
  // plugin update is a reload — there were a dozen on 2026-10-15 alone. The
  // checkouts already survived (they live on the global); the edition you were
  // working in now does too.
  async function boot() {
    const token = await auth.getAccessToken().catch(() => null);
    if (!token) {
      store.set({ user: null, booting: false });
      return;
    }
    store.set({ user: { signedIn: true } });
    await loadSites();
    const lastId = persist.lastEditionId;
    if (lastId) {
      await ctx.editions.select(lastId, { quiet: true, view: persist.lastView || 'pages' });
    } else {
      store.set({ view: 'setup' });
      await ctx.editions.load();
    }
    store.set({ booting: false });
    ctx.pages.resume();
  }

  async function loadSites() {
    store.set({ sitesLoading: true });
    try {
      const res = await api.fetchSites();
      const sites = (res && res.sites) || [];
      const siteId = store.state.siteId || (sites[0] && sites[0].id) || '';
      store.set({ sites, siteId });
    } catch (err) {
      store.set({ message: { kind: 'error', text: `Could not load publications: ${err.message}` } });
    } finally {
      store.set({ sitesLoading: false });
    }
  }

  function openSignIn() {
    return run('Opening sign-in page', async () => {
      const url = await auth.beginAuthorize();
      // The authorize URL carries the PKCE challenge and state; log only where
      // it points, never the whole thing.
      try { const u = new URL(url); console.log('[wvnews-print] sign-in:', u.origin + u.pathname); } catch { /* fine */ }
      await host.openExternal(url);
      return { kind: 'info', text: 'Your browser is open. Sign in there, then paste the code it shows you below.' };
    });
  }

  function setSignInCode(value) {
    store.state.signInCode = String(value || '');   // no repaint needed while typing
  }

  function finishSignIn() {
    const code = String(store.state.signInCode || '').trim();
    if (!code) {
      store.set({ message: { kind: 'error', text: 'Paste the code from your browser first.' } });
      return undefined;
    }
    return run('Signing in', async () => {
      await auth.exchangeCode(code);
      store.set({ user: { signedIn: true }, signInCode: '', view: 'setup' });
      await loadSites();
      await ctx.editions.load();
      return 'Signed in.';
    });
  }

  function signOut() {
    return run('Signing out', async () => {
      await auth.signOut();
      persist.lastEditionId = null;
      store.set({
        user: null, sites: [], siteId: '', edition: null, editions: [],
        budget: null, market: null, storyId: null, form: null, pageFiles: {},
      });
      return { kind: 'info', text: 'Signed out.' };
    });
  }

  return { boot, loadSites, openSignIn, setSignInCode, finishSignIn, signOut };
}

module.exports = { createSession };
