// The classified section: which banner each category gets, and the order the
// categories print in.
//
//   npm test
//
// Michael 2026-11-18 replaced the 8 categories with 29, to print in the list's
// order, each under its own banner (he is drawing them) or a text header until
// it exists. The old matching sorted A–Z, gave most new categories the OTHER
// banner, and gave "Furniture & Household Goods" and "RVs Trailers &
// Motorhomes" the Real Estate one.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { categorySlug, headerSlugFor, orderCategories } =
  require(path.join(__dirname, '..', 'plugin', 'wvnews-print', 'classified-categories.js'));

// The banners on the website today.
const TODAY = { 'for-sale': 'u', vehicles: 'u', 'real-estate': 'u', 'help-wanted': 'u',
  services: 'u', pets: 'u', 'yard-sale': 'u', other: 'u', legals: 'u' };

test('a banner is named for its category', () => {
  assert.equal(categorySlug('Books, Music & Hobbies'), 'books-music-hobbies');
  assert.equal(categorySlug('Guns, Bows & Knives'), 'guns-bows-knives');
  assert.equal(categorySlug('RVs Trailers & Motorhomes'), 'rvs-trailers-motorhomes');
  assert.equal(categorySlug('Help Wanted'), 'help-wanted');
});

test('a current category uses its own banner when the website has one', () => {
  assert.equal(headerSlugFor('Help Wanted', TODAY), 'help-wanted');
  assert.equal(headerSlugFor('Pets', TODAY), 'pets');
  assert.equal(headerSlugFor('Boats', { ...TODAY, boats: 'u' }), 'boats');
});

test('a current category with no banner yet gets a text header, never a borrowed one', () => {
  for (const c of ['Furniture & Household Goods', 'RVs Trailers & Motorhomes', 'Real Estate & Rentals',
    'Cars Trucks SUVs & Vans', 'Livestock', 'Miscellaneous Merchandise', 'Community Notices & Events']) {
    assert.equal(headerSlugFor(c, TODAY), null, c);
  }
});

test('an ad still under an old category keeps the banner drawn for it', () => {
  assert.equal(headerSlugFor('For Sale', TODAY), 'for-sale');
  assert.equal(headerSlugFor('Real Estate — For Rent', TODAY), 'real-estate');
  assert.equal(headerSlugFor('Yard Sale', TODAY), 'yard-sale');
  assert.equal(headerSlugFor('Other', TODAY), 'other');
});

test('no banners at all means text headers', () => {
  assert.equal(headerSlugFor('Pets', null), null);
  assert.equal(headerSlugFor('Pets', new Set()), null);
  assert.equal(headerSlugFor('Pets', new Set(['pets'])), 'pets');
});

test('categories print in list order, by the rank the website sends', () => {
  const byCat = new Map([
    ['Boats', [{ categoryRank: 26 }]],
    ['Community Notices & Events', [{ categoryRank: 0 }]],
    ['Help Wanted', [{ categoryRank: 2 }, { categoryRank: 2 }]],
    ['Antiques & Collectibles', [{ categoryRank: 5 }]],
  ]);
  assert.deepEqual(orderCategories(byCat),
    ['Community Notices & Events', 'Help Wanted', 'Antiques & Collectibles', 'Boats']);
});

test('a category off the list prints after the listed ones, A–Z, and is never dropped', () => {
  const byCat = new Map([
    ['Vehicles', [{}]],
    ['Pets', [{ categoryRank: 18 }]],
    ['For Sale', [{ categoryRank: null }]],
    ['Livestock', [{ categoryRank: 17 }]],
  ]);
  assert.deepEqual(orderCategories(byCat), ['Livestock', 'Pets', 'For Sale', 'Vehicles']);
});

test('with no ranks at all (an older website) it is A–Z, as before', () => {
  const byCat = new Map([['Vehicles', [{}]], ['For Sale', [{}]], ['Pets', [{}]]]);
  assert.deepEqual(orderCategories(byCat), ['For Sale', 'Pets', 'Vehicles']);
});
