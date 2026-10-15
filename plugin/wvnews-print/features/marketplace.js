// Marketplace: classifieds, legals, obituaries and display ads for the edition.

function createMarketplace(ctx) {
  const { store, run, api, id, fmt, fail, colorPlacement } = ctx;

  const edition = () => {
    const ed = store.state.edition;
    if (!ed) throw fail('Choose an edition first.');
    return ed;
  };

  function load() {
    return run('Loading the marketplace', async () => {
      const ed = edition();
      const get = (kind) => api.fetchMarketplace(ed.siteId, kind, ed.editionDate);
      const [classifieds, legals, obits, ads] = await Promise.all([
        get('classifieds'), get('legals'), get('obits'),
        // The ads feed needs the date and is the one most likely to be down;
        // it must never take the rest of the marketplace with it.
        get('ads').catch(() => ({ count: 0, items: [], unavailable: true })),
      ]);
      store.set({
        market: { classifieds, legals, obits, ads, editionId: ((ads.items || [])[0] || {}).editionId || ed.id },
      });
      // A load that works says nothing: the counts are on screen.
      return ads.unavailable
        ? { kind: 'warning', text: 'Liners loaded, but the display-ad feed did not respond. Refresh to try again.' }
        : null;
    });
  }

  async function sectionHeaderUrls() {
    const out = {};
    try {
      const sh = await api.fetchSectionHeaders();
      for (const h of (sh && sh.headers) || []) out[h.slug] = h.url;
    } catch (err) {
      console.warn('[wvnews-print] section headers unavailable:', err.message);
    }
    return out;
  }

  const LABEL = { classifieds: 'classifieds', legals: 'legal notices', obits: 'obituaries' };

  function placeLiners(kind) {
    return run(`Placing ${LABEL[kind] || kind}`, async () => {
      const items = (store.state.market && store.state.market[kind] && store.state.market[kind].items) || [];
      if (!items.length) throw fail(`There are no ${LABEL[kind] || kind} to place.`);
      const headers = kind === 'classifieds' ? await sectionHeaderUrls() : null;
      const r = await id.placeMarketplaceBlock(kind, items, null, headers);
      return `Placed ${r.placed} ${LABEL[kind] || kind} into ${r.frame || 'the selected frame'}.`;
    });
  }

  function updateHeaders() {
    return run('Updating section headers', async () => {
      const r = await id.updateSectionHeaders(await sectionHeaderUrls());
      return `Moved ${fmt.plural(r.placed, 'column header')} to the current layout.`;
    });
  }

  // Place one display ad at its real size on the active page, refuse a colour ad
  // on a black-and-white page, and record it (which marks it placed on the site).
  function placeAd(adId) {
    return run('Placing the ad', async () => {
      const ed = edition();
      const ads = (store.state.market && store.state.market.ads && store.state.market.ads.items) || [];
      const ad = ads.find((a) => String(a.id) === String(adId));
      if (!ad) throw fail('That ad is no longer in the feed. Reload the marketplace.');
      const folio = safe(() => id.activePageLabel(), '');
      const verdict = colorPlacement.isColorPage({
        format: ed.pageFormat || 'broadsheet',
        totalPages: safe(() => id.activeDocPageCount(), 0),
        folio,
      });
      if (ad.colorRequired && verdict && verdict.color === false) {
        throw fail(`${ad.advertiser || 'This ad'} needs colour, but ${folio || 'this page'} prints black and white.`);
      }
      const r = await id.placeAdSized(ad);
      await api.recordPlacement({
        assetId: ad.id,
        siteId: ed.siteId,
        editionDate: ed.editionDate,
        // The order's newspaper folio first: InDesign's page NAME ("1") is not one.
        pageAssignment: ad.pageAssignment || r.page || folio || 'A1',
        documentName: '',
        frameLabel: r.frameLabel,
        status: 'placed',
      });
      store.set({ placedAds: { ...store.state.placedAds, [String(ad.id)]: r.page || folio || '' } });
      const unsure = ad.colorRequired && verdict && verdict.color === null;
      return {
        kind: unsure ? 'warning' : 'success',
        text: `Placed ${ad.advertiser || 'the ad'} on ${r.page || folio || 'the page'}.`
          + (unsure ? ' Could not confirm this is a colour page.' : ''),
      };
    });
  }

  // Mark every placed ad on the active page published for this edition.
  function publishPage() {
    return run('Publishing placed ads', async () => {
      const market = store.state.market;
      const editionId = (market && market.editionId) || edition().id;
      const orderIds = id.placedAdOrderIdsOnActivePage();
      if (!orderIds.length) throw fail('The active page has no placed ads to publish.');
      const r = await api.publishAds({ editionId, orderIds });
      const pub = ((r && r.published) || []).length;
      const skip = ((r && r.skipped) || []).length;
      const errs = ((r && r.errors) || []).length;
      try {
        const ed = edition();
        const ads = await api.fetchMarketplace(ed.siteId, 'ads', ed.editionDate);
        store.set({ market: { ...store.state.market, ads } });
      } catch { /* the publish stands; the list refreshes on the next load */ }
      return {
        kind: errs ? 'warning' : 'success',
        text: `Published ${fmt.plural(pub, 'ad')}${skip ? `, ${skip} already published` : ''}${errs ? `, ${errs} failed` : ''}.`,
      };
    });
  }

  return { load, placeLiners, updateHeaders, placeAd, publishPage };
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

module.exports = { createMarketplace };
