// Classified categories in print: which section-header banner a category
// gets, and the order the classified section runs in.
//
// Michael 2026-11-18 replaced the 8 classified categories with 29, and asked
// for two things here:
//   * the section runs in the ORDER of the category list (Community Notices &
//     Events first, RVs last), not A–Z. The website sends each listing's
//     place in the live list as `categoryRank`, so a reordered list in
//     /admin/pricing reaches print without a plugin change.
//   * every category gets its OWN banner; he is drawing them. Until a banner
//     exists, a category gets a styled text header, not the nearest old
//     banner. (The old matching sent "Furniture & Household Goods" and
//     "RVs Trailers & Motorhomes" to the Real Estate banner — "house",
//     "home" — and everything else to OTHER.)
//
// ZERO REQUIRES (see ad-piece.js): indesign.js requires this.

// A category's banner name: the file is page-layout-elements/section-headers/
// <slug>.pdf on the website. "Books, Music & Hobbies" → "books-music-hobbies".
function categorySlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The banners drawn for the OLD category names, for ads still filed under
// one. Only these names borrow a banner under another name; a current
// category uses the banner named for it or a text header.
const LEGACY_BANNERS = {
  'for sale': 'for-sale',
  'vehicles': 'vehicles',
  'real estate': 'real-estate',
  'real estate — for sale': 'real-estate',
  'real estate — for rent': 'real-estate',
  'homes for sale': 'real-estate',
  'homes for rent': 'real-estate',
  'help wanted': 'help-wanted',
  'services': 'services',
  'services offered': 'services',
  'pets': 'pets',
  'pets & livestock': 'pets',
  'yard sale': 'yard-sale',
  'yard & estate sales': 'yard-sale',
  'other': 'other',
  'classifieds': 'other',
  'notices & personal': 'other',
  'farm & outdoor': 'other',
  'free / giveaway': 'other',
  'wanted to buy': 'other',
  'lost & found': 'other',
  'antiques/collectibles': 'other',
  'legals': 'legals',
  'legal notices': 'legals',
  'public notices': 'legals',
};

// The banner for a category, or null for a text header. `available` is the
// website's banners: a slug → url map (what Place Content builds) or a Set.
function headerSlugFor(category, available) {
  const has = (slug) => !!slug && !!available
    && (available instanceof Set ? available.has(slug) : !!available[slug]);
  const own = categorySlug(category);
  if (has(own)) return own;
  const legacy = LEGACY_BANNERS[String(category || '').trim().toLowerCase()];
  return has(legacy) ? legacy : null;
}

// The categories of a page's classifieds, in print order: by the website's
// `categoryRank` (the category's place in the live list), then A–Z for a
// name with no rank — an old category on an ad nobody re-sorted — so a
// listing is never dropped for being off the list. byCat: Map(name → items).
function orderCategories(byCat) {
  const rankOf = (items) => {
    let best = Infinity;
    for (const it of items || []) {
      const r = it && it.categoryRank;
      if (typeof r === 'number' && Number.isFinite(r) && r < best) best = r;
    }
    return best;
  };
  return [...byCat.keys()]
    .map((name) => ({ name, rank: rankOf(byCat.get(name)) }))
    // Infinity - Infinity is NaN, which is falsy, so two unranked names fall
    // through to A–Z.
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name))
    .map((x) => x.name);
}

module.exports = { categorySlug, headerSlugFor, orderCategories, LEGACY_BANNERS };
