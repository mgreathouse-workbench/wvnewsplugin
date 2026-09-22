// GENERATED FILE — DO NOT EDIT.
//
// what a classified's paid add-ons look like — bold, featured, photo
//
// Source of truth: wvnews-platform/src/lib/classified-presentation.js
// Regenerate:      node scripts/generate-plugin-modules.mjs   (in wvnews-platform)
// Verify:          node scripts/generate-plugin-modules.mjs --check
//
// The plugin has no build step, so this is a CommonJS transform of Platform's
// ESM module: identical function bodies, different wrapper. Edit the Platform
// module and regenerate — never edit this file directly, or the plugin will
// disagree with the rest of the system.
//
// sourceSha256: 4942d17f1794efed

// What a classified's paid add-ons actually look like.
//
// Three add-ons are sold on every classified — a photo, a bold headline, and
// "featured" — and for a long time only the photo did anything, and only on
// the web. Bold and featured were priced, stored, and never read by any
// renderer. A customer paid $3 for a headline that came out identical.
//
// This module is the single answer to "what does each add-on change", so the
// printed page and the website cannot drift into charging for the same thing
// and showing two different things. The plugin gets a generated copy — see
// scripts/generate-plugin-modules.mjs — rather than its own opinion.
//
// ── What each one means ──────────────────────────────────────────────
//
//   bold      the headline is set bold. Print and web.
//   featured  a 3pt frame around the ad, and a bold, slightly larger
//             headline. Print and web.
//   photo     an image on the ad. WEB ONLY — a classified prints as a text
//             line in a stacked column, and an image cannot be placed in one
//             without geometry the print grid does not have for it.

// A frame heavy enough to read as deliberate at classified sizes. Points in
// print, and the same number of CSS pixels on screen: at typical classified
// scale the two land close enough that the ad reads the same in both, which
// is what somebody paying for "featured" is buying.
const FEATURED_FRAME_PT = 3;

// "Slightly bigger" — enough to notice beside a neighbour, not so much that a
// featured ad restructures the column. 15% is about one step on a type scale.
const FEATURED_HEADLINE_SCALE = 1.15;

// Normalize the flags off a record, wherever they live. The submit portal,
// the staff intake form and the print queue have all written these in
// slightly different places over time, so read them all rather than trust one.
function addOnsOf(record) {
  const f = record?.fields || {};
  return {
    bold: !!(record?.bold ?? f.bold),
    featured: !!(record?.featured ?? f.featured),
    // withPhoto is what was CHARGED for; photoUrl is whether one exists.
    // They are deliberately reported apart — an ad billed for a photo that
    // has none is a thing somebody needs to see, not something to paper over.
    withPhoto: !!(record?.withPhoto ?? f.withPhoto),
    photoUrl: record?.photoUrl || f.photoUrl
      || (Array.isArray(record?.photoUrls) ? record.photoUrls[0] : '') || '',
  };
}

// The presentation an ad gets, from its add-ons.
//
// `headlineScale` is a multiplier on whatever the base headline size is, so
// print and web each apply it to their own type scale rather than sharing an
// absolute size that would be wrong in one of them.
function classifiedPresentation(record) {
  const a = addOnsOf(record);
  return {
    headlineBold: a.bold || a.featured,   // featured implies bold
    headlineScale: a.featured ? FEATURED_HEADLINE_SCALE : 1,
    frameWeightPt: a.featured ? FEATURED_FRAME_PT : 0,
    showPhoto: !!a.photoUrl,              // web only; see the note above
    // Billed for a photo and none attached. Surfaced so the intake screen can
    // say so — the money has been taken either way.
    photoPaidButMissing: a.withPhoto && !a.photoUrl,
  };
}

// Tailwind classes for the web card, so the rules live here and not in JSX.
//
// The default headline weight steps DOWN to semibold. Every classified
// headline used to be `font-bold`, which left nothing for the bold add-on to
// do — a paid upgrade has to be visible beside an ad that did not buy it.
function classifiedWebClasses(record) {
  const p = classifiedPresentation(record);
  return {
    headline: [
      p.headlineBold ? 'font-extrabold' : 'font-semibold',
      p.headlineScale > 1 ? 'text-xl' : 'text-lg',
    ].join(' '),
    card: p.frameWeightPt
      ? 'border-[3px] border-ink-900'
      : 'border border-ink-200',
  };
}

module.exports = {
  FEATURED_FRAME_PT,
  FEATURED_HEADLINE_SCALE,
  addOnsOf,
  classifiedPresentation,
  classifiedWebClasses,
};
