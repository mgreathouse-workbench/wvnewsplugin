// One piece of a multi-piece display ad: its key, its frame label, its name.
//
// Tina 2026-11-09: a multi-page legal display is ONE order — one ad number —
// holding several pieces (print.pieces on the platform), each with its own
// size and approved artwork, each placed on its own page. Three full pages and
// a half page are four frames, so the order id alone no longer names a frame:
// the piece is part of the identity, the same way the platform's asset-key.js
// makes it part of a page asset's ("order:8123#p2").
//
// ZERO REQUIRES. indesign.js and the marketplace tab both use this, and a view
// cannot require anything (UXP resolves require() from index.html — see
// app.js), so it is handed to them by app.js.
//
// An ad with no pieceKey gets exactly the key and label it always had, so
// every frame built before pieces existed still parses and publishes.

// The piece suffix the platform appends ("#p2"), or ''.
const pieceSuffix = (pieceKey) => (pieceKey ? `#${pieceKey}` : '');

// "8123" or "8123#p2" — the platform's placeKey(), for a Display Ads feed item
// or an edition asset payload ({ id, pieceKey }), whose `id` is the order id.
// (A plan slot's id is "order:8123#p2"; slots go through slotIdentity().)
function adKey(ad) {
  return `${ad && ad.id}${pieceSuffix(ad && ad.pieceKey)}`;
}

// "8123#p2" → { id: "8123", pieceKey: "p2" }; "8123" → { id: "8123", pieceKey: null }.
// Split at the FIRST '#': piece keys are the CRM's "p1".."pN" and order ids are
// Firestore document ids, neither of which holds a '#'.
function splitAdKey(key) {
  const s = String(key == null ? '' : key);
  const at = s.indexOf('#');
  if (at < 0) return { id: s, pieceKey: null };
  return { id: s.slice(0, at), pieceKey: s.slice(at + 1) || null };
}

// The Script Label of an order's ad frame: `order-8123`, or `order-8123#p2`
// for a piece, so two pieces of one order never share a well.
function adFrameLabel(ad) {
  return `order-${adKey(ad)}`;
}

// Read an ad frame's Script Label back. Every reader of `order-<id>` labels —
// Publish Page, Refresh Artwork — goes through this, so each one commits
// against and fetches the REAL order id, with the piece kept separately.
//
//   order-8123            → { kind: 'order',  id: '8123', pieceKey: null, holding: false }
//   order-8123#p2         → { kind: 'order',  id: '8123', pieceKey: 'p2', holding: false }
//   order-8123#p2-holding → the same, holding: true (the grey box's caption)
//   filler-abc            → { kind: 'filler', id: 'abc',  pieceKey: null, holding: false }
//
// `frameLabel` is the WELL's label (a caption's minus `-holding`), so a caption
// can be matched to the frame it annotates. Anything else is null.
function parseAdFrameLabel(label) {
  const m = String(label == null ? '' : label).match(/^(order|filler)-(.+?)(-holding)?$/);
  if (!m) return null;
  const kind = m[1];
  // A filler is a house ad with no order and no pieces; its id is left whole.
  const { id, pieceKey } = kind === 'order' ? splitAdKey(m[2]) : { id: m[2], pieceKey: null };
  if (!id) return null;
  const key = `${id}${pieceSuffix(pieceKey)}`;
  return { kind, id, pieceKey, key, frameLabel: `${kind}-${key}`, holding: !!m[3] };
}

// "#8123 · Page 2 of 4" — how the Page Grid names a piece, so the panel and
// the web grid read the same. '' for an ad with no piece.
function pieceText(ad) {
  if (!ad || !ad.pieceKey) return '';
  return `#${ad.id} · ${ad.pieceLabel || ad.pieceKey}`;
}

module.exports = { adKey, splitAdKey, adFrameLabel, parseAdFrameLabel, pieceText };
