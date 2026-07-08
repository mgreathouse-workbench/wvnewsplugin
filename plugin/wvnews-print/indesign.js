// InDesign DOM helpers. UXP exposes the InDesign scripting DOM via
// `require("indesign")`. All page-mutating operations must be wrapped
// in a doScript transaction so they can be undone as a single step.

const {
  fetchBinary,
  downloadSnippetBinary,
  getPublicationTemplate,
  downloadPublicationTemplateBinary,
  fetchAssetContent,
  fetchStyleMap,
  checkoutPage,
  checkinPage,
} = require('./api.js');

let ID = null;
let UXP_FS = null;
let UXP_TEMP = null;

function host() {
  if (!ID) {
    try { ID = require('indesign'); }
    catch (e) { throw new Error('This plugin must run inside Adobe InDesign.'); }
  }
  return ID;
}

function fs() {
  if (!UXP_FS) {
    const { storage } = require('uxp');
    UXP_FS = storage.localFileSystem;
  }
  return UXP_FS;
}

async function tempFolder() {
  if (UXP_TEMP) return UXP_TEMP;
  UXP_TEMP = await fs().getTemporaryFolder();
  return UXP_TEMP;
}

async function writeTemp(name, arrayBuffer) {
  const folder = await tempFolder();
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = await folder.createFile(safe, { overwrite: true });
  await file.write(arrayBuffer, { format: require('uxp').storage.formats.binary });
  return file.nativePath;
}

// Resolve a path inside the bundled plugin assets folder to a native
// filesystem path InDesign can read with `doc.place()`.
// Example: assetPath('snippets/story-blocks/4col_story.idms')
async function assetPath(relative) {
  const folder = await fs().getPluginFolder();
  const entry = await folder.getEntry(`assets/${relative}`);
  return entry.nativePath;
}

// Read a JSON file from the bundled plugin assets and return its parsed value.
async function readAssetJson(relative) {
  const folder = await fs().getPluginFolder();
  const entry = await folder.getEntry(`assets/${relative}`);
  const text = await entry.read({ format: require('uxp').storage.formats.utf8 });
  return JSON.parse(text);
}

function activeDocument() {
  const app = host().app;
  if (!app.documents || app.documents.length === 0) {
    throw new Error('Open a document first.');
  }
  return app.activeDocument;
}

function activeSpread() {
  const doc = activeDocument();
  return doc.layoutWindows.length ? doc.layoutWindows[0].activeSpread : doc.spreads.item(0);
}

function activePageLabel() {
  const doc = activeDocument();
  try {
    const win = doc.layoutWindows[0];
    if (win) return win.activePage.name;
  } catch { /* fall through */ }
  return null;
}

function frameOnSpread(spread, name) {
  const items = spread.allPageItems || [];
  for (const it of items) {
    try { if (it.label && it.label === name) return it; } catch {}
  }
  for (const it of items) {
    try { if (it.name && it.name === name) return it; } catch {}
  }
  return null;
}

async function placeTemplate(template, story, styleMap) {
  const id = host();
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const buf = await fetchBinary(template.snippetUrl);
          const tempPath = await writeTemp(`${template.id}.idms`, buf);
          const doc = activeDocument();
          const win = doc.layoutWindows[0];
          const page = win ? win.activePage : doc.pages.item(0);
          const placed = doc.place(tempPath, true, { destination: page });
          const root = Array.isArray(placed) ? placed[0] : placed;
          const spread = page.parent;
          const bound = [];
          for (const row of template.frameSchema || []) {
            const frame = frameOnSpread(spread, row.frame);
            if (!frame) continue;
            const value = valueForBind(story, row.bind);
            if (value == null) continue;
            await flowIntoFrame(frame, row.bind, value, row.styleHint, styleMap, story);
            bound.push(row.frame);
          }
          resolve({
            documentName: doc.name, page: page.name,
            framesBound: bound, rootId: root && root.id ? root.id : null,
          });
        } catch (e) { reject(e); }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: place ${template.label}`,
    );
  });
}

// Walk the active spread, find every frame whose Script Label matches
// a known binding, and flow the corresponding story field in. This is
// the "no-snippet" placement path — the layout artist draws + labels
// frames once on a master page, then drops different stories into the
// same layout by clicking one button.
async function flowFullStoryIntoLabelledFrames(story, styleMap) {
  const id = host();
  console.log('[wvnews-print] flowFullStoryIntoLabelledFrames: starting');
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const doc = activeDocument();
          const win = doc.layoutWindows[0];
          const page = win ? win.activePage : doc.pages.item(0);
          const spread = page.parent;
          const items = spread.allPageItems || [];
          console.log('[wvnews-print] page items on spread:', items.length);

          // Known frame-name → story binding map (matches the README).
          // `storyFrame` is the Blox-style combined flow: headline +
          // deck + byline + dateline + body all pour into one frame,
          // each region tagged with its matching paragraph style.
          const BINDINGS = {
            headlineFrame: 'headline',
            deckFrame:     'deck',
            bylineFrame:   'byline',
            datelineFrame: 'dateline',
            kickerFrame:   'kicker',
            pullquoteFrame:'pullquote',
            bodyFrame:     'body',
            photoFrame:    'photo',
            photo2Frame:   'photo2',
            photo3Frame:   'photo3',
            captionFrame:  'caption',
            caption2Frame: 'caption2',
            caption3Frame: 'caption3',
            creditFrame:   'credit',
          };

          const bound = [];
          const missing = [];
          for (const it of items) {
            let label = '';
            try { label = it.label || ''; } catch { /* legacy items */ }
            if (!label) continue;
            if (label === 'storyFrame') {
              await flowCombinedStoryStream(it, story, styleMap);
              bound.push(label);
              continue;
            }
            const bindKind = BINDINGS[label];
            if (!bindKind) continue;
            const val = valueForBind(story, bindKind);
            if (val == null || val === '') {
              missing.push(`${label} (no ${bindKind} on story)`);
              continue;
            }
            await flowIntoFrame(it, bindKind, val, null, styleMap, story);
            bound.push(label);
          }

          resolve({
            documentName: doc.name,
            page: page.name,
            framesBound: bound,
            missing,
          });
        } catch (e) {
          console.error('[wvnews-print] flowFullStory error:', e);
          reject(e);
        }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: flow full story`,
    );
  });
}

async function flowIntoSelectedFrame(story, styleMap, kind = 'body') {
  const id = host();
  console.log('[wvnews-print] flowIntoSelectedFrame: starting');
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const sel = id.app.selection;
          console.log('[wvnews-print] selection length:', sel?.length, 'type:', sel?.[0]?.constructor?.name);
          if (!sel || !sel.length) throw new Error('Select a frame first.');
          const frame = sel[0];
          console.log('[wvnews-print] frame has parentStory:', !!frame.parentStory);
          const val = valueForBind(story, kind);
          console.log('[wvnews-print] value length:', val ? val.length : 0);
          await flowIntoFrame(frame, kind, val, null, styleMap, story);
          console.log('[wvnews-print] flowIntoFrame returned');
          const doc = activeDocument();
          const win = doc.layoutWindows[0];
          resolve({
            documentName: doc.name,
            page: win ? win.activePage.name : '',
            framesBound: [frame.label || frame.name || ''],
          });
        } catch (e) { reject(e); }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: flow into frame`,
    );
  });
}

// Build the grouped text for a marketplace block. Classifieds group by
// category (one header line each); legals/obits list one block per item.
// Returns { text, headerIdx } — headerIdx are paragraph indices to style.
function buildMarketplaceText(kind, items) {
  const lines = [];
  const headerIdx = [];
  if (kind === 'classifieds') {
    const byCat = new Map();
    for (const it of items) {
      const c = String(it.category || 'Classifieds').trim() || 'Classifieds';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(it);
    }
    for (const cat of [...byCat.keys()].sort((a, b) => a.localeCompare(b))) {
      headerIdx.push(lines.length);
      lines.push(cat);
      for (const it of byCat.get(cat)) {
        const t = String(it.text || '').trim();
        if (t) lines.push(t);
      }
    }
  } else if (kind === 'obits') {
    for (const o of items) {
      const head = [o.name, o.city].filter(Boolean).join(', ');
      const block = [head, String(o.text || '').trim(), o.funeral].filter(Boolean).join('\n');
      if (block) lines.push(block);
    }
  } else { // legals — body text only; the title is not placed
    for (const l of items) {
      const block = String(l.text || '').trim();
      if (block) lines.push(block);
    }
  }
  return { text: lines.join('\n'), headerIdx };
}

// Flatten a list of legals (each with a title + structured richText) into
// one blocks array for applyRichTextToFrame — title as its own paragraph,
// the notice's formatted paragraphs after it, and a blank paragraph between
// notices. Falls back to a plain-text paragraph if an item lacks richText.
function buildLegalBlocks(items) {
  const blocks = [];
  items.forEach((l, idx) => {
    if (idx > 0) blocks.push({ align: 'left', runs: [{ text: '' }] });
    // Title is intentionally not placed — body text only.
    if (Array.isArray(l.richText) && l.richText.length) {
      for (const b of l.richText) blocks.push(b);
    } else if (l.text) {
      blocks.push({ align: 'left', runs: [{ text: String(l.text) }] });
    }
  });
  return blocks;
}

// Map a classified category name → the section-header graphic slug (matches
// the PDFs in Firebase page-layout-elements/section-headers/). Normalized,
// so "Real Estate — For Rent", "Services Offered", "Pets & Livestock" etc.
// all resolve. Categories with no dedicated art fall back to `other`.
function categoryHeaderSlug(category) {
  const c = String(category || '').toLowerCase();
  if (/for\s*sale/.test(c) && !/real\s*estate/.test(c)) return 'for-sale';
  if (/vehicle|auto|car|truck|motorcycle/.test(c)) return 'vehicles';
  if (/real\s*estate|for\s*rent|apartment|rental|house|home/.test(c)) return 'real-estate';
  if (/help\s*wanted|employ|job/.test(c)) return 'help-wanted';
  if (/service/.test(c)) return 'services';
  if (/pet|livestock|animal/.test(c)) return 'pets';
  if (/yard|estate\s*sale|garage\s*sale|rummage/.test(c)) return 'yard-sale';
  if (/legal|notice.*publ|public.*notice/.test(c)) return 'legals';
  // Everything else (Other, Notices & Personal, Free/Giveaway, Wanted to
  // Buy, Lost & Found, Farm & Outdoor, …) → the OTHER banner.
  return 'other';
}

// Build classifieds as styled blocks grouped by category. For categories
// with a header graphic available we emit an EMPTY placeholder paragraph the
// caller anchors the PDF into (replacing the text header); categories with no
// art keep a text header (headerIdx). Returns:
//   blocks        — paragraph blocks for applyRichTextToFrame
//   headerIdx     — paragraph indexes of TEXT headers (no art) for styling
//   headerAnchors — [{ paraIdx, slug }] placeholder paragraphs to fill w/ art
//   paraCat       — paraCat[i] = category name for paragraph i (for column repeat)
// resolveHeaderSlug(category) returns a slug when art is available, else null.
function buildClassifiedBlocks(items, resolveHeaderSlug) {
  const blocks = [];
  const headerIdx = [];
  const headerAnchors = [];
  const paraCat = [];
  const byCat = new Map();
  for (const it of items) {
    const c = String(it.category || 'Classifieds').trim() || 'Classifieds';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(it);
  }
  const push = (block, catName) => { paraCat[blocks.length] = catName; blocks.push(block); };
  let firstCat = true;
  for (const cat of [...byCat.keys()].sort((a, b) => a.localeCompare(b))) {
    const slug = resolveHeaderSlug ? resolveHeaderSlug(cat) : null;
    // Blank line before each new category (separates groups) — not at the top.
    if (!firstCat) push({ align: 'left', runs: [{ text: '' }] }, cat);
    firstCat = false;
    if (slug) {
      // Empty, centered paragraph the header graphic gets anchored into.
      headerAnchors.push({ paraIdx: blocks.length, slug });
      push({ align: 'center', runs: [{ text: '' }] }, cat);
    } else {
      headerIdx.push(blocks.length);
      push({ align: 'left', runs: [{ text: cat }] }, cat);
    }
    let firstInCat = true;
    for (const it of byCat.get(cat)) {
      const head = String(it.headline || '').trim();
      const desc = String(it.text || '').trim();
      const runs = [];
      if (head) {
        runs.push({ text: head, bold: true });
        if (desc && desc.toLowerCase() !== head.toLowerCase()) runs.push({ text: '  ' + desc });
      } else if (desc) {
        runs.push({ text: desc });
      }
      if (!runs.length) continue;
      // Hard return between listings within a category.
      if (!firstInCat) push({ align: 'left', runs: [{ text: '' }] }, cat);
      firstInCat = false;
      push({ align: 'left', runs }, cat);
    }
  }
  return { blocks, headerIdx, headerAnchors, paraCat };
}

// Size an inline header graphic's anchored frame to the column width,
// preserving the PDF's native aspect ratio (banners are ~5:1).
function sizeClassifiedHeaderFrame(id, gframe, widthPt) {
  try {
    const gb = gframe.geometricBounds; // native [top, left, bottom, right]
    const nativeW = gb[3] - gb[1], nativeH = gb[2] - gb[0];
    const hPt = nativeW > 0 ? widthPt * (nativeH / nativeW) : widthPt * 0.2;
    gframe.geometricBounds = [gb[0], gb[1], gb[0] + hPt, gb[1] + widthPt];
    return hPt;
  } catch (e) { return widthPt * 0.2; }
}

// STEP 1 — anchor a category header PDF inline into its placeholder paragraph,
// replacing the text header. Non-fatal.
//
// Reliable inline-image pattern: create a PRE-SIZED inline frame at the
// insertion point (geometricBounds set the size up front), THEN place + fit
// into it. Placing at native size first (ip.place → resize) left the banner
// at its native column width, which oversets the line and spins fitOrThread
// into empty columns. The PDFs are ~5.06:1 (118.497 × 23.4).
const HEADER_ASPECT = 23.3998 / 118.497; // height / width
async function placeClassifiedHeader(id, doc, frame, paraIdx, url, slug, widthPt) {
  try {
    const story = frame.parentStory;
    const para = story.paragraphs.item(paraIdx);
    if (!para || !para.isValid) return;
    const ip = para.insertionPoints.item(0);
    const buf = await fetchBinary(url);
    const tempPath = await writeTemp(`hdr-${slug}.pdf`, buf);
    const hPt = widthPt * HEADER_ASPECT;
    // geometricBounds are read in the document's RULER units — force POINTS
    // or a document set to inches turns [0,0,22.8,115.5] into a 115-INCH
    // inline object that oversets and spins fitOrThread into empty columns.
    const vp = doc.viewPreferences;
    const sH = vp.horizontalMeasurementUnits, sV = vp.verticalMeasurementUnits;
    vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
    vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
    try {
      // Inline anchored rectangle, sized before the graphic lands in it.
      const rect = ip.rectangles.add({ geometricBounds: [0, 0, hPt, widthPt] });
      // No frame outline on the banner.
      try { rect.strokeWeight = 0; } catch (e) {}
      try { rect.strokeColor = doc.swatches.itemByName('None'); } catch (e) {}
      rect.place(tempPath);
      try { rect.fit(id.FitOptions.FILL_PROPORTIONALLY); } catch (e) {}
      // The story's base leading (8.5pt) is far shorter than the banner, so
      // it collided with the listings. Make the banner's line tall enough and
      // add breathing room above/below.
      try {
        para.leading = hPt + 4;
        para.spaceBefore = 6;
        para.spaceAfter = 6;
      } catch (e) {}
    } finally {
      vp.horizontalMeasurementUnits = sH;
      vp.verticalMeasurementUnits = sV;
    }
  } catch (e) {
    console.warn('[wvnews-print] classified header place failed:', e?.message || e);
  }
}

// STEP 2 — repeat the current category's header at the TOP of every column.
// After threading, each continuation column starts mid-category; drop an
// overlay header banner at its top (and nudge the column's top inset down so
// the first listing clears it). Guarded end-to-end: any failure leaves the
// Step-1 result intact. Needs in-InDesign verification/tuning.
async function repeatColumnHeaders(id, doc, frame, paraCat, headerUrls, anchorTopSet) {
  const story = frame.parentStory;
  let cols;
  try { cols = story.textContainers; } catch (e) { return; }
  if (!cols || cols.length <= 1) return; // single column → nothing to repeat

  // Snapshot each continuation column's top category BEFORE mutating insets.
  const plan = [];
  for (let ci = 1; ci < cols.length; ci++) {
    try {
      const col = cols[ci];
      const p = col.texts.item(0).paragraphs.item(0);
      const idx = p.index;
      if (idx == null || idx < 0 || idx >= paraCat.length) continue;
      if (anchorTopSet && anchorTopSet.has(idx)) continue; // header already at this top
      const slug = categoryHeaderSlug(paraCat[idx]);
      const url = slug && headerUrls[slug];
      if (!url) continue;
      plan.push({ col, url, slug });
    } catch (e) { /* skip this column */ }
  }

  const vp = doc.viewPreferences;
  const sH = vp.horizontalMeasurementUnits, sV = vp.verticalMeasurementUnits;
  vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
  vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
  try {
    for (const { col, url, slug } of plan) {
      try {
        const b = col.geometricBounds; // [top, left, bottom, right]
        const wPt = b[3] - b[1];
        const buf = await fetchBinary(url);
        const tempPath = await writeTemp(`hdrcol-${slug}.pdf`, buf);
        const rect = col.parentPage
          ? col.parentPage.rectangles.add({ geometricBounds: [b[0], b[1], b[0] + wPt * 0.2, b[3]] })
          : null;
        if (!rect) continue;
        rect.place(tempPath);
        const hPt = sizeClassifiedHeaderFrame(id, rect, wPt);
        // Make room so the listing text starts below the banner.
        try {
          const tfp = col.textFramePreferences;
          const inset = tfp.insetSpacing;
          if (Array.isArray(inset)) { inset[0] = hPt + 2; tfp.insetSpacing = inset; }
          else tfp.insetSpacing = [hPt + 2, 0, 0, 0];
        } catch (e) {}
      } catch (e) { console.warn('[wvnews-print] column header skipped:', e?.message || e); }
    }
  } finally {
    vp.horizontalMeasurementUnits = sH;
    vp.verticalMeasurementUnits = sV;
  }
}

// Build obits as styled blocks that flow in ONE threaded column, with an
// empty "photo paragraph" at the top of each obit so a portrait can be
// anchored inline there (see placeObitPhoto). Because applyRichTextToFrame
// emits exactly one paragraph per block, the block index equals the final
// paragraph index — so we record photoAnchors by block index.
function buildObitBlocks(items) {
  const blocks = [];
  const photoAnchors = []; // { paraIdx, url }
  let first = true;
  for (const it of items) {
    // Hard return between obits (matches the classifieds treatment).
    if (!first) blocks.push({ align: 'left', runs: [{ text: '' }] });
    first = false;
    const url = String(it.photoUrl || '').trim();
    if (url) {
      // Empty, centered paragraph that the photo gets anchored into.
      photoAnchors.push({ paraIdx: blocks.length, url });
      blocks.push({ align: 'center', runs: [{ text: '' }] });
    }
    // Name (bold) + city on the lead line.
    const name = String(it.name || '').trim();
    const city = String(it.city || '').trim();
    const lead = [];
    if (name) lead.push({ text: name, bold: true });
    if (city) lead.push({ text: (name ? ', ' : '') + city });
    if (lead.length) blocks.push({ align: 'left', runs: lead });
    // Body.
    const body = String(it.text || '').trim();
    if (body) blocks.push({ align: 'left', runs: [{ text: body }] });
    // Funeral home / arrangements.
    const funeral = String(it.funeral || '').trim();
    if (funeral) blocks.push({ align: 'left', runs: [{ text: funeral }] });
  }
  return { blocks, photoAnchors };
}

// Download a portrait and anchor it INLINE into the empty photo paragraph at
// `anchor.paraIdx`, sized to a column-wide portrait box. Non-fatal: on any
// failure the obit still places as text. Call anchors in REVERSE paragraph
// order so earlier insertion points stay valid as inline objects shift text.
async function placeObitPhoto(id, doc, frame, anchor) {
  try {
    const story = frame.parentStory;
    const para = story.paragraphs.item(anchor.paraIdx);
    if (!para || !para.isValid) return;
    const ip = para.insertionPoints.item(0);
    const buf = await fetchBinary(anchor.url);
    const ext = (anchor.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
    const tempPath = await writeTemp(`obit-${anchor.paraIdx}.${ext}`, buf);
    // Pre-size the inline frame, THEN place — same reliable pattern as the
    // classified headers (placing at native size + resizing oversets narrow
    // columns). A hair under the column width so it fits the line. Force
    // POINTS: geometricBounds read in the doc's ruler units (inches → giant).
    const wPt = CONTENT_BLOCK.widthIn * 72 - 1;
    const hPt = wPt * OBIT_PHOTO_ASPECT;
    const vp = doc.viewPreferences;
    const sH = vp.horizontalMeasurementUnits, sV = vp.verticalMeasurementUnits;
    vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
    vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
    try {
      const rect = ip.rectangles.add({ geometricBounds: [0, 0, hPt, wPt] });
      try { rect.strokeWeight = 0; } catch (e) {}
      try { rect.strokeColor = doc.swatches.itemByName('None'); } catch (e) {}
      rect.place(tempPath);
      try { rect.fit(id.FitOptions.FILL_PROPORTIONALLY); } catch (e) {}
      // Make the line tall enough for the portrait + a little room below.
      try { para.leading = hPt + 4; para.spaceAfter = 5; } catch (e) {}
    } finally {
      vp.horizontalMeasurementUnits = sH;
      vp.verticalMeasurementUnits = sV;
    }
  } catch (e) {
    console.warn('[wvnews-print] obit photo placement failed:', e?.message || e);
  }
}

// Place a marketplace block (classifieds / legals / obits) into the
// SELECTED text frame. Classifieds get one text header per category;
// graphics are a later pass. Undo-wrapped like flowIntoSelectedFrame.
// Standard 1-column content block for manually-placed marketplace content
// (legals / classifieds / obits). The plugin creates the block frame itself
// so content arrives WITH its block rather than needing a pre-drawn frame.
//   width   1.6458 in (one newspaper column)
//   font    Helvetica Neue 8pt / 8.5pt leading
//   align   left-justified (justify, last line flush left)
const CONTENT_BLOCK = { widthIn: 1.6458, font: 'Helvetica Neue', pointSize: 8, leading: 8.5 };

// Obit portrait: a column-wide, portrait-ratio box the memorial photo is
// anchored into at the top of each obit. FILL_PROPORTIONALLY fills + crops.
const OBIT_PHOTO_ASPECT = 1.2; // height = width * 1.2 (portrait)

// Content starts this far below the top of the page, leaving room for the
// folio (running header / page line).
const FOLIO_OFFSET_IN = 0.5884;

// Newspaper column widths in inches (multi-column spans the gutters). Legals
// carry a columnCount (1-4); the placed block is sized to match.
const LEGAL_COLUMN_WIDTHS_IN = { 1: 1.6458, 2: 3.4167, 3: 5.1875, 4: 6.9583 };
function legalColumnWidthIn(n) {
  return LEGAL_COLUMN_WIDTHS_IN[Math.max(1, Math.min(4, Number(n) || 1))];
}

// Apply a solid black border of `pts` points to a frame (legal "Border" opt).
function applyFrameBorder(id, doc, frame, pts) {
  try {
    const vp = doc.viewPreferences;
    let saved = null;
    try { saved = vp.strokeMeasurementUnits; vp.strokeMeasurementUnits = id.MeasurementUnits.POINTS; } catch (e) {}
    try { frame.strokeWeight = pts; } catch (e) {}
    try { frame.strokeColor = doc.swatches.itemByName('Black'); } catch (e) {}
    // Align Stroke to Inside so the 1pt rule sits inside the frame bounds.
    try { frame.strokeAlignment = id.StrokeAlignment.INSIDE_ALIGNMENT; } catch (e) {}
    if (saved != null) { try { vp.strokeMeasurementUnits = saved; } catch (e) {} }
  } catch (e) { console.warn('[wvnews-print] border failed:', e?.message || e); }
}

// Set a text frame's inset spacing [top, left, bottom, right] in POINTS.
// insetSpacing is read in the doc's ruler units, so force points around it.
function applyFrameInset(id, doc, frame, topPt, leftPt, bottomPt, rightPt) {
  try {
    const tfp = frame.textFramePreferences;
    const vp = doc.viewPreferences;
    let sH = null, sV = null;
    try {
      sH = vp.horizontalMeasurementUnits; sV = vp.verticalMeasurementUnits;
      vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
      vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
    } catch { sH = null; }
    try { tfp.insetSpacing = [topPt, leftPt, bottomPt, rightPt]; } catch (e) { console.warn('[wvnews-print] inset array rejected:', e?.message || e); }
    if (sH != null) { try { vp.horizontalMeasurementUnits = sH; vp.verticalMeasurementUnits = sV; } catch { /* ignore */ } }
  } catch (e) { console.warn('[wvnews-print] inset failed:', e?.message || e); }
}

// Create the content-block text frame at the active page's top-left margin,
// sized to one column wide × the available column height. Works in points so
// the width is exact regardless of the document's ruler units.
function createContentBlockFrame(id, doc, page, widthIn) {
  const vp = doc.viewPreferences;
  const savedH = vp.horizontalMeasurementUnits;
  const savedV = vp.verticalMeasurementUnits;
  vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
  vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
  try {
    const b = page.bounds; // [y1, x1, y2, x2] in points
    const mp = page.marginPreferences;
    const mLeft = typeof mp.left === 'number' ? mp.left : 36;
    const mBottom = typeof mp.bottom === 'number' ? mp.bottom : 36;
    const top = b[0] + FOLIO_OFFSET_IN * 72; // below the folio
    const left = b[1] + mLeft;
    const widthPt = widthIn * 72;
    const colHeight = (b[2] - b[0]) - FOLIO_OFFSET_IN * 72 - mBottom;
    const heightPt = colHeight > 72 ? colHeight : 288; // full column, else 4"
    return page.textFrames.add({ geometricBounds: [top, left, top + heightPt, left + widthPt] });
  } finally {
    vp.horizontalMeasurementUnits = savedH;
    vp.verticalMeasurementUnits = savedV;
  }
}

// Shrink/grow the frame's height to fit its text, keeping the 1-column width
// fixed and the top-left corner anchored (so the block stays where it landed
// and just trims the empty space below the copy).
function fitFrameHeightToText(id, frame) {
  try {
    const tfp = frame.textFramePreferences;
    tfp.autoSizingReferencePoint = id.AutoSizingReferenceEnum.TOP_LEFT_POINT;
    tfp.autoSizingType = id.AutoSizingTypeEnum.HEIGHT_ONLY;
  } catch (e) {
    console.warn('[wvnews-print] auto-size-to-text failed:', e?.message || e);
  }
}

// A content block may not exceed this height; longer copy threads into a
// continuation box.
const MAX_BLOCK_HEIGHT_IN = 20.35;

// Cap a content block at MAX_BLOCK_HEIGHT_IN. If the copy fits, the frame
// hugs its content (auto-size). If it overflows, add continuation frames to
// the right and THREAD the text through them so the content flows onward.
// `decorate` (optional) re-applies per-frame styling (border / inset / text
// wrap) to each continuation frame so the look carries across the thread.
function fitOrThread(id, doc, page, frame, widthIn, decorate, growLeft) {
  const vp = doc.viewPreferences;
  const sH = vp.horizontalMeasurementUnits, sV = vp.verticalMeasurementUnits;
  vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
  vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
  try {
    const maxPt = MAX_BLOCK_HEIGHT_IN * 72;
    const widthPt = widthIn * 72;
    const GAP = 9;
    let current = frame;
    let nextLeft = null;
    let guard = 0;
    while (guard++ < 60) {
      const gb = current.geometricBounds; // [top, left, bottom, right] in pts
      // Next continuation grows right by default, or LEFT for right-anchored
      // (multi-column) blocks so they stay on the page.
      if (nextLeft == null) nextLeft = growLeft ? (gb[1] - GAP - widthPt) : (gb[3] + GAP);
      // Pin to the cap so any overflow becomes detectable.
      try { current.geometricBounds = [gb[0], gb[1], gb[0] + maxPt, gb[3]]; } catch (e) {}
      let over = false;
      try { over = !!current.overflows; } catch (e) { over = false; }
      if (!over) {
        // Fits within the cap → shrink to hug the content.
        fitFrameHeightToText(id, current);
        break;
      }
      // Overflows → continuation frame (threaded).
      const top = gb[0];
      const cont = page.textFrames.add({ geometricBounds: [top, nextLeft, top + maxPt, nextLeft + widthPt] });
      nextLeft = growLeft ? (nextLeft - GAP - widthPt) : (nextLeft + widthPt + GAP);
      if (decorate) { try { decorate(cont); } catch (e) {} }
      try { current.nextTextFrame = cont; } catch (e) { break; }
      current = cont;
    }
  } catch (e) { console.warn('[wvnews-print] cap/thread failed:', e?.message || e); }
  finally {
    vp.horizontalMeasurementUnits = sH;
    vp.verticalMeasurementUnits = sV;
  }
}

// Apply the block's base typography to a frame's whole story (font / size /
// leading / uniform justification). Used for the plain-text marketplace kinds
// (classifieds / obits); legals go through applyRichTextToFrame's baseFormat.
function applyBlockFormat(id, frame, fmt) {
  try {
    const story = frame.parentStory;
    const t = story.texts.item(0);
    if (fmt.font)      { try { t.appliedFont = fmt.font; } catch (e) { console.warn('[wvnews-print] font not found:', fmt.font); } }
    if (fmt.pointSize) { try { t.pointSize = fmt.pointSize; } catch (e) {} }
    if (fmt.leading)   { try { t.leading = fmt.leading; } catch (e) {} }
    // No indents on placed content.
    try { t.leftIndent = 0; } catch (e) {}
    try { t.rightIndent = 0; } catch (e) {}
    try { t.firstLineIndent = 0; } catch (e) {}
    if (fmt.justification != null) {
      const paras = story.paragraphs;
      for (let i = 0; i < paras.length; i++) { try { paras.item(i).justification = fmt.justification; } catch (e) {} }
    }
  } catch (e) { console.warn('[wvnews-print] applyBlockFormat skipped:', e?.message || e); }
}

async function placeMarketplaceBlock(kind, items, styleMap, headerUrls = null) {
  const id = host();
  if (!Array.isArray(items) || !items.length) throw new Error('Nothing available to place.');
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const doc = activeDocument();
          const win = doc.layoutWindows.length ? doc.layoutWindows[0] : null;
          const page = win ? win.activePage : doc.pages.item(0);
          const fmt = {
            font: CONTENT_BLOCK.font,
            pointSize: CONTENT_BLOCK.pointSize,
            leading: CONTENT_BLOCK.leading,
            justification: id.Justification.LEFT_JUSTIFIED,
          };

          // ── Legals ───────────────────────────────────────────────
          // 1-column legals all flow into ONE shared block. Every legal
          // wider than 1 column gets its OWN block, sized to its column
          // width, with a 0.0625" text wrap and an optional 1pt border.
          if (kind === 'legals') {
            const oneCol = items.filter(l => (Number(l.columnCount) || 1) <= 1);
            const multi  = items.filter(l => (Number(l.columnCount) || 1) > 1);

            // Lay the blocks out left-to-right, computed in points.
            const vp = doc.viewPreferences;
            const sH = vp.horizontalMeasurementUnits, sV = vp.verticalMeasurementUnits;
            vp.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
            vp.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
            const plan = [];
            try {
              const b = page.bounds;
              const mp = page.marginPreferences;
              const mLeft = typeof mp.left === 'number' ? mp.left : 36;
              const mRight = typeof mp.right === 'number' ? mp.right : 36;
              const mBottom = typeof mp.bottom === 'number' ? mp.bottom : 36;
              const top = b[0] + FOLIO_OFFSET_IN * 72; // below the folio
              const colH = (b[2] - b[0]) - FOLIO_OFFSET_IN * 72 - mBottom;
              const heightPt = colH > 72 ? colH : 288;
              const GAP = 9;
              // 1-column legals flow from the LEFT margin (and thread right).
              let leftCursor = b[1] + mLeft;
              const mkLeft = (wIn) => {
                const wpt = wIn * 72;
                const f = page.textFrames.add({ geometricBounds: [top, leftCursor, top + heightPt, leftCursor + wpt] });
                leftCursor += wpt + GAP;
                return f;
              };
              // Multi-column legals anchor to the RIGHT margin, stacking
              // right-to-left, so they don't collide with the left-column flow.
              let rightCursor = b[3] - mRight;
              const mkRight = (wIn) => {
                const wpt = wIn * 72;
                const x = rightCursor - wpt;
                const f = page.textFrames.add({ geometricBounds: [top, x, top + heightPt, x + wpt] });
                rightCursor = x - GAP;
                return f;
              };
              if (oneCol.length) plan.push({ frame: mkLeft(CONTENT_BLOCK.widthIn), widthIn: CONTENT_BLOCK.widthIn, legals: oneCol, multi: false, border: false });
              for (const l of multi) {
                const w = legalColumnWidthIn(l.columnCount);
                plan.push({ frame: mkRight(w), widthIn: w, legals: [l], multi: true, border: !!l.border });
              }
            } finally {
              vp.horizontalMeasurementUnits = sH;
              vp.verticalMeasurementUnits = sV;
            }
            if (!plan.length) throw new Error('Nothing to place.');
            for (const p of plan) {
              const blocks = buildLegalBlocks(p.legals);
              if (blocks.length) applyRichTextToFrame(id, p.frame, blocks, fmt);
              // Per-frame styling for multi-column notices, re-applied to any
              // continuation frames so the border/wrap carries across the thread.
              const decorate = p.multi ? (f) => {
                if (p.border) {
                  applyFrameBorder(id, doc, f, 1);
                  // Bordered notice: inset T0 / B0 / L0.0125" / R0.0125" (0.9pt).
                  applyFrameInset(id, doc, f, 0, 0.9, 0, 0.9);
                }
                applyTextWrap(f, 4.5); // 0.0625 in standoff
              } : null;
              if (decorate) decorate(p.frame);
              // Multi-column blocks sit at the right margin, so any overflow
              // threads leftward to stay on the page.
              fitOrThread(id, doc, page, p.frame, p.widthIn, decorate, p.multi);
            }
            resolve({ placed: items.length, frame: '' });
            return;
          }

          // ── Classifieds / obits: a single 1-column block ─────────
          const frame = createContentBlockFrame(id, doc, page, CONTENT_BLOCK.widthIn);
          if (kind === 'classifieds') {
            // A category gets a header graphic only if art is available for it.
            const resolveHeaderSlug = (cat) => {
              if (!headerUrls) return null;
              const slug = categoryHeaderSlug(cat);
              return (slug && headerUrls[slug]) ? slug : null;
            };
            const { blocks, headerIdx, headerAnchors, paraCat } = buildClassifiedBlocks(items, resolveHeaderSlug);
            if (!blocks.length) throw new Error('Nothing to place.');
            applyRichTextToFrame(id, frame, blocks, fmt);
            // Style the remaining TEXT category headers (categories with no art).
            try {
              const styleName = (styleMap && styleMap.paragraph && (styleMap.paragraph.classifiedHeader || styleMap.paragraph.classifiedCategory)) || 'Classified Category';
              const style = doc.paragraphStyles.itemByName(styleName);
              if (style && style.isValid) {
                const paras = frame.parentStory.paragraphs;
                for (const i of headerIdx) {
                  if (i < paras.length) paras.item(i).applyParagraphStyle(style, true);
                }
              }
            } catch (e) { console.warn('[wvnews-print] classified header styling skipped:', e?.message || e); }
            // STEP 1: anchor each category's header graphic into its placeholder
            // (reverse order so paragraph indexes stay valid as inline objects
            // shift the text). The banner PDFs are exactly one column wide, so
            // size a hair NARROWER — an inline object equal to the line width
            // oversets and spins fitOrThread into empty columns.
            const hdrWidthPt = CONTENT_BLOCK.widthIn * 72 - 1;
            for (let a = headerAnchors.length - 1; a >= 0; a--) {
              const { paraIdx, slug } = headerAnchors[a];
              await placeClassifiedHeader(id, doc, frame, paraIdx, headerUrls[slug], slug, hdrWidthPt);
            }
            fitOrThread(id, doc, page, frame, CONTENT_BLOCK.widthIn, null);
            // STEP 2 (repeat header atop every column) is temporarily DISABLED
            // pending in-InDesign verification of Step 1 — re-enable once the
            // inline placement is confirmed clean.
            // if (headerUrls) {
            //   const anchorTops = new Set(headerAnchors.map(h => h.paraIdx));
            //   try { await repeatColumnHeaders(id, doc, frame, paraCat, headerUrls, anchorTops); }
            //   catch (e) { console.warn('[wvnews-print] column header repeat skipped:', e?.message || e); }
            // }
            resolve({ placed: items.length, frame: frame.name || '' });
            return;
          }
          // Obits: styled blocks in one threaded column, each with its
          // portrait anchored inline at the top of the obit.
          const { blocks, photoAnchors } = buildObitBlocks(items);
          if (!blocks.length) throw new Error('Nothing to place.');
          applyRichTextToFrame(id, frame, blocks, fmt);
          // Anchor portraits LAST→FIRST so inserting each inline object
          // doesn't shift the paragraph indices of anchors not yet placed.
          for (let a = photoAnchors.length - 1; a >= 0; a--) {
            await placeObitPhoto(id, doc, frame, photoAnchors[a]);
          }
          fitOrThread(id, doc, page, frame, CONTENT_BLOCK.widthIn, null);
          resolve({ placed: items.length, frame: frame.label || frame.name || '' });
        } catch (e) { reject(e); }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: place ${kind}`,
    );
  });
}

async function placePhotoInSelection(photo, story) {
  if (!photo || !photo.url) throw new Error('Story has no photo.');
  const id = host();
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const sel = id.app.selection;
          if (!sel || !sel.length) throw new Error('Select an image frame first.');
          const frame = sel[0];
          const buf = await fetchBinary(photo.url);
          const ext = (photo.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
          const tempPath = await writeTemp(`${story.id}-photo.${ext}`, buf);
          frame.place(tempPath);
          try { frame.fit(id.FitOptions.PROPORTIONALLY); } catch {}
          const spread = frame.parent.parent || activeSpread();
          const caption = frameOnSpread(spread, 'captionFrame');
          if (caption) {
            const text = [photo.caption, photo.credit ? `— ${photo.credit}` : ''].filter(Boolean).join(' ');
            await flowIntoFrame(caption, 'caption', text, null, null, story);
          }
          const doc = activeDocument();
          const win = doc.layoutWindows[0];
          resolve({
            documentName: doc.name,
            page: win ? win.activePage.name : '',
            framesBound: ['photo'],
          });
        } catch (e) { reject(e); }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: place photo`,
    );
  });
}

// Blox-style "story package" builder: operator draws ONE bounding
// rectangle defining where the entire story should sit on the page,
// selects it, and clicks Place. The plugin computes positions for
// each region inside those bounds and creates labeled sub-frames:
//
//    ┌──────────────┐  ← bounding rect (user-drawn)
//    │  headline    │  ← headlineFrame   (HD HDB Head Bold)
//    │  deck        │  ← deckFrame       (HDS Head Subheadline)
//    │  byline      │  ← bylineFrame     (BY1 + DatelineLeft)
//    │  ┌────────┐  │
//    │  │ photo  │  │  ← photoFrame      (image)
//    │  └────────┘  │
//    │  caption     │  ← captionFrame    (IMU + IMR)
//    │  body...     │  ← bodyFrame       (BCJ Body Copy Justified)
//    │  body...     │
//    │  body...     │
//    └──────────────┘
//
// Then it flows the story's content into each labeled frame and
// applies the right paragraph style. The original bounding rectangle
// is removed (it was just a placement hint).
async function placeStoryIntoSelectedFrame(story, styleMap) {
  const id = host();
  console.log('[wvnews-print] building story package from bounding box; story:', story?.id, story?.headline);
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const sel = id.app.selection;
          if (!sel || !sel.length) throw new Error('Draw a text frame to mark the story area, then select it.');
          let bounds = sel[0];
          // If the selection is a text cursor / insertion point / text run
          // inside a frame (common when drawing with the Type tool), walk
          // up to the parent text frame.
          if (bounds.constructor && /^(InsertionPoint|Character|Word|Line|Paragraph|Story|Text)$/.test(bounds.constructor.name)) {
            try { bounds = bounds.parentTextFrames[0] || bounds.parent; } catch { /* try parent */ }
          }
          if (!bounds) throw new Error('Could not resolve the selected frame.');
          // Force the document's ruler units to points for the duration
          // of our geometry math. Otherwise we'd be doing arithmetic on
          // values that could be inches, mm, picas, etc., and our fixed
          // gap/heights (in pt) would mean different things.
          const doc = activeDocument();
          const origVUnits = doc.viewPreferences.verticalMeasurementUnits;
          const origHUnits = doc.viewPreferences.horizontalMeasurementUnits;
          doc.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
          doc.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;

          let bb;
          try { bb = bounds.geometricBounds; }
          catch { throw new Error('Selection is not a frame. Draw a text frame with the Type tool, then switch to the Selection tool (V) and click the frame.'); }
          const [by1, bx1, by2, bx2] = bb;
          const width = bx2 - bx1;
          const height = by2 - by1;
          console.log('[wvnews-print] bounds (pt):', JSON.stringify(bb), 'w=', width.toFixed(1), 'h=', height.toFixed(1));
          if (width < 60 || height < 100) {
            doc.viewPreferences.verticalMeasurementUnits = origVUnits;
            doc.viewPreferences.horizontalMeasurementUnits = origHUnits;
            throw new Error(`Bounding box too small (${width.toFixed(0)}×${height.toFixed(0)}pt). Draw a larger frame (at least ~0.8"×1.4").`);
          }
          const page = bounds.parentPage;
          if (!page) {
            doc.viewPreferences.verticalMeasurementUnits = origVUnits;
            doc.viewPreferences.horizontalMeasurementUnits = origHUnits;
            throw new Error('Could not resolve the page containing the bounding box.');
          }
          console.log('[wvnews-print] target page:', page.name);

          // Region heights (points). Each is the height we reserve for
          // that region — frames auto-size to fit their text but we use
          // these as starting sizes so the layout looks right.
          const GAP = 4;
          const headlineH = Math.max(60, Math.min(120, width * 0.18));  // scales with column width
          const deckH     = story.deck ? 28 : 0;
          // Byline lives INSIDE the body story (no standalone frame).
          // The byline string is split on commas so "By Jamie Reed,
          // Staff Reporter" becomes two paragraphs that flow at the
          // top of the body column, styled BY1 then BY2 (then BY2 for
          // any additional paragraphs).
          const bylineText = splitBylineByCommas(story.byline);
          const bylineParaCount = bylineText ? bylineText.split('\r').length : 0;
          const hasPhoto  = !!(story.photo && story.photo.url);
          const captionH  = hasPhoto && story.photo.caption ? 24 : 0;
          const creditH   = hasPhoto && story.photo.credit  ? 14 : 0;
          // Photo: frame sized to the photo's actual aspect ratio so
          // the image fills it edge-to-edge with no letterboxing.
          // Cap the height at 50% of the bounding box so very tall
          // portraits don't dominate the layout. If we don't know the
          // photo's dimensions, fall back to a 4:3-ish default.
          let photoH = 0;
          if (hasPhoto) {
            const photoW = Number(story.photo.width)  || 0;
            const photoNativeH = Number(story.photo.height) || 0;
            if (photoW > 0 && photoNativeH > 0) {
              const aspect = photoNativeH / photoW;        // height / width
              photoH = Math.min(width * aspect, height * 0.5);
            } else {
              photoH = Math.min(width * 0.66, height * 0.5);
            }
          }

          // Compute the body's available height (the residual). Note:
          // bylineH is NOT subtracted — the byline frame is positioned
          // on TOP of the body frame (overlapping its top region) and
          // body text wraps around it (text wrap is applied to every
          // frame the plugin creates). So body takes the full residual.
          const fixedH = headlineH + deckH + photoH + captionH + creditH;
          const gapCount = [headlineH, deckH, photoH, captionH, creditH].filter(h => h > 0).length;
          const totalGaps = GAP * gapCount;
          const bodyH = Math.max(50, height - fixedH - totalGaps);

          if (bodyH < 50) {
            console.warn('[wvnews-print] body region is very short:', bodyH);
          }

          // Walk top→bottom, place each region. Track the next available y.
          let y = by1;
          const created = {};

          function makeTextFrame(label, h, contents, opts = {}) {
            if (h <= 0) return null;
            const tf = page.textFrames.add({
              geometricBounds: [y, bx1, y + h, bx2],
              label,
            });
            if (contents != null && contents !== '') {
              tf.parentStory.contents = String(contents);
            }
            applyTextWrap(tf);
            y += h + (opts.noGapAfter ? 0 : GAP);
            return tf;
          }
          function makeImageFrame(label, h, opts = {}) {
            if (h <= 0) return null;
            // Use a rectangle for the image holder — InDesign places
            // images into rectangles or text frames; rectangle is the
            // more conventional photo container.
            const rect = page.rectangles.add({
              geometricBounds: [y, bx1, y + h, bx2],
              label,
            });
            applyTextWrap(rect);
            y += h + (opts.noGapAfter ? 0 : GAP);
            return rect;
          }

          // Photo group at the TOP of the stack — image, then credit
          // flush against its bottom edge, then caption. Photo + credit
          // are visually attached (no gap between them); caption sits
          // below the credit with a standard gap.
          created.photo    = makeImageFrame('photoFrame', photoH,
            { noGapAfter: creditH > 0 || captionH > 0 ? true : false });
          created.credit   = makeTextFrame('creditFrame',  creditH,
            story.photo?.credit  || '', { noGapAfter: captionH > 0 ? false : false });
          created.caption  = makeTextFrame('captionFrame', captionH,
            story.photo?.caption || '');
          // Headline + deck below the photo group.
          created.headline = makeTextFrame('headlineFrame', headlineH, story.headline || '');
          created.deck     = makeTextFrame('deckFrame',     deckH,     story.deck || '');
          // Bottom inset spacing for headline (.1875 in = 13.5 pt) and
          // deck (.125 in = 9 pt). Ruler is forced to points up-stream,
          // so we set in points. insetSpacing is [top, left, bottom, right].
          try {
            if (created.headline) {
              created.headline.textFramePreferences.insetSpacing = [0, 0, 13.5, 0];
            }
            if (created.deck) {
              created.deck.textFramePreferences.insetSpacing = [0, 0, 9, 0];
            }
          } catch (e) {
            console.warn('[wvnews-print] could not set headline/deck inset spacing:', e);
          }
          // (Byline lives inside the body story now — see body composition
          // below. No standalone byline frame.)
          // Body takes the rest of the bounding box. If there's a
          // dateline, it goes in as the first paragraph (styled
          // DatelineLeft); the body content follows.
          //
          // Column count auto-scales with the body frame's width.
          // Threshold ladder (130pt ≈ 1.8" per column):
          //   < 130pt   → 1 column
          //   130–259   → 2 columns
          //   260–389   → 3
          //   390–519   → 4
          //   520–649   → 5
          //   …
          const targetColWidthPt = 130;
          const bodyColCount = Math.max(1, Math.floor(width / targetColWidthPt) + 1);
          let bodyFrame = null;
          if (bodyH > 0) {
            bodyFrame = page.textFrames.add({
              geometricBounds: [y, bx1, by2, bx2],
              label: 'bodyFrame',
            });
            applyTextWrap(bodyFrame);
            try {
              const pref = bodyFrame.textFramePreferences;
              pref.textColumnCount = bodyColCount;
              pref.textColumnGutter = 9; // 9pt = ~0.125", standard newspaper gutter
              console.log('[wvnews-print] body frame columns:', bodyColCount,
                '(width', width.toFixed(0) + 'pt ÷', targetColWidthPt + 'pt target)');
            } catch (e) {
              console.warn('[wvnews-print] could not set body columns:', e);
            }
            const bodyText = story.bodyText || story.bodyHtml || '';
            // Compose body story top-to-bottom:
            //   [byline paragraphs (1 or more)]   ← BY1 then BY2 then BY2…
            //   [body paragraphs]                 ← BCJ Body Copy Justified
            //
            // No structured dateline paragraph is inserted. If the body
            // text already starts with an inline dateline prefix (e.g.
            // "CHARLESTON — In a unanimous vote…"), we leave it in
            // place — that's part of the body copy, not a separate
            // element.
            const parts = [];
            if (bylineText) parts.push(bylineText);
            parts.push(bodyText);
            bodyFrame.parentStory.contents = parts.join('\r');
          }
          created.body = bodyFrame;

          // Apply paragraph styles to each labeled frame.
          function applyStyle(frame, styleKey) {
            if (!frame || !frame.parentStory) return;
            const styleName = styleMap?.paragraph?.[styleKey];
            if (!styleName) return;
            try {
              const style = doc.paragraphStyles.itemByName(styleName);
              if (!style || !style.isValid) {
                console.warn('[wvnews-print] paragraph style not found:', styleName);
                return;
              }
              for (let i = 0; i < frame.parentStory.paragraphs.length; i++) {
                frame.parentStory.paragraphs.item(i).applyParagraphStyle(style, true);
              }
            } catch (e) {
              console.warn('[wvnews-print] could not apply', styleName, e);
            }
          }
          applyStyle(created.headline, 'headline');
          applyStyle(created.deck,     'deck');
          applyStyle(created.caption,  'caption');
          applyStyle(created.credit,   'credit');
          // Body gets BCJ applied to every paragraph first — then we
          // override the byline paragraphs (BY1/BY2) and dateline
          // paragraph (DatelineLeft) in place.
          applyStyle(created.body,     'body');

          // Body paragraph layout (top → bottom):
          //   [0 .. bylineParaCount-1]      → BY1 (para 0) / BY2 (rest)
          //   [bylineParaCount  ..       ]  → BCJ Body Copy Justified (already applied)
          if (created.body && bylineParaCount > 0) {
            const paras = created.body.parentStory.paragraphs;
            const by1Name = styleMap?.paragraph?.byline;
            const by2Name = styleMap?.paragraph?.byline2;
            try {
              if (by1Name && paras.length > 0) {
                const s = doc.paragraphStyles.itemByName(by1Name);
                if (s && s.isValid) paras.item(0).applyParagraphStyle(s, true);
              }
              if (bylineParaCount > 1 && by2Name) {
                const s = doc.paragraphStyles.itemByName(by2Name);
                if (s && s.isValid) {
                  for (let i = 1; i < bylineParaCount && i < paras.length; i++) {
                    paras.item(i).applyParagraphStyle(s, true);
                  }
                }
              }
            } catch (e) { console.warn('[wvnews-print] body paragraph styling failed:', e); }
          }

          // Place the photo via signed URL if we have one. We use
          // FILL_PROPORTIONALLY so the image fills the frame edge-to-edge
          // and crops anything outside. Since the frame's aspect ratio
          // is already sized to match the photo (when dimensions are
          // known), there's typically nothing to crop — but if the
          // 50%-height cap kicked in, this prevents letterboxing.
          if (created.photo && story.photo && story.photo.url) {
            try {
              const buf = await fetchBinary(story.photo.url);
              const ext = (story.photo.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
              const tempPath = await writeTemp(`${story.id || 'story'}-photo.${ext}`, buf);
              created.photo.place(tempPath);
              try { created.photo.fit(id.FitOptions.FILL_PROPORTIONALLY); } catch {}
            } catch (e) {
              console.warn('[wvnews-print] photo placement failed:', e);
            }
          }

          // Remove the original bounding rectangle (it was just a hint).
          try { bounds.remove(); } catch (e) {
            console.warn('[wvnews-print] could not remove bounding rectangle:', e);
          }

          const win = doc.layoutWindows[0];
          const framesBound = Object.entries(created)
            .filter(([, f]) => !!f)
            .map(([k]) => k);

          // Stamp every created frame with the asset ID so we can later
          // detect whether the operator has deleted the story off the
          // page. insertLabel is a key/value scratchpad on each
          // pageItem, separate from the script label.
          if (story && story.id) {
            for (const [, f] of Object.entries(created)) {
              if (!f) continue;
              try { f.insertLabel('wvnews-asset-id', String(story.id)); }
              catch (e) { /* best-effort */ }
            }
          }

          // Restore the document's original ruler units.
          try {
            doc.viewPreferences.verticalMeasurementUnits = origVUnits;
            doc.viewPreferences.horizontalMeasurementUnits = origHUnits;
          } catch { /* best-effort */ }

          resolve({
            documentName: doc.name,
            page: win ? win.activePage.name : '',
            framesBound,
          });
        } catch (e) {
          console.error('[wvnews-print] story package build error:', e);
          reject(e);
        }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: build story package`,
    );
  });
}

// Blox-style combined flow: build the entire story into one stream
// (headline, deck, byline, dateline, body paragraphs), then walk the
// resulting paragraphs and stamp each region with its matching
// paragraph style from the style map.
async function flowCombinedStoryStream(frame, story, styleMap, opts = {}) {
  const includeHeadline = !!opts.includeHeadline;
  const includeByline = opts.includeByline !== false;   // default true
  if (!frame.parentStory) return;

  // Build the stream + remember which paragraph index gets which style.
  const regions = [];   // { text, styleKey }
  function add(text, styleKey) {
    if (text == null || text === '') return;
    const paras = String(text).split(/\r?\n+/).filter(p => p.trim() !== '');
    for (const p of paras) regions.push({ text: p, styleKey });
  }

  // When called for a labeled `storyFrame` (multi-frame layout where
  // headline/deck/kicker live in their own frames), opts.includeHeadline
  // is false and we only pour byline + dateline + body into the
  // running-copy frame.
  //
  // When called from placeStoryIntoSelectedFrame (Blox-style one-frame
  // mode), opts.includeHeadline is true and EVERYTHING goes into the
  // single frame — kicker, headline, deck, byline, dateline, body —
  // each region tagged with its matching paragraph style.
  if (includeHeadline) {
    if (story.kicker)    add(story.kicker,    'kicker');
    if (story.headline)  add(story.headline,  'headline');
    if (story.deck)      add(story.deck,      'deck');
  }
  if (includeByline && story.byline)    add(story.byline,    'byline');
  if (includeByline && story.dateline)  add(story.dateline,  'dateline');
  // Body — split paragraphs. Prefer plain text for clean line breaks;
  // `body` is the field name on edition asset-content payloads.
  const body = story.bodyText || story.bodyHtml || story.body || '';
  add(body, 'body');
  // First body paragraph gets the bodyFirst style if defined (drop-cap variant).
  // We tag it specifically so the styling loop below can use it.
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].styleKey === 'body') {
      regions[i].styleKey = 'bodyFirst';
      break;
    }
  }
  // We tagged the LAST body para as bodyFirst above which is wrong;
  // we want the FIRST. Re-do: find the first body para and tag it.
  // (Easier than reasoning about the search direction.)
  let firstBodyIdx = -1;
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].styleKey === 'body' || regions[i].styleKey === 'bodyFirst') {
      firstBodyIdx = i;
      break;
    }
  }
  if (firstBodyIdx >= 0) {
    for (let i = 0; i < regions.length; i++) {
      if (regions[i].styleKey === 'bodyFirst') regions[i].styleKey = 'body';
    }
    regions[firstBodyIdx].styleKey = 'bodyFirst';
  }

  const text = regions.map(r => r.text).join('\r');
  frame.parentStory.contents = '';
  frame.parentStory.contents = text;

  // Now walk the resulting paragraphs and apply each region's style.
  // After the assignment above, paragraphs map 1:1 with regions.
  const paras = frame.parentStory.paragraphs;
  const doc = activeDocument();
  const id = host();
  // In a multi-column box, the headline/deck/kicker should span all
  // columns while the byline + body flow within them — so the combined
  // box reads like the separate-frame layout.
  const SPAN_KEYS = { kicker: 1, headline: 1, deck: 1 };
  for (let i = 0; i < regions.length && i < paras.length; i++) {
    const styleKey = regions[i].styleKey;
    try {
      const par = paras.item(i);
      try {
        par.spanColumnType = SPAN_KEYS[styleKey]
          ? id.SpanColumnTypeOptions.SPAN_COLUMNS
          : id.SpanColumnTypeOptions.SINGLE_COLUMN;
      } catch {}
    } catch {}
    const styleName = styleMap && styleMap.paragraph && styleMap.paragraph[styleKey];
    if (!styleName) continue;
    try {
      const style = doc.paragraphStyles.itemByName(styleName);
      if (style && style.isValid) {
        paras.item(i).applyParagraphStyle(style, true);
      }
    } catch { /* style application is best-effort */ }
  }
}

// Cross-document Dead Drop — phase 1: capture the source.
//
// Production Blox convention: the source page has the body frame AND
// a separate small frame labeled `turnlineFrame` (typically bottom of
// the body column) that receives the "See SLUG, A4" jump-out line.
// They live in independent text frames so each can be styled and
// positioned independently — JTL Jump Turnline's object style is
// even bottom-aligned per the Exponent stylesheet.
//
// Operator selects the source body frame (the overflowing one). We:
//   1. Compute the overflow text (everything the frame can't show)
//   2. Surgically truncate the body story to just the visible portion
//      (preserving its existing paragraph styles)
//   3. Locate `turnlineFrame` on the same spread (by Script Label) and
//      populate it with `See SLUG, [DESTPAGE]`, styled JTL Jump Turnline
//   4. Stash overflow + slug + source page label for phase 2
async function captureSourceForJump(slug, styleMap) {
  const id = host();
  console.log('[wvnews-print] captureSourceForJump: slug=', slug);
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        // Force ruler units to points so our turnline frame auto-create
        // math (4pt gap, 22pt height) is interpreted correctly regardless
        // of the document's current measurement units.
        let origVUnits, origHUnits;
        const docForUnits = activeDocument();
        try {
          origVUnits = docForUnits.viewPreferences.verticalMeasurementUnits;
          origHUnits = docForUnits.viewPreferences.horizontalMeasurementUnits;
          docForUnits.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
          docForUnits.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
        } catch { /* fall through */ }
        function restoreUnits() {
          try {
            if (origVUnits != null) docForUnits.viewPreferences.verticalMeasurementUnits = origVUnits;
            if (origHUnits != null) docForUnits.viewPreferences.horizontalMeasurementUnits = origHUnits;
          } catch { /* best-effort */ }
        }

        try {
          const sel = id.app.selection;
          if (!sel || !sel.length) { restoreUnits(); throw new Error('Select the overflowing source frame first.'); }
          const source = sel[0];
          if (!source.parentStory) { restoreUnits(); throw new Error('Selection is not a text frame.'); }

          const sourcePage = (() => {
            try { return source.parentPage?.name || ''; } catch { return ''; }
          })();
          if (!sourcePage) { restoreUnits(); throw new Error('Could not read the source frame\'s page label.'); }

          const safeSlug = String(slug || '').trim().toUpperCase().replace(/[^A-Z0-9 -]/g, '') || 'CONTINUED';

          // Capture the full story contents BEFORE we modify anything.
          const story = source.parentStory;
          const fullText = story.contents;
          const totalLen = fullText.length;

          // What's actually visible in the source frame? Use `lines` —
          // it only contains laid-out lines (overset content is excluded).
          // The last character of the last visible line, plus 1, is the
          // exact story-index where overset begins.
          //
          // `source.characters.length` is NOT reliable for this: on an
          // unthreaded overset frame it can return 0 or the full story
          // length depending on InDesign's composition state. Using
          // lines avoids that ambiguity.
          let visibleLen = totalLen;
          try {
            const lineCount = source.lines.length;
            if (lineCount > 0) {
              const lastLine = source.lines.item(lineCount - 1);
              const lastChar = lastLine.characters.item(lastLine.characters.length - 1);
              // `index` is the position in the parent story.
              visibleLen = lastChar.index + 1;
            } else {
              // Frame has zero laid-out lines (height too small?). Bail
              // out so we don't dump the whole story into the jump page.
              throw new Error('Source frame has no visible lines — nothing to jump.');
            }
          } catch (e) {
            // If we can't measure visible text at all, abort rather
            // than producing a wrong split.
            if (e && /no visible lines/.test(e.message || '')) throw e;
            console.warn('[wvnews-print] line-based visibleLen probe failed, falling back to characters.length:', e);
            try {
              visibleLen = source.characters.length;
            } catch { visibleLen = totalLen; }
          }
          if (visibleLen > totalLen) visibleLen = totalLen;
          if (visibleLen < 0) visibleLen = 0;
          console.log('[wvnews-print] captureSourceForJump: totalLen=', totalLen, 'visibleLen=', visibleLen);

          // Snap the split point back to the previous SENTENCE boundary
          // — either a paragraph break (\r) or a sentence terminator
          // (. ! ?) followed by whitespace. The source page shows the
          // partial start of the cut paragraph up to its last completed
          // sentence; the rest of that paragraph (and everything after)
          // flows to the jump page. We never cut mid-sentence/mid-word.
          let splitAt = visibleLen;
          if (visibleLen < totalLen) {
            let i = visibleLen - 1;
            while (i > 0) {
              const ch = fullText.charAt(i);
              if (ch === '\r') {
                splitAt = i + 1; // after the paragraph break
                break;
              }
              if (ch === '.' || ch === '!' || ch === '?') {
                const next = fullText.charAt(i + 1);
                if (next === ' ' || next === '\r' || next === '\n' || next === '\t' || i + 1 >= visibleLen) {
                  splitAt = i + 1; // just past the terminator
                  break;
                }
              }
              i--;
            }
            // If no sentence boundary found at all, fall back to
            // visibleLen so we still split somewhere (better than
            // dumping the whole story to the jump page).
            if (i <= 0) splitAt = visibleLen;
          }
          const overflowText = fullText.slice(splitAt).replace(/^[\s\r]+/, '');
          console.log('[wvnews-print] captureSourceForJump: splitAt=', splitAt, 'overflowChars=', overflowText.length);

          // Surgically truncate the body story at the paragraph boundary
          // (splitAt), NOT at visibleLen. If we cut at visibleLen we'd
          // leave the orphan start of the jumped paragraph dangling at
          // the bottom of the source frame.
          // We use `splitAt` so the whole paragraph that overflowed
          // moves cleanly to the jump page.
          // Setting `story.contents = ...` would strip every paragraph
          // style — use surgical character removal instead.
          if (splitAt < totalLen) {
            try {
              story.characters.itemByRange(splitAt, totalLen - 1).remove();
            } catch {
              story.contents = fullText.slice(0, splitAt);
            }
          }
          // Trim trailing whitespace/newlines so the body frame ends
          // cleanly without dangling paragraph breaks.
          try {
            const tailLen = story.contents.length;
            const trimmedTail = story.contents.replace(/[\s\r]+$/, '').length;
            if (tailLen > trimmedTail) {
              story.characters.itemByRange(trimmedTail, tailLen - 1).remove();
            }
          } catch { /* best-effort */ }

          // Locate the SEPARATE turnline frame by Script Label. Search
          // order:
          //   1. The current page's items
          //   2. Other pages on the same spread
          // Append the turnline as the LAST paragraph of the source
          // body story — no separate frame. The line shows as the
          // tail end of the body copy on the source page.
          // [DESTPAGE] is a placeholder phase 2 patches with the real
          // destination page label.
          const jumpOutLine = `See ${safeSlug}, [DESTPAGE]`;
          try {
            story.insertionPoints.lastItem().contents = '\r\r' + jumpOutLine;
            const doc = activeDocument();
            const jumpOutStyleName = styleMap?.paragraph?.jumpOut || 'JTL Jump Turnline';
            const style = doc.paragraphStyles.itemByName(jumpOutStyleName);
            if (style && style.isValid) {
              story.paragraphs.item(story.paragraphs.length - 1).applyParagraphStyle(style, true);
              console.log('[wvnews-print] applied', jumpOutStyleName, 'to turnline paragraph in body story');
            } else {
              console.warn('[wvnews-print] paragraph style not found:', jumpOutStyleName);
            }
          } catch (e) {
            console.warn('[wvnews-print] could not append turnline:', e);
          }

          const payload = {
            sourcePage,
            sourceDocName: activeDocument().name,
            slug: safeSlug,
            overflowText,
            overflowChars: overflowText.length,
            turnlinePlaced: true,
          };
          restoreUnits();
          resolve(payload);
        } catch (e) {
          restoreUnits();
          console.error('[wvnews-print] captureSourceForJump error:', e);
          reject(e);
        }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: capture source for jump`,
    );
  });
}

// Cross-document Dead Drop — phase 2: drop into the destination.
//
// Production Blox convention: destination page has THREE separate
// labeled frames:
//   `jumpKeywordFrame`   — receives the big bold keyword ("CENTER"),
//                          styled JC1 Continued Keyword
//   `jumpContinuedFrame` — receives "(Continued from Page A1)",
//                          styled JC2 Continued
//   `bodyFrame`          — receives the overflow body (whatever
//                          paragraph styles the master template defines)
//
// Operator selects the destination `bodyFrame` (or any frame on the
// dest spread) and clicks Drop. We find the other two by Script Label
// on the same spread.
async function completeJumpToFrame(pending, styleMap) {
  const id = host();
  console.log('[wvnews-print] completeJumpToFrame: slug=', pending.slug);
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        // Force the document's ruler units to points for the duration
        // of our geometry math. Otherwise our fixed gap/heights (in pt)
        // get interpreted in whatever unit the doc uses (inches, picas)
        // and the auto-created frames come out huge or misaligned.
        let origVUnits, origHUnits;
        const docForUnits = activeDocument();
        try {
          origVUnits = docForUnits.viewPreferences.verticalMeasurementUnits;
          origHUnits = docForUnits.viewPreferences.horizontalMeasurementUnits;
          docForUnits.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
          docForUnits.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
        } catch { /* fall through */ }

        function restoreUnits() {
          try {
            if (origVUnits != null) docForUnits.viewPreferences.verticalMeasurementUnits = origVUnits;
            if (origHUnits != null) docForUnits.viewPreferences.horizontalMeasurementUnits = origHUnits;
          } catch { /* best-effort */ }
        }

        try {
          const sel = id.app.selection;
          if (!sel || !sel.length) { restoreUnits(); throw new Error('Select an empty destination frame first.'); }
          const dest = sel[0];
          if (!dest.parentStory) { restoreUnits(); throw new Error('Selection is not a text frame.'); }

          const destPage = (() => {
            try { return dest.parentPage?.name || ''; } catch { return ''; }
          })();
          if (!destPage) { restoreUnits(); throw new Error('Could not read the destination frame\'s page label.'); }

          const destDocName = activeDocument().name;
          const safeSlug = pending.slug;
          const jumpInLine = `(Continued from Page ${pending.sourcePage})`;

          // Find keyword + continued frames by Script Label. Same
          const doc = activeDocument();

          // Compose the destination body story top-to-bottom:
          //   [keyword paragraph]             ← JC1 Continued Keyword
          //   [(Continued from Page A1)]      ← JC2 Continued
          //   [empty paragraph]               ← breathing room before body
          //   [overflow body paragraphs]      ← BCJ Body Copy Justified
          //
          // Everything lives in the destination bodyFrame's story — no
          // separate jumpFrame is created. The empty paragraph between
          // the "(Continued from…)" line and the body keeps body copy
          // from butting against the jump header.
          const dStory = dest.parentStory;
          const overflow = pending.overflowText || '';
          const headerBlock = `${safeSlug}\r${jumpInLine}`;
          const composed = overflow ? `${headerBlock}\r\r${overflow}` : headerBlock;
          dStory.contents = composed;

          // Style the paragraphs in place.
          try {
            const kwStyleName = styleMap?.paragraph?.jumpInKeyword || 'JC1 Continued Keyword';
            const ctStyleName = styleMap?.paragraph?.jumpIn || 'JC2 Continued';
            const bodyStyleName = styleMap?.paragraph?.body || 'BCJ Body Copy Justified';
            const paras = dStory.paragraphs;
            const kwStyle = doc.paragraphStyles.itemByName(kwStyleName);
            const ctStyle = doc.paragraphStyles.itemByName(ctStyleName);
            const bodyStyle = doc.paragraphStyles.itemByName(bodyStyleName);
            if (kwStyle && kwStyle.isValid && paras.length > 0) {
              paras.item(0).applyParagraphStyle(kwStyle, true);
              console.log('[wvnews-print] applied', kwStyleName, 'to dest body para 0 (keyword)');
            } else if (!kwStyle?.isValid) {
              console.warn('[wvnews-print] paragraph style not found:', kwStyleName);
            }
            if (ctStyle && ctStyle.isValid && paras.length > 1) {
              paras.item(1).applyParagraphStyle(ctStyle, true);
              console.log('[wvnews-print] applied', ctStyleName, 'to dest body para 1 (continued-from)');
            } else if (!ctStyle?.isValid) {
              console.warn('[wvnews-print] paragraph style not found:', ctStyleName);
            }
            if (bodyStyle && bodyStyle.isValid) {
              for (let i = 2; i < paras.length; i++) {
                paras.item(i).applyParagraphStyle(bodyStyle, true);
              }
              console.log('[wvnews-print] applied', bodyStyleName, 'to dest body paras 2+');
            } else if (!bodyStyle?.isValid) {
              console.warn('[wvnews-print] paragraph style not found:', bodyStyleName);
            }
          } catch (e) {
            console.warn('[wvnews-print] dest body styling failed:', e);
          }

          // Patch the [DESTPAGE] placeholder in the source doc's
          // turnline. We look for the exact "See SLUG, [DESTPAGE]"
          // string — the slug makes it unique. Surgical character
          // replacement preserves the paragraph style on the rest of
          // the body.
          const needle = `See ${safeSlug}, [DESTPAGE]`;
          const replacement = `See ${safeSlug}, ${destPage}`;
          let patchedInDoc = '';
          try {
            for (let d = 0; d < id.app.documents.length; d++) {
              const doc = id.app.documents.item(d);
              for (let s = 0; s < doc.stories.length; s++) {
                const st = doc.stories.item(s);
                const c = st.contents;
                if (typeof c !== 'string') continue;
                const idx = c.indexOf(needle);
                if (idx === -1) continue;
                // Replace only the placeholder substring, preserving
                // surrounding paragraph styles.
                try {
                  st.characters.itemByRange(idx, idx + needle.length - 1).remove();
                  st.insertionPoints.item(idx).contents = replacement;
                } catch {
                  // Fallback: full content rewrite.
                  st.contents = c.replace(needle, replacement);
                }
                patchedInDoc = doc.name;
                break;
              }
              if (patchedInDoc) break;
            }
          } catch (e) {
            console.warn('[wvnews-print] turnline patch failed:', e);
          }

          restoreUnits();
          resolve({
            sourceDocName: pending.sourceDocName,
            sourcePage: pending.sourcePage,
            destDocName,
            destPage,
            slug: pending.slug,
            patchedInDoc,
            jumpPlaced: true,   // keyword + continued always inserted into dest body now
          });
        } catch (e) {
          restoreUnits();
          console.error('[wvnews-print] completeJumpToFrame error:', e);
          reject(e);
        }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: complete jump`,
    );
  });
}

// Legacy single-document Dead Drop kept for backwards compatibility —
// not used by the new two-phase UI but still exported in case.
async function threadAndJump(slug, styleMap) {
  const id = host();
  console.log('[wvnews-print] threadAndJump: starting slug=', slug);
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const sel = id.app.selection;
          if (!sel || sel.length < 2) {
            throw new Error('Select two text frames first: the overflowing source on page 1 AND an empty destination frame on the jump page.');
          }
          // Pick source = the one that overflows. If neither overflows,
          // fall back to "first selected" so the user still gets feedback.
          let source = null, dest = null;
          for (const it of sel) {
            const isTextFrame = it && it.parentStory;
            if (!isTextFrame) continue;
            const overflows = (() => {
              try { return !!it.overflows; } catch { return false; }
            })();
            if (overflows && !source) source = it;
            else if (!dest) dest = it;
            else if (!source) source = it;
          }
          if (!source || !dest) {
            // Neither overflows, or one isn't a text frame — best-effort fallback.
            const frames = sel.filter(it => it && it.parentStory);
            if (frames.length < 2) throw new Error('Both selections must be text frames.');
            source = source || frames[0];
            dest   = dest   || frames.find(f => f !== source);
          }
          if (source === dest) throw new Error('Could not distinguish source from destination.');

          // Read page labels BEFORE we modify anything so the inserted
          // labels are accurate.
          const sourcePage = (() => {
            try { return source.parentPage?.name || ''; } catch { return ''; }
          })();
          const destPage = (() => {
            try { return dest.parentPage?.name || ''; } catch { return ''; }
          })();

          if (!sourcePage || !destPage) {
            throw new Error('Could not read page labels from frame parents.');
          }

          const safeSlug = String(slug || '').trim().toUpperCase().replace(/[^A-Z0-9 -]/g, '') || 'CONTINUED';
          const jumpOutLine = `See ${safeSlug}, ${destPage}`;
          const jumpInLine  = `(Continued from Page ${sourcePage})`;

          // Insert jump-out line at end of source's visible text (its
          // own paragraph). We append after the existing contents, then
          // tag the new paragraph with the Jump Out style.
          const sStory = source.parentStory;
          const sLenBefore = sStory.contents.length;
          // Ensure a blank paragraph sits between body copy and turnline.
          // If story already ends with \r, we still need one more \r for
          // the blank line; if it doesn't, we need two.
          const sHasContent = sLenBefore > 0;
          const sEndsWithReturn = sHasContent && sStory.contents[sLenBefore - 1] === '\r';
          const sLead = sHasContent ? (sEndsWithReturn ? '\r' : '\r\r') : '';
          sStory.insertionPoints.lastItem().contents = sLead + jumpOutLine;
          applyStyleToLastParagraph(sStory, styleMap?.paragraph?.jumpOut || 'Jump Out');

          // Thread source to destination. This is the magic — InDesign
          // auto-flows everything past the source's visible region into
          // the destination's frame.
          source.nextTextFrame = dest;

          // Insert the jump-in header at the start of the destination
          // frame. Blox/Exponent convention is two stacked paragraphs:
          //   Line 1 — big bold keyword (e.g. "CENTER") tagged JC1 Continued Keyword
          //   Line 2 — "(Continued from Page A1)" tagged JC2 Continued
          // Then the body flows in below them. We insert both lines
          // before the existing dest text in a single shot, then style
          // each paragraph in place.
          const destFirstRun = dest.texts.item(0);
          if (destFirstRun && destFirstRun.insertionPoints.length > 0) {
            const headerBlock = `${safeSlug}\r${jumpInLine}\r`;
            destFirstRun.insertionPoints.item(0).contents = headerBlock;
            try {
              const doc = activeDocument();
              const keywordStyleName = styleMap?.paragraph?.jumpInKeyword || 'Jump In Keyword';
              const continuedStyleName = styleMap?.paragraph?.jumpIn || 'Jump In';
              const kwStyle = doc.paragraphStyles.itemByName(keywordStyleName);
              const ctStyle = doc.paragraphStyles.itemByName(continuedStyleName);
              if (kwStyle && kwStyle.isValid) {
                destFirstRun.paragraphs.item(0).applyParagraphStyle(kwStyle, true);
              }
              if (ctStyle && ctStyle.isValid) {
                destFirstRun.paragraphs.item(1).applyParagraphStyle(ctStyle, true);
              }
            } catch { /* best-effort */ }
          }

          resolve({
            documentName: activeDocument().name,
            sourcePage,
            destPage,
            slug: safeSlug,
            jumpOutLine,
            jumpInLine,
          });
        } catch (e) {
          console.error('[wvnews-print] threadAndJump error:', e);
          reject(e);
        }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.ENTIRE_SCRIPT,
      `WVNews Print: thread + jump`,
    );
  });
}

// Walk every open document, collect the set of asset IDs whose
// stamped frames are still present. Used by the panel to detect when
// the operator has deleted a placed story off the page.
//
// Returns { docNames: [...], assetIds: [...] }:
//   docNames — names of every currently open document (so the panel
//              knows which placements are "in scope" of this scan;
//              placements in closed docs can't be verified)
//   assetIds — IDs found via `insertLabel('wvnews-asset-id', …)` on
//              any pageItem in any open doc
async function verifyPlacedAssets() {
  const id = host();
  return await new Promise((resolve, reject) => {
    id.app.doScript(
      async () => {
        try {
          const found = new Set();
          const docNames = [];
          for (let d = 0; d < id.app.documents.length; d++) {
            const doc = id.app.documents.item(d);
            docNames.push(doc.name);
            for (let p = 0; p < doc.pages.length; p++) {
              const page = doc.pages.item(p);
              const items = page.allPageItems;
              for (let i = 0; i < items.length; i++) {
                try {
                  const v = items[i].extractLabel('wvnews-asset-id');
                  if (v) found.add(String(v));
                } catch { /* not a labelable item */ }
              }
            }
          }
          resolve({ docNames, assetIds: Array.from(found) });
        } catch (e) {
          console.error('[wvnews-print] verifyPlacedAssets error:', e);
          reject(e);
        }
      },
      id.ScriptLanguage.UXPSCRIPT, undefined,
      id.UndoModes.FAST_ENTIRE_SCRIPT,
      `WVNews Print: verify placements`,
    );
  });
}

function applyStyleToLastParagraph(story, styleName) {
  try {
    const doc = activeDocument();
    const style = doc.paragraphStyles.itemByName(styleName);
    if (style && style.isValid) {
      const lastPara = story.paragraphs.item(story.paragraphs.length - 1);
      lastPara.applyParagraphStyle(style, true);
    }
  } catch { /* best-effort */ }
}

async function flowIntoFrame(frame, bindKind, value, styleHint, styleMap, story) {
  const id = host();
  if (value == null) return;
  if (bindKind === 'photo' || bindKind === 'photo2' || bindKind === 'photo3') {
    const photo = bindKind === 'photo' ? story.photo : story[bindKind] || story.photo;
    if (!photo || !photo.url) return;
    const buf = await fetchBinary(photo.url);
    const ext = (photo.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
    const tempPath = await writeTemp(`${story.id}-${bindKind}.${ext}`, buf);
    frame.place(tempPath);
    try { frame.fit(id.FitOptions.PROPORTIONALLY); } catch {}
    return;
  }
  if (frame.parentStory) {
    frame.parentStory.contents = '';
    frame.parentStory.contents = String(value);
    const styleName = styleHint || (styleMap && styleMap.paragraph && styleMap.paragraph[bindKind]);
    if (styleName) applyParagraphStyle(frame.parentStory, styleName);
  }
}

function applyParagraphStyle(text, name) {
  try {
    const doc = activeDocument();
    let style = null;
    try { style = doc.paragraphStyles.itemByName(name); } catch {}
    if (style && style.isValid) {
      text.applyParagraphStyle(style, true);
    }
  } catch {}
}

// Apply bounding-box text wrap with a small offset to a frame. Used
// on every frame the plugin creates so adjacent body text auto-flows
// around them when the operator repositions things manually after
// the fact. 6pt offset = ~0.08", a standard newsroom default.
// Auto-paginate a single page: read the layout config for the given
// publication profile + page role, sort the assigned stories by
// weight, assign each to a position in priority order, and place
// every Story Block via placeAndBindStoryBlock.
//
// pubProfile — e.g. 'exponent-daily' (corresponds to a folder under assets/layouts/)
// pageRole   — e.g. 'A1' (corresponds to a .json file in that folder)
// stories    — array of budget assets assigned to this page
// Returns { placements: [{story, weight, position, placed, error?}...], unplaced: [...], skipped: [...] }
async function autoPaginatePage(pubProfile, pageRole, stories) {
  if (!stories || !stories.length) {
    throw new Error('No stories provided to paginate.');
  }
  // Prefer a bespoke config for this folio (e.g. A1.json); otherwise fall
  // back to the profile's generic inside-page grid (_inside.json) so every
  // inside page (A2, A3, B1, …) can paginate without a file per folio.
  let config;
  try {
    config = await readAssetJson(`layouts/${pubProfile}/${pageRole}.json`);
  } catch (e) {
    try {
      config = await readAssetJson(`layouts/${pubProfile}/_inside.json`);
      console.log(`[wvnews-print] auto-paginate: no ${pageRole}.json — using _inside.json`);
    } catch (e2) {
      throw new Error(`No layout config for ${pubProfile}/${pageRole}, and no _inside.json fallback in this profile.`);
    }
  }
  console.log('[wvnews-print] auto-paginate:', pubProfile, pageRole, '— stories:', stories.length);

  const weightOrder = config.fillRules?.weightOrder || ['Top Story', 'Focal Story', 'Standard', 'Brief'];
  const rank = (w) => {
    const i = weightOrder.indexOf(w);
    return i === -1 ? weightOrder.length : i;
  };

  // Tag each story with its weight. Use story.weight if the editor's
  // planning system has set one; otherwise infer from list position
  // (1st = Top Story, 2nd = Focal, rest = Standard). This is the
  // pre-integration fallback so we can demo end-to-end before the
  // colleague's planning system feeds real weights.
  const enriched = stories.map((s, i) => {
    let weight = s.weight;
    if (!weight) {
      weight = (i === 0) ? 'Top Story'
             : (i === 1) ? 'Focal Story'
             : 'Standard';
    }
    return { story: s, weight };
  });
  // Sort: most important first so they claim the high-priority positions.
  enriched.sort((a, b) => rank(a.weight) - rank(b.weight));

  // Layout assignment: for each story, find the first unclaimed
  // position that accepts its weight class. Positions are already in
  // priority order in the JSON.
  const positions = (config.positions || []).filter(p => p.type !== 'ad-slot');
  const claimed = new Set();
  const placements = [];
  const unplaced = [];

  for (const { story, weight } of enriched) {
    const pos = positions.find(p => !claimed.has(p.id) && Array.isArray(p.accepts) && p.accepts.includes(weight));
    if (!pos) {
      unplaced.push({ story, weight, reason: `no position accepts weight "${weight}"` });
      continue;
    }
    claimed.add(pos.id);
    placements.push({ story, weight, position: pos, placed: false });
  }

  // Now actually place each one. We do this sequentially because each
  // placeAndBindStoryBlock call wraps in its own doScript() undo
  // transaction; running in parallel risks transaction conflicts.
  for (const p of placements) {
    const bounds = p.position.bounds_pts;
    const anchor = bounds && bounds.length >= 2
      ? { x: bounds[1], y: bounds[0] } // bounds are [top, left, bottom, right]
      : undefined;
    const blockId = p.position.defaultBlock;
    try {
      const result = await placeAndBindStoryBlock(blockId, p.story, anchor);
      p.placed = true;
      p.framesBound = result.framesBound;
      console.log('[wvnews-print] auto-paginate placed', p.story.id, 'at', p.position.id, 'as', blockId);
    } catch (e) {
      p.placed = false;
      p.error = e?.message || String(e);
      console.error('[wvnews-print] auto-paginate placement failed for', p.story.id, e);
    }
  }

  const successCount = placements.filter(p => p.placed).length;
  return {
    placements,
    unplaced,
    successCount,
    totalStories: stories.length,
    overBudgeted: unplaced.length > 0,
    overBudgetMessage: config.fillRules?.overBudgetMessage || null,
  };
}

// Map of Story Block placeholder strings (the literal text that ships
// in the snippet's text frames) to the corresponding field on a
// budget story object. Established by TownNews TCMS and being kept
// post-migration — see assets/README.md.
const STORY_BLOCK_PLACEHOLDERS = {
  'print_headline':    (s) => s.headline || '',
  'print_subheadline': (s) => s.deck || s.subheadline || '',
  'nameline':          (s) => splitBylineByCommas(s.byline) || '',
  'caption':           (s) => s.photo?.caption || s.image?.caption || '',
  'main story':        (s) => s.bodyText || s.bodyHtml || '',
};

// Available Story Block sizes — keys match filenames in
// assets/snippets/story-blocks/. Used by the layout engine to resolve
// a "block" id from the layout config into a snippet path.
const STORY_BLOCK_IDS = [
  '2col_story',
  '4col_story',
  '4col_story_1mug',
  '4col_story_1photo_1mug',
  '4col_story_2photos',
  '4col_story_2photos_boxed',
  '6col_story',
];

// Place a Story Block snippet on the page and bind the story's data
// into its placeholder text. Replacement happens in-place so the
// paragraph styles already applied in the snippet (HD HDB Head Bold,
// BCJ Body Copy Justified, IMN Image Mugshot Name) are preserved.
//
// blockId   — one of STORY_BLOCK_IDS (e.g. '4col_story_1photo_1mug')
// story     — a budget asset { id, headline, deck, byline, photo, bodyText, ... }
// anchor    — { x, y } in points: where the snippet's bounding box's
//             top-left should sit on the page. If omitted, the snippet
//             is placed at its saved origin (whatever the designer set).
//
// Returns { placed: [PageItem...], framesBound: string[] }.
async function placeAndBindStoryBlock(blockId, story, anchor) {
  const id = host();
  if (!STORY_BLOCK_IDS.includes(blockId)) {
    throw new Error(`Unknown story block id: ${blockId}`);
  }
  if (!story || !story.id) {
    throw new Error('story (with id) is required');
  }
  const snippetRel = `snippets/story-blocks/${blockId}.idms`;
  // Copy the bundled snippet to the InDesign temp folder. UXP plugin
  // folders are sandboxed and InDesign can't always read directly
  // from them via doc.place(); routing through temp matches the
  // existing placeTemplate flow and is known to work.
  let snippetPath;
  try {
    const folder = await fs().getPluginFolder();
    const entry = await folder.getEntry(`assets/${snippetRel}`);
    const buf = await entry.read({ format: require('uxp').storage.formats.binary });
    snippetPath = await writeTemp(`${blockId}.idms`, buf);
    console.log('[wvnews-print] copied snippet to temp:', snippetPath);
  } catch (e) {
    console.error('[wvnews-print] snippet temp-copy failed:', e?.message || e);
    throw e;
  }
  console.log('[wvnews-print] placing story block', blockId, 'for', story.id, 'from', snippetPath);

  // === Phase 1: place (no doScript — UXP's doScript holds the main
  // thread which blocks the async place pipeline; deadlocks if we
  // try to await inside it).
  const doc = activeDocument();
  const win = doc.layoutWindows[0];
  const page = win ? win.activePage : doc.pages.item(0);

  // Snapshot existing item ids so we can identify new items via diff.
  const existingIds = new Set();
  try {
    const all = page.allPageItems;
    const len = (all && typeof all.length === 'number') ? all.length : 0;
    for (let i = 0; i < len; i++) {
      try { existingIds.add(all[i].id); } catch { /* skip */ }
    }
    console.log(`[wvnews-print] snapshot page: ${len} items`);
  } catch (e) {
    console.warn('[wvnews-print] snapshot failed:', e?.message || e);
  }
  const baselineCt = existingIds.size;

  // Snapshot spread items too (in case the snippet lands on the
  // pasteboard or elsewhere on the spread, not the page itself).
  const spread = (() => { try { return page.parent; } catch { return null; } })();
  const existingSpreadIds = new Set();
  if (spread) {
    try {
      const all = spread.allPageItems;
      const len = (all && typeof all.length === 'number') ? all.length : 0;
      for (let i = 0; i < len; i++) {
        try { existingSpreadIds.add(all[i].id); } catch {}
      }
      console.log(`[wvnews-print] snapshot spread: ${len} items`);
    } catch (e) {
      console.warn('[wvnews-print] spread snapshot failed:', e?.message || e);
    }
  }
  const baselineSpreadCt = existingSpreadIds.size;

  // Single place call — no doScript wrapping, no NEVER_INTERACT.
  // The multi-variant probe version (which placed items successfully)
  // also didn't set NEVER_INTERACT, so we leave it alone here. .idms
  // snippets don't show import-options dialogs anyway.
  try {
    doc.place(snippetPath, true);
    console.log('[wvnews-print] doc.place(path, true) called');
  } catch (e) {
    console.error('[wvnews-print] doc.place threw:', e?.message || e);
    throw e;
  }

  // Poll for the placement to land. Now that we're NOT inside
  // doScript, setTimeout will actually fire and the place pipeline
  // can run. Wait for items to appear on EITHER the page or the
  // surrounding spread.
  const pollStart = Date.now();
  let polledPage = baselineCt;
  let polledSpread = baselineSpreadCt;
  while (Date.now() - pollStart < 2000) {
    try { polledPage = page.allPageItems.length || 0; } catch {}
    try { polledSpread = spread ? spread.allPageItems.length || 0 : 0; } catch {}
    if (polledPage > baselineCt || polledSpread > baselineSpreadCt) break;
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`[wvnews-print] post-poll: page ${baselineCt}->${polledPage}, spread ${baselineSpreadCt}->${polledSpread} (waited ${Date.now() - pollStart}ms)`);

  if (polledPage <= baselineCt && polledSpread <= baselineSpreadCt) {
    console.warn('[wvnews-print] place() did not add items within 2s — skipping bind for', story.id);
    return { placed: [], framesBound: [] };
  }

  // Collect new items via id diff — check both page and spread, since
  // a snippet may land on the pasteboard rather than the page.
  const newItems = [];
  const seenIds = new Set();
  const scan = (container, baseline, label) => {
    if (!container) return;
    try {
      const all = container.allPageItems;
      const len = (all && typeof all.length === 'number') ? all.length : 0;
      for (let i = 0; i < len; i++) {
        const item = all[i];
        let itemId;
        try { itemId = item.id; } catch { continue; }
        if (baseline.has(itemId)) continue;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        newItems.push(item);
      }
      console.log(`[wvnews-print] scanned ${label}: ${len} total`);
    } catch (e) {
      console.warn(`[wvnews-print] scan ${label} failed:`, e?.message || e);
    }
  };
  scan(page, existingIds, 'page');
  scan(spread, existingSpreadIds, 'spread');
  console.log('[wvnews-print] new items found:', newItems.length);

  // Helper to robustly determine the class of an InDesign DOM object.
  // UXP doesn't expose .constructor.name reliably; obj.toString()
  // returns "[object ClassName]".
  const classOf = (it) => {
    try {
      const s = String(it);
      const m = s.match(/^\[object\s+([A-Za-z]+)\]/);
      return m ? m[1] : '';
    } catch { return ''; }
  };

  // Move placed items to the requested anchor. Move only top-level
  // (page/spread parent); group children would double-shift.
  if (anchor && newItems.length > 0) {
    const topLevel = newItems.filter(item => {
      try {
        const pc = classOf(item.parent);
        return pc === 'Page' || pc === 'Spread';
      } catch { return false; }
    });
    console.log('[wvnews-print] top-level placed items:', topLevel.length);

    let minTop = Infinity, minLeft = Infinity;
    for (const item of topLevel) {
      try {
        const gb = item.geometricBounds;
        if (gb && gb.length >= 4) {
          if (gb[0] < minTop) minTop = gb[0];
          if (gb[1] < minLeft) minLeft = gb[1];
        }
      } catch { /* skip */ }
    }
    if (isFinite(minTop) && isFinite(minLeft)) {
      const dy = anchor.y - minTop;
      const dx = anchor.x - minLeft;
      console.log(`[wvnews-print] shifting placed group by [dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}] (from [${minLeft.toFixed(1)},${minTop.toFixed(1)}] to anchor [${anchor.x},${anchor.y}])`);
      for (const item of topLevel) {
        try {
          const gb = item.geometricBounds;
          item.geometricBounds = [gb[0] + dy, gb[1] + dx, gb[2] + dy, gb[3] + dx];
        } catch (e) {
          console.warn('[wvnews-print] could not shift item:', e?.message);
        }
      }
    }
  }

  // Walk every new text frame; if its contents matches a known
  // placeholder, replace it.
  const framesBound = [];
  for (const item of newItems) {
    const tag = classOf(item);
    let preview = '';
    try {
      if (item.parentStory) {
        preview = String(item.parentStory.contents || '').slice(0, 60).replace(/\r/g, '\\r');
      }
    } catch {}
    console.log(`[wvnews-print]   new item: ${tag || '?'} contents="${preview}"`);

    try {
      if (tag === 'TextFrame') {
        bindPlaceholderInFrame(item, story, framesBound);
      }
      try { item.insertLabel('wvnews-asset-id', String(story.id)); }
      catch { /* best-effort */ }
    } catch (e) {
      console.warn('[wvnews-print] item bind failed:', e?.message || e);
    }
  }

  // Photo: drop the story's photo into the largest rectangle in the
  // new items.
  if (story.photo?.url || story.image?.url) {
    const photoRect = findLargestRectangle(newItems, classOf);
    if (photoRect) {
      try {
        const url = story.photo?.url || story.image?.url;
        const buf = await fetchBinary(url);
        const ext = (url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
        const tempPath = await writeTemp(`${story.id}-photo.${ext}`, buf);
        photoRect.place(tempPath);
        try { photoRect.fit(id.FitOptions.FILL_PROPORTIONALLY); } catch {}
        try { photoRect.insertLabel('wvnews-asset-id', String(story.id)); } catch {}
        framesBound.push('photo');
      } catch (e) {
        console.warn('[wvnews-print] photo placement failed:', e?.message || e);
      }
    } else {
      console.log('[wvnews-print] no rectangle found for photo');
    }
  }

  console.log('[wvnews-print] framesBound:', framesBound);
  return { placed: newItems, framesBound };
}

// For a text frame whose contents matches a known placeholder string,
// replace it with the story's corresponding field value. Records
// which fields were bound by adding the placeholder name to
// `framesBound`.
//
// Matching strategy (in order):
//   1. Exact equality after trim + case-fold — the cleanest signal.
//   2. Contents contains the placeholder as a substring — covers
//      cases where the snippet has placeholder text plus a trailing
//      paragraph break, hidden formatting marker, or instructional
//      suffix. Safe because placeholder strings (`print_headline`,
//      `nameline`, `main story`, etc.) are unique enough not to
//      appear in chrome text.
// No-op if no match (the text frame is part of the snippet chrome).
function bindPlaceholderInFrame(frame, story, framesBound) {
  let raw;
  try { raw = frame.parentStory?.contents || ''; }
  catch { return; }
  const haystack = String(raw).trim().toLowerCase();
  if (!haystack) return;

  for (const [placeholder, getter] of Object.entries(STORY_BLOCK_PLACEHOLDERS)) {
    const needle = placeholder.toLowerCase();
    if (haystack === needle || haystack.indexOf(needle) !== -1) {
      const value = getter(story);
      if (value == null || value === '') {
        console.log(`[wvnews-print] placeholder "${placeholder}" matched but story has no value`);
        return;
      }
      try {
        frame.parentStory.contents = String(value);
        framesBound.push(placeholder);
        console.log(`[wvnews-print] bound "${placeholder}" -> "${String(value).slice(0, 50)}${String(value).length > 50 ? '...' : ''}"`);
      } catch (e) {
        console.warn('[wvnews-print] could not bind', placeholder, e?.message || e);
      }
      return; // matched one, done
    }
  }
}

// Find the largest rectangle by area among placed items — used to
// identify the photo well in a Story Block. TextFrames are a separate
// class so they're excluded; we want plain image-holder rectangles.
// `classOf` is passed in because UXP doesn't expose constructor.name
// reliably; the caller derives it from `item.toString()`.
function findLargestRectangle(items, classOf) {
  let best = null;
  let bestArea = 0;
  for (const item of items) {
    try {
      const tag = (classOf ? classOf(item) : (item.constructor?.name || ''));
      if (tag !== 'Rectangle' && tag !== 'Oval') continue;
      const gb = item.geometricBounds; // [top, left, bottom, right]
      if (!gb || gb.length < 4) continue;
      const area = Math.max(0, (gb[2] - gb[0])) * Math.max(0, (gb[3] - gb[1]));
      if (area > bestArea) { best = item; bestArea = area; }
    } catch { /* skip */ }
  }
  return best;
}

function applyTextWrap(frame, offsetPt = 6) {
  if (!frame) return;
  try {
    const wrap = frame.textWrapPreferences;
    const idMod = host();
    wrap.textWrapMode = idMod.TextWrapModes.BOUNDING_BOX_TEXT_WRAP;
    // textWrapOffset is interpreted in the document's RULER UNITS, not
    // points — so force points around the assignment, otherwise e.g. 4.5
    // becomes 4.5 inches when the doc is in inches. Save/restore units.
    let vp = null, sH = null, sV = null;
    try {
      vp = activeDocument().viewPreferences;
      sH = vp.horizontalMeasurementUnits; sV = vp.verticalMeasurementUnits;
      vp.horizontalMeasurementUnits = idMod.MeasurementUnits.POINTS;
      vp.verticalMeasurementUnits = idMod.MeasurementUnits.POINTS;
    } catch { vp = null; }
    // The textWrapOffset property accepts either an array of 4 values
    // [top, left, bottom, right] or a single number applied to all
    // sides. Some UXP InDesign builds silently reject the array form,
    // so try array first then fall back to scalar.
    try {
      wrap.textWrapOffset = [offsetPt, offsetPt, offsetPt, offsetPt];
    } catch {
      try { wrap.textWrapOffset = offsetPt; } catch { /* give up */ }
    }
    if (vp) { try { vp.horizontalMeasurementUnits = sH; vp.verticalMeasurementUnits = sV; } catch { /* ignore */ } }
    const lbl = (() => { try { return frame.label || frame.constructor?.name || '?'; } catch { return '?'; } })();
    console.log('[wvnews-print] text wrap applied:', lbl);
  } catch (e) {
    console.warn('[wvnews-print] could not set text wrap:', e);
  }
}

// Normalize a byline string into multi-paragraph form, splitting on
// commas. Convention from the Exponent stylesheet: "By Jamie Reed,
// Staff Reporter" → paragraph 0 "By Jamie Reed" (BY1 Byline 1),
// paragraph 1 "Staff Reporter" (BY2 Byline 2). Also collapses any
// existing newlines into the same paragraph break style.
function splitBylineByCommas(byline) {
  if (!byline) return '';
  return String(byline)
    .split(/[,\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .join('\r');
}

function valueForBind(story, bindKey) {
  switch (bindKey) {
    case 'headline':  return story.headline;
    case 'deck':      return story.deck;
    case 'byline':    return story.byline;
    case 'dateline':  return story.dateline;
    case 'kicker':    return story.kicker;
    case 'pullquote': return story.pullquote;
    case 'body':      return story.bodyText || story.bodyHtml || '';
    case 'caption':   return story.photo?.caption || '';
    case 'caption2':  return story.photo2?.caption || '';
    case 'caption3':  return story.photo3?.caption || '';
    case 'credit':    return story.photo?.credit || '';
    case 'section':   return story.printSection;
    case 'photo':
    case 'photo2':
    case 'photo3':
      return bindKey;
    default:
      return story[bindKey] || '';
  }
}

// ── Build Pages — the publication-creation feature's plugin half ────
//
// Given an edition plan (from /api/print/editions/[id]), create one
// InDesign document per page: open the pub's master template (so page
// geometry is right), place the page's assigned snippet (if any), stamp
// the folio, and save as `<folio>.indd` in the edition's build folder.
//
// Placement reuses the no-doScript + poll pattern proven out in
// placeAndBindStoryBlock — wrapping doc.place() in doScript holds the
// main thread and deadlocks the async place pipeline. We don't bind any
// story content here; the snippet is placed as designed (chrome).

// Fetch the publication's uploaded .indt template via the platform
// API, write it to UXP's temp folder, and return the file entry. The
// caller passes this to app.open() to spawn a fresh untitled doc per
// page. Returns null if the pub has no template uploaded — the caller
// then falls back to a blank document.
// Day-of-week → template variant. Mirrors variantForDay() in
// lib/print-publication-templates.js: the weekend product runs Sat/Sun.
function variantForEdition(edition) {
  const day = String(edition?.dayOfWeek || '').toLowerCase();
  return (day === 'saturday' || day === 'sunday') ? 'weekend' : 'weekday';
}

async function resolveTemplateEntry(edition) {
  const siteId = edition.siteId || '';
  if (!siteId) return null;
  const variant = variantForEdition(edition);
  let meta;
  try { meta = await getPublicationTemplate(siteId, variant); }
  catch (e) {
    console.warn('[wvnews-print] template lookup failed:', e?.message || e);
    return null;
  }
  if (!meta || !meta.filename) return null;
  let buf;
  try { buf = await downloadPublicationTemplateBinary(meta); }
  catch (e) {
    console.warn('[wvnews-print] template download failed:', e?.message || e);
    return null;
  }
  // Include the resolved variant in the temp name so a weekday + weekend
  // build in the same session don't clobber each other's cached file.
  const tempName = `_template_${siteId}_${meta.variant || variant}_${meta.filename}`;
  const tempPath = await writeTemp(tempName, buf);
  // writeTemp returned a native path; re-resolve the entry so app.open
  // can take either form (some UXP builds prefer entry, others path).
  const lfs = require('uxp').storage.localFileSystem;
  try {
    const entry = await lfs.getEntryWithUrl(`file://${tempPath}`);
    return entry || null;
  } catch {
    // Synthesize a minimal entry-like object that exposes nativePath —
    // openBuildDoc falls back to passing nativePath if the entry path
    // fails.
    return { nativePath: tempPath, isFile: true, isFolder: false };
  }
}

// Apply the right master spread to page 1 of a build doc based on the
// folio. Section openers (A1, B1, C1, …) get the A-Front Page master;
// every other page gets B-Inside Pages (which has the folio baked in).
// Best-effort: if the template doesn't carry these masters we leave
// the default and warn.
const OPENER_MASTER_NAME = 'A-Front Page';
const INSIDE_MASTER_NAME = 'B-Inside Pages';

function masterNameForFolio(folio, snippet) {
  // Snippet-level override wins when set: editors can declare a snippet's
  // page wants opener/inside regardless of its position. Useful for
  // mid-edition section openers (e.g. Opinion lands on A3 but still
  // needs the no-folio A-Master so its own section header doesn't
  // collide with a baked-in folio).
  const role = snippet && snippet.pageRole;
  if (role === 'opener') return OPENER_MASTER_NAME;
  if (role === 'inside') return INSIDE_MASTER_NAME;
  const m = String(folio || '').match(/^[A-Z]+([0-9]+)$/);
  if (!m) return INSIDE_MASTER_NAME;
  return parseInt(m[1], 10) === 1 ? OPENER_MASTER_NAME : INSIDE_MASTER_NAME;
}

function applyMasterByFolio(doc, folio, snippet) {
  const wanted = masterNameForFolio(folio, snippet);
  // Strip the leading "<prefix>-" from the target so we can match by
  // baseName too — InDesign's master spread name is `<prefix>-<baseName>`
  // (e.g. "A-Front Page"), so the baseName of "A-Front Page" is just
  // "Front Page".
  const wantedBase = wanted.replace(/^[A-Za-z]-/, '');
  let chosen = null;
  try {
    const ms = doc.masterSpreads;
    const count = (ms.length !== undefined) ? ms.length : (ms.count ? ms.count() : 0);
    const names = [];
    for (let i = 0; i < count; i++) {
      const m = ms.item ? ms.item(i) : ms[i];
      let name = '', baseName = '', prefix = '';
      try { name = m.name || ''; } catch {}
      try { baseName = m.baseName || ''; } catch {}
      try { prefix = m.namePrefix || ''; } catch {}
      names.push(`${name} (prefix=${prefix}, base=${baseName})`);
      // Match in order of specificity: exact full name, then baseName
      // ("Front Page"), then prefix ("A" → A-master, "B" → B-master).
      if (
        name === wanted ||
        baseName === wanted ||
        baseName === wantedBase ||
        (wanted === OPENER_MASTER_NAME && prefix === 'A') ||
        (wanted === INSIDE_MASTER_NAME && prefix === 'B')
      ) {
        chosen = m;
        break;
      }
    }
    if (!chosen) {
      console.warn(`[wvnews-print] master "${wanted}" not found in template. Available masters: ${names.join(' | ')}`);
      return false;
    }
    const page = doc.pages.item(0);
    let priorName = '';
    try { priorName = (page.appliedMaster && page.appliedMaster.name) || '(none)'; } catch { priorName = '(unknown)'; }
    page.appliedMaster = chosen;
    let finalName = '';
    try { finalName = (page.appliedMaster && page.appliedMaster.name) || '(none)'; } catch { finalName = '(unknown)'; }
    console.log(`[wvnews-print] folio ${folio}: master ${priorName} → ${finalName} (wanted ${wanted})`);
    return true;
  } catch (e) {
    console.warn('[wvnews-print] applyMaster failed:', e?.message || e);
    return false;
  }
}

// Open a fresh build document. Opening an .indt yields a new untitled
// doc with the template's geometry. InDesign UXP's app.open() accepts a
// UXP entry on some builds and a native-path string on others, so try
// both before falling back to a blank document.
async function openBuildDoc(templateEntry) {
  const id = host();
  if (templateEntry) {
    try { return await id.app.open(templateEntry); }
    catch (e1) {
      try { return await id.app.open(templateEntry.nativePath); }
      catch (e2) {
        console.warn('[wvnews-print] template open failed, using blank doc:', e2?.message || e1?.message);
      }
    }
  }
  return id.app.documents.add();
}

// Stamp document-level text variables that masters (and snippets) can
// reference to render per-page chrome. We create:
//
//   folio       → "A1", "B12", etc. — current page number
//   dateline    → "Thursday, June 4, 2026" — long-form edition date
//   editionDay  → "Thursday"
//   editionDate → "June 4, 2026"
//
// Designers drop these into the master via Type → Text Variables → Insert
// Variable. Best-effort: never blocks the build if any one variable
// can't be created.
function stampFolio(doc, folio, edition) {
  const id = host();
  const set = (name, value) => {
    try {
      let tv = null;
      try { const t = doc.textVariables.itemByName(name); if (t && t.isValid) tv = t; } catch {}
      if (!tv) {
        tv = doc.textVariables.add();
        tv.name = name;
      }
      // Force custom-text type so our string renders even if the TCMS/Blox
      // template defined this variable as a date (or other) type — in which
      // case setting variableOptions.contents would otherwise no-op.
      try {
        if (tv.variableType !== id.VariableTypes.CUSTOM_TEXT_TYPE) {
          tv.variableType = id.VariableTypes.CUSTOM_TEXT_TYPE;
        }
      } catch {}
      try { tv.variableOptions.contents = String(value); } catch {}
    } catch (e) {
      console.warn(`[wvnews-print] text variable "${name}" failed:`, e?.message || e);
    }
  };
  // Legacy alias bridge. The TownNews/TCMS-era WV News templates
  // (e.g. ET Telegram2026.indt / Sunday2026.indt) reference their own
  // text-variable names on the master pages instead of the canonical
  // four. Set those aliases to the same values so a pre-existing master
  // frame renders live chrome without re-authoring the template. These
  // are no-ops on modern templates: set() only creates the variable, and
  // an unreferenced variable has no visible effect.
  //
  //   folio    → "ztmp folio away from spine" / "...towards spine"
  //   dateline → "DatelineLeft" / "DatelineRight"
  //
  // ("PublishedDaily" also exists in the legacy templates but its
  // semantics are ambiguous — confirm in InDesign before aliasing it.)
  const FOLIO_ALIASES = ['ztmp folio away from spine', 'ztmp folio towards spine'];
  const DATELINE_ALIASES = ['DatelineLeft', 'DatelineRight'];

  set('folio', folio);
  FOLIO_ALIASES.forEach(n => set(n, folio));
  if (edition && edition.editionDate) {
    // editionDate is ISO 'YYYY-MM-DD' — render in UTC so the calendar
    // day matches the planned edition regardless of local timezone.
    const d = new Date(`${edition.editionDate}T00:00:00Z`);
    if (!isNaN(d.getTime())) {
      const day = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      const longDate = `${day}, ${date}`;
      set('dateline', longDate);
      set('editionDay', day);
      set('editionDate', date);
      DATELINE_ALIASES.forEach(n => set(n, longDate));
    } else {
      set('dateline', edition.editionDate);
      set('editionDate', edition.editionDate);
      DATELINE_ALIASES.forEach(n => set(n, edition.editionDate));
    }
  }
  // TCMS/Blox masters print the page number with InDesign's auto page-
  // number marker, which renders "1" in our single-page build docs. Set
  // the page's section so the marker shows the real folio: section start =
  // the numeric part (A3 → 3), section prefix/marker = the letter (A3 → A).
  try {
    const fm = String(folio).match(/^([A-Za-z]*)(\d+)$/);
    if (fm) {
      let sec = null;
      try { sec = doc.pages.item(0).appliedSection; } catch {}
      if (!sec) { try { sec = doc.sections.item(0); } catch {} }
      if (sec && sec.isValid) {
        try { sec.continueNumbering = false; } catch {}
        try { sec.pageNumberStart = parseInt(fm[2], 10); } catch {}
        // The master shows letter (section marker) + number (page-number
        // marker) separately, so DON'T also prefix the page number — that
        // doubled the letter (AA8). Section marker carries the letter.
        try { sec.includeSectionPrefix = false; } catch {}
        try { sec.marker = fm[1]; } catch {}
      }
    }
  } catch (e) { console.warn('[wvnews-print] folio section set failed:', e?.message || e); }

  try { doc.insertLabel('wvnews-folio', String(folio)); } catch {}
  if (edition && edition.editionDate) {
    try { doc.insertLabel('wvnews-edition-date', String(edition.editionDate)); } catch {}
  }

  // The template has NO date text variable (only InDesign's built-in
  // XRef vars), so the dateline is LITERAL text styled with a "Dateline*"
  // paragraph style. Find pure-dateline frames on the masters + page and
  // replace their text with the edition date.
  if (edition && edition.editionDate) {
    const d2 = new Date(`${edition.editionDate}T00:00:00Z`);
    const longDate = !isNaN(d2.getTime())
      ? `${d2.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}, ${d2.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
      : edition.editionDate;
    const isDateStyle = (nm) => /dateline|todaysdate/i.test(nm || '');
    const containers = [];
    try { for (let i = 0; i < doc.masterSpreads.length; i++) containers.push(doc.masterSpreads.item(i)); } catch {}
    try { for (let i = 0; i < doc.pages.length; i++) containers.push(doc.pages.item(i)); } catch {}
    let replaced = 0;
    const seen = {};
    for (const c of containers) {
      let items; try { items = c.allPageItems; } catch { continue; }
      const len = (items && typeof items.length === 'number') ? items.length : 0;
      for (let i = 0; i < len; i++) {
        const it = items[i];
        try {
          const story = it.parentStory;
          if (!story) continue;
          const paras = story.paragraphs;
          const np = paras.length;
          if (!np) continue;
          let allDate = true;
          for (let p = 0; p < np; p++) {
            let sn = '';
            try { sn = paras.item(p).appliedParagraphStyle.name; } catch {}
            seen[sn] = (seen[sn] || 0) + 1;
            if (!isDateStyle(sn)) allDate = false;
          }
          if (allDate) { try { story.contents = longDate; replaced++; } catch {} }
        } catch {}
      }
    }
    console.log(`[wvnews-print] DATELINE-FIX ${folio}: replaced ${replaced} frame(s) -> "${longDate}"  | para-styles seen: ${Object.keys(seen).join(', ')}`);
  }
}

// Place a snippet (.idms at tempPath) into the active document, then
// re-center the placed group on the page. UXP InDesign's
// `doc.place(file, false, { destination })` form silently loads the
// place cursor on some builds rather than dropping the snippet — so we
// try the place-point variant first (which forces auto-placement at a
// fixed coordinate) and only fall back to the destination-object form.
// After items land, we measure their combined bounding box and shift
// every new item by a single delta so the group's center matches the
// page's center.
// Convert a placement value to inches. Falls back to assuming inches
// if the unit isn't recognized — newspaper templates are inches-native.
const PLACEMENT_TO_INCHES = { in: 1, pt: 1 / 72, mm: 1 / 25.4, pc: 1 / 6 };

async function placeSnippetIntoActiveDoc(doc, tempPath, snippet) {
  const id = host();
  const page = doc.pages.item(0);
  const spread = (() => { try { return page.parent; } catch { return null; } })();

  // Snapshot existing item IDs across page + spread so we can pick out
  // the newly-placed items by id-diff after the place call lands.
  const snapshotIds = () => {
    const ids = new Set();
    for (const container of [page, spread]) {
      if (!container) continue;
      try {
        const items = container.allPageItems;
        const len = (items && typeof items.length === 'number') ? items.length : 0;
        for (let i = 0; i < len; i++) {
          try { ids.add(items[i].id); } catch {}
        }
      } catch {}
    }
    return ids;
  };
  const baselineIds = snapshotIds();
  const countNew = () => {
    const ids = snapshotIds();
    let n = 0;
    for (const x of ids) if (!baselineIds.has(x)) n++;
    return n;
  };

  const pollLanded = async (ms = 2000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (countNew() > 0) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  };
  const abortLoadedGun = () => {
    try {
      const w = id.app.activeWindow;
      if (w && w.placeGun && w.placeGun.loaded) w.placeGun.abortPlaceGun();
    } catch {}
    try { if (id.app.placeGun && id.app.placeGun.loaded) id.app.placeGun.abortPlaceGun(); } catch {}
  };

  // Force "Page Snippet" placement semantics — same effect as
  // checking InDesign → Preferences → File Handling → Snippet Import
  // → "Position at original location" (which Blox's plugin relied on).
  // With SnippetPosition.ORIGINAL_LOCATION the place point is IGNORED
  // and the snippet's encoded absolute coordinates win, so a snippet
  // authored at e.g. (0.25, 6.25) on an ET A1 lands at (0.25, 6.25) on
  // every build — no per-snippet placement metadata required.
  //
  // We set this just before the place() call and restore it after so
  // the plugin doesn't permanently change a designer's working
  // preference. Falls back to passing the page's margin as the place
  // point if the enum isn't reachable (older UXP versions).
  let restoreSnippetPosition = null;
  let originalLocationOK = false;
  try {
    const prefs = id.app.snippetImportPreferences;
    const SP = id.SnippetPosition;
    if (prefs && SP && SP.ORIGINAL_LOCATION) {
      restoreSnippetPosition = prefs.snippetPosition;
      prefs.snippetPosition = SP.ORIGINAL_LOCATION;
      originalLocationOK = true;
      console.log('[wvnews-print] snippet placement: ORIGINAL_LOCATION (page-snippet mode)');
    }
  } catch (e) {
    console.warn('[wvnews-print] could not set snippetPosition; will fall back to margin-place-point:', e?.message || e);
  }

  // Margin-place-point fallback for when the snippetPosition pref
  // couldn't be set. Same logic as before — snippet's bbox top-left
  // lands at the page margin instead of the page edge.
  const marginPoint = originalLocationOK ? null : (() => {
    try {
      const vp = doc.viewPreferences;
      const oH = vp.horizontalMeasurementUnits, oV = vp.verticalMeasurementUnits;
      vp.horizontalMeasurementUnits = id.MeasurementUnits.INCHES;
      vp.verticalMeasurementUnits   = id.MeasurementUnits.INCHES;
      const mp = page.marginPreferences;
      const point = [mp.left, mp.top];
      vp.horizontalMeasurementUnits = oH;
      vp.verticalMeasurementUnits   = oV;
      console.log(`[wvnews-print] using fallback place point at margin: [${point[0]}, ${point[1]}] in`);
      return point;
    } catch (e) {
      console.warn('[wvnews-print] could not read margins; falling back to no-point place:', e?.message || e);
      return null;
    }
  })();

  const attempts = [
    // page.place() proved reliable in the current UXP InDesign build;
    // try it first. doc.place(...) variants stay as fallbacks for older
    // UXP versions where page.place is unavailable. In page-snippet
    // mode no place point is needed — the snippet's encoded coords win.
    () => {
      if (typeof page.place !== 'function') throw new Error('page.place unavailable');
      if (originalLocationOK) return page.place(tempPath);
      return marginPoint ? page.place(tempPath, marginPoint) : page.place(tempPath);
    },
    () => doc.place(tempPath, true, { destination: page }),
    () => doc.place(tempPath, false),
  ];

  let landed = false;
  let lastErr;
  try {
    for (let i = 0; i < attempts.length; i++) {
      try {
        attempts[i]();
        if (await pollLanded(1500)) {
          console.log(`[wvnews-print] placed snippet via attempt ${i + 1}`);
          landed = true;
          break;
        }
        console.warn(`[wvnews-print] attempt ${i + 1} did not land items, aborting place gun`);
        abortLoadedGun();
      } catch (e) {
        lastErr = e;
        console.warn(`[wvnews-print] attempt ${i + 1} threw:`, e?.message || e);
      }
    }
  } finally {
    // Restore the designer's original snippetPosition preference so
    // the plugin doesn't permanently change their working environment.
    // No-op if we never set it (originalLocationOK == false).
    if (originalLocationOK && restoreSnippetPosition != null) {
      try {
        id.app.snippetImportPreferences.snippetPosition = restoreSnippetPosition;
      } catch (e) {
        console.warn('[wvnews-print] could not restore snippetPosition:', e?.message || e);
      }
    }
  }
  if (!landed) {
    console.error('[wvnews-print] doc.place failed all attempts:', lastErr?.message || lastErr);
    return false;
  }

  // Position the newly-placed items per the snippet's `placement`
  // metadata, if set. Collect new items via id-diff, compute their
  // combined top-left, and shift everything by a single delta so the
  // group's top-left lands at the target coordinate. If no placement
  // is configured, leave the items where the placePoint dropped them.
  const placement = snippet && snippet.placement;
  console.log(`[wvnews-print] placement-meta:`, JSON.stringify(placement || null), 'snippet=', snippet?.name || '(unnamed)');

  // Diagnostic v5 (2026-06-12): always log where the snippet's items
  // actually landed on the page after `page.place(tempPath)` — even when
  // no placement shift is configured. Tells us whether the offset is at
  // the place step (snippet's IDMS coords don't match page) or at the
  // shift step (placement target wrong).
  try {
    const vp2 = doc.viewPreferences;
    const oH = vp2.horizontalMeasurementUnits, oV = vp2.verticalMeasurementUnits;
    try {
      vp2.horizontalMeasurementUnits = id.MeasurementUnits.INCHES;
      vp2.verticalMeasurementUnits   = id.MeasurementUnits.INCHES;
    } catch {}
    const pb2 = page.bounds;  // [py1, px1, py2, px2]
    const newIds2 = new Set();
    for (const c of [page, spread]) {
      if (!c) continue;
      let it2; try { it2 = c.allPageItems; } catch { continue; }
      const ln2 = it2?.length || 0;
      for (let i = 0; i < ln2; i++) {
        try { const id2 = it2[i].id; if (!baselineIds.has(id2)) newIds2.add(id2); } catch {}
      }
    }
    let minX2 = Infinity, minY2 = Infinity, maxX2 = -Infinity, maxY2 = -Infinity, n = 0;
    for (const c of [page, spread]) {
      if (!c) continue;
      let it2; try { it2 = c.allPageItems; } catch { continue; }
      const ln2 = it2?.length || 0;
      for (let i = 0; i < ln2; i++) {
        try {
          const item = it2[i];
          if (!newIds2.has(item.id)) continue;
          const gb = item.geometricBounds; // [y1,x1,y2,x2]
          if (gb[1] < minX2) minX2 = gb[1];
          if (gb[0] < minY2) minY2 = gb[0];
          if (gb[3] > maxX2) maxX2 = gb[3];
          if (gb[2] > maxY2) maxY2 = gb[2];
          n++;
        } catch {}
      }
    }
    console.log(`[wvnews-print] DIAG-v5 post-place(${snippet?.name || '?'}): page=[${pb2[1].toFixed(2)},${pb2[0].toFixed(2)} → ${pb2[3].toFixed(2)},${pb2[2].toFixed(2)}] | snippet-bbox=[${minX2.toFixed(2)},${minY2.toFixed(2)} → ${maxX2.toFixed(2)},${maxY2.toFixed(2)}] over ${n} items`);
    try { vp2.horizontalMeasurementUnits = oH; vp2.verticalMeasurementUnits = oV; } catch {}
  } catch (e) {
    console.warn('[wvnews-print] DIAG-v5 failed:', e?.message || e);
  }

  if (!placement) return true;

  try {
    // Walk allPageItems (recursive) to find ALL new items, then keep
    // only those whose parent is the page or spread (top-level). This
    // catches snippet content regardless of where it lands, but only
    // shifts the outermost items — children move with their parents,
    // so we don't double-displace nested content.
    const allNewIds = new Set();
    const allNewItems = [];
    for (const container of [page, spread]) {
      if (!container) continue;
      let items;
      try { items = container.allPageItems; } catch { continue; }
      const len = (items && typeof items.length === 'number') ? items.length : 0;
      for (let i = 0; i < len; i++) {
        const it = items[i];
        let itemId;
        try { itemId = it.id; } catch { continue; }
        if (baselineIds.has(itemId)) continue;
        if (allNewIds.has(itemId)) continue;
        allNewIds.add(itemId);
        allNewItems.push(it);
      }
    }
    // Filter to top-level: parent must be the page, the spread, or
    // not itself a new item (so we don't shift children of new groups).
    const newItems = allNewItems.filter(it => {
      try {
        const p = it.parent;
        if (!p) return true;
        let pid;
        try { pid = p.id; } catch { return true; }
        return !allNewIds.has(pid);
      } catch { return true; }
    });
    console.log(`[wvnews-print] new items: ${allNewItems.length} total, ${newItems.length} top-level`);
    if (!newItems.length) return true;

    // Force document units to inches so geometricBounds math is
    // predictable regardless of how the template was authored. Restore
    // after we're done.
    const vp = doc.viewPreferences;
    const oldH = vp.horizontalMeasurementUnits;
    const oldV = vp.verticalMeasurementUnits;
    let unitsForced = false;
    try {
      vp.horizontalMeasurementUnits = id.MeasurementUnits.INCHES;
      vp.verticalMeasurementUnits = id.MeasurementUnits.INCHES;
      unitsForced = true;
    } catch (e) {
      console.warn('[wvnews-print] could not force inches; positioning may drift:', e?.message || e);
    }
    console.log(`[wvnews-print] units forced=${unitsForced} oldH=${oldH} oldV=${oldV}`);

    // Page bounds in inches (must re-read after switching units; the
    // earlier `b` was captured in the document's original units).
    const pb = page.bounds; // [py1, px1, py2, px2] in inches now
    const pageX = pb[1];
    const pageY = pb[0];
    const pageW = pb[3] - pb[1];
    const pageH = pb[2] - pb[0];
    console.log(`[wvnews-print] page-bounds (in): topY=${pageY.toFixed(3)} leftX=${pageX.toFixed(3)} W=${pageW.toFixed(3)} H=${pageH.toFixed(3)} newItems=${newItems.length}`);

    // Bounding box across new items. Exclude items entirely outside
    // the page area — .idms snippets can carry pasteboard markers or
    // off-page guide items that would skew minX/minY.
    let minY = Infinity, minX = Infinity;
    const considered = [];
    for (const it of newItems) {
      try {
        const gb = it.geometricBounds; // [y1, x1, y2, x2] in inches
        const offPage =
          gb[3] < pageX - 0.5 || gb[1] > pageX + pageW + 0.5 ||
          gb[2] < pageY - 0.5 || gb[0] > pageY + pageH + 0.5;
        if (offPage) continue;
        considered.push(it);
        if (gb[0] < minY) minY = gb[0];
        if (gb[1] < minX) minX = gb[1];
      } catch {}
    }
    if (!isFinite(minX) || !isFinite(minY) || considered.length === 0) {
      // Nothing on-page — fall back to shifting all new items
      // (probably the snippet placed entirely off-page).
      considered.length = 0;
      minX = Infinity; minY = Infinity;
      for (const it of newItems) {
        try {
          const gb = it.geometricBounds;
          considered.push(it);
          if (gb[0] < minY) minY = gb[0];
          if (gb[1] < minX) minX = gb[1];
        } catch {}
      }
      if (!isFinite(minX) || !isFinite(minY)) {
        try { vp.horizontalMeasurementUnits = oldH; vp.verticalMeasurementUnits = oldV; } catch {}
        return true;
      }
    }

    const u = placement.units || 'in';
    const toIn = PLACEMENT_TO_INCHES[u] != null ? PLACEMENT_TO_INCHES[u] : 1;
    // Target is ABSOLUTE ruler/document coordinates (the X/Y a designer
    // reads in the Transform panel). For a normal page the ruler zero is
    // the page top-left, so this equals page-relative; it only differs
    // when the page has a bleed/offset origin (e.g. ET's -0.25 bleed),
    // where the designer's intent is the ruler coordinate, not page+offset.
    const targetX = placement.x * toIn;
    const targetY = placement.y * toIn;
    const dx = targetX - minX;
    const dy = targetY - minY;

    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
      try { vp.horizontalMeasurementUnits = oldH; vp.verticalMeasurementUnits = oldV; } catch {}
      return true;
    }

    // Translate each top-level item by (dx, dy) using move() rather
    // than geometricBounds. Setting bounds moves the frame but lets
    // placed images "fit" into the new frame — graphics retain their
    // pasteboard coords, so they appear to slip inside their boxes.
    // move() translates the frame + its placed content as a unit.
    for (const it of newItems) {
      try {
        const gb = it.geometricBounds;
        const target = [gb[1] + dx, gb[0] + dy]; // [x, y] new top-left
        let moved = false;
        try { it.move(target); moved = true; } catch {}
        if (!moved) { try { it.move(undefined, [dx, dy]); moved = true; } catch {} }
        if (!moved) {
          // Last resort: bounds set (text-only frames still translate
          // correctly this way).
          it.geometricBounds = [gb[0] + dy, gb[1] + dx, gb[2] + dy, gb[3] + dx];
        }
      } catch {
        // Read-only / un-movable item — skip; the rest of the snippet
        // still translates.
      }
    }
    console.log(`[wvnews-print] placement: top-left ${minX.toFixed(3)},${minY.toFixed(3)} → ${targetX.toFixed(3)},${targetY.toFixed(3)} (dx=${dx.toFixed(3)} dy=${dy.toFixed(3)})`);
    try { vp.horizontalMeasurementUnits = oldH; vp.verticalMeasurementUnits = oldV; } catch {}
  } catch (e) {
    console.warn('[wvnews-print] placement failed:', e?.message || e);
  }
  return true;
}

// ── Content-asset placement ──────────────────────────────────────
//
// During Build Pages, after the snippet is on the page, each assigned
// content asset (story/order/classified) is fetched and flowed into
// matching frames. "Matching" means a frame's Script Label (preferred)
// or Name equals the canonical field key for that kind. Designers set
// labels in the Script Label panel:
//
//   Story → headline, deck, byline, dateline, kicker, body, photo,
//           caption, credit
//   Order → ad           (single image frame the ad PDF is placed into)
//   Classified → classified-body  (text frame the liner-ad text flows into)
//
// Missing frames are logged + skipped — the build still saves the
// page so the operator can finish manually.

function frameByLabelOrName(container, name) {
  if (!container || !name) return null;
  let items;
  try { items = container.allPageItems; } catch { return null; }
  const len = (items && typeof items.length === 'number') ? items.length : 0;
  for (let i = 0; i < len; i++) {
    const it = items[i];
    try { if (it.label && it.label === name) return it; } catch {}
  }
  for (let i = 0; i < len; i++) {
    const it = items[i];
    try { if (it.name && it.name === name) return it; } catch {}
  }
  return null;
}

function setFrameText(frame, value) {
  if (!frame || value == null) return false;
  try {
    if (frame.parentStory) {
      // Text frame — set its story contents (preserves applied styles).
      frame.parentStory.contents = String(value);
      return true;
    }
    if ('contents' in frame) {
      frame.contents = String(value);
      return true;
    }
  } catch (e) {
    console.warn('[wvnews-print] setFrameText failed:', e?.message || e);
  }
  return false;
}

// Place a remote URL into a graphic frame. Downloads the bytes to UXP
// temp first, then calls frame.place(tempPath) — UXP InDesign's
// PageItem.place() takes a file path string and works for rectangles
// as a "place into this frame" operation.
// Extensions we'll actually write to the UXP temp folder for a frame
// place. Anything outside this list is coerced to `.bin` so a backend
// bug serving a `photo.url = ".../foo.exe?token=..."` can't leave an
// executable file behind on the artist's disk. The list mirrors the
// formats InDesign's `frame.place()` accepts for image/PDF fills.
const PLACE_URL_EXT_ALLOWLIST = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp',
  'svg', 'eps', 'ai', 'pdf', 'psd', 'webp', 'heic', 'heif',
]);

async function placeUrlIntoFrame(frame, url, namePrefix) {
  if (!frame || !url) return false;
  try {
    const buf = await fetchBinary(url);
    const ext = (() => {
      const m = String(url).match(/\.([a-zA-Z0-9]{2,5})(\?|$)/);
      const raw = m ? m[1].toLowerCase() : '';
      return PLACE_URL_EXT_ALLOWLIST.has(raw) ? raw : 'bin';
    })();
    const tempPath = await writeTemp(`${namePrefix}.${ext}`, buf);
    if (typeof frame.place === 'function') {
      frame.place(tempPath);
      return true;
    }
  } catch (e) {
    console.warn('[wvnews-print] placeUrlIntoFrame failed:', e?.message || e);
  }
  return false;
}

// A frame is a "story box" if its Script Label is `story-<N>` (the WV
// News convention, e.g. story-1, story-2 — seen in the production ET
// snippets) or the generic `storyFrame`. The label IS the frameKey.
const STORY_FRAME_RE = /^story-?\d+$/i;   // accepts story-1 OR story1
function isStoryFrameLabel(label) {
  return label === 'storyFrame' || STORY_FRAME_RE.test(label || '');
}
function storyFrameOrder(label) {
  const m = String(label || '').match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Read a frame's story-box key (e.g. "story-2") from wherever the Script
// Label lives. Production ET .idms store it as an explicit Key="Label"
// custom label (read via extractLabel('Label')); generator-built frames
// set it via item.label; we also accept a story-N frame Name. Returns ''
// if the frame isn't a story box.
function storyFrameKeyOf(it) {
  const tryVals = [];
  try { tryVals.push(it.label); } catch {}
  try { tryVals.push(it.extractLabel('Label')); } catch {}
  try { tryVals.push(it.name); } catch {}
  for (const v of tryVals) {
    if (isStoryFrameLabel(v)) {
      // Normalize to canonical `story-N` (so "story1" and "story-1" match
      // an asset's frameKey of "story-1").
      const m = String(v).match(/(\d+)$/);
      return m ? 'story-' + parseInt(m[1], 10) : String(v);
    }
  }
  return '';
}

// Collect every story box on the page + spread as { frame, key, id },
// deduped, sorted by the key's trailing number (story-1 before story-2).
// Used to auto-distribute a page's assigned stories across its boxes.
function collectStoryFrames(containers) {
  const out = [];
  const seen = new Set();
  let scanned = 0;
  for (const c of containers) {
    if (!c) continue;
    let items;
    try { items = c.allPageItems; } catch { continue; }
    const len = (items && typeof items.length === 'number') ? items.length : 0;
    for (let i = 0; i < len; i++) {
      const it = items[i];
      scanned++;
      // ── DIAG: show what the plugin sees for each text frame ──
      try {
        let hasStory = false, lab = '', xlab = '', nm = '';
        try { hasStory = !!it.parentStory; } catch {}
        try { lab = it.label || ''; } catch {}
        try { xlab = it.extractLabel('Label') || ''; } catch {}
        try { nm = it.name || ''; } catch {}
        if (hasStory) console.log(`[wvnews-print] SBDIAG story=${hasStory} label=${JSON.stringify(lab)} xLabel=${JSON.stringify(xlab)} name=${JSON.stringify(nm)} -> key=${JSON.stringify(storyFrameKeyOf(it))}`);
      } catch {}
      try {
        if (!it.parentStory) continue;
        let itemId;
        try { itemId = it.id; } catch { continue; }
        if (seen.has(itemId)) continue;
        const key = storyFrameKeyOf(it);
        if (!key) continue;
        seen.add(itemId);
        out.push({ frame: it, key, id: itemId });
      } catch { /* skip non-text / legacy items */ }
    }
  }
  out.sort((a, b) => storyFrameOrder(a.key) - storyFrameOrder(b.key));
  console.log(`[wvnews-print] collectStoryFrames: scanned=${scanned} storyBoxes=${out.length} keys=[${out.map(b => b.key).join(',')}]`);
  return out;
}

// ET editorial grid: column 1.6458 in, gutter 0.125 in (→ 6 cols = 10.5 in).
const ET_COL_W = 1.6458;
const ET_GUTTER = 0.125;

// Set a body frame's column count to match its width on the ET grid:
// N = round((W + gutter) / (colWidth + gutter)). e.g. a 6.9583 in frame
// → 4 columns. Forces inches to measure, sets gutter to 0.125 in.
function applyAutoColumns(doc, frame) {
  if (!frame) return 1;
  const id = host();
  const vp = doc.viewPreferences;
  let oldH, oldV, forced = false;
  try {
    oldH = vp.horizontalMeasurementUnits; oldV = vp.verticalMeasurementUnits;
    vp.horizontalMeasurementUnits = id.MeasurementUnits.INCHES;
    vp.verticalMeasurementUnits = id.MeasurementUnits.INCHES;
    forced = true;
  } catch {}
  let n = 1;
  try {
    const gb = frame.geometricBounds;            // [y1, x1, y2, x2] in inches
    const w = gb[3] - gb[1];
    n = Math.max(1, Math.round((w + ET_GUTTER) / (ET_COL_W + ET_GUTTER)));
  } catch {}
  try {
    const tfp = frame.textFramePreferences;
    try { tfp.useFixedColumnWidth = false; } catch {}
    try { tfp.textColumnGutter = ET_GUTTER + 'in'; } catch {}
    tfp.textColumnCount = n;
  } catch {}
  if (forced) { try { vp.horizontalMeasurementUnits = oldH; vp.verticalMeasurementUnits = oldV; } catch {} }
  return n;
}

// Write a byline into its own frame, splitting on commas and applying
// BY1 Byline 1 to paragraph 0, BY2 Byline 2 to every paragraph after.
// "By Jamie Reed, Staff Reporter" → "By Jamie Reed" (BY1) / "Staff
// Reporter" (BY2). Falls back to BY1 across all paragraphs if BY2 isn't
// a valid style in the doc.
function setBylineParagraphs(doc, frame, bylineRaw, styleMap) {
  if (!frame || !frame.parentStory || !bylineRaw) return false;
  const text = splitBylineByCommas(bylineRaw);
  if (!text) return false;
  const ok = setFrameText(frame, text);
  if (!ok) return false;
  const by1Name = (styleMap?.paragraph?.byline)  || 'BY1 Byline 1';
  const by2Name = (styleMap?.paragraph?.byline2) || 'BY2 Byline 2';
  try {
    const st1 = doc.paragraphStyles.itemByName(by1Name);
    const st2 = doc.paragraphStyles.itemByName(by2Name);
    const paras = frame.parentStory.paragraphs;
    for (let i = 0; i < paras.length; i++) {
      const st = (i === 0)
        ? (st1 && st1.isValid ? st1 : null)
        : (st2 && st2.isValid ? st2 : (st1 && st1.isValid ? st1 : null));
      if (st) paras.item(i).applyParagraphStyle(st, true);
    }
  } catch { /* best-effort */ }
  return true;
}

// Fill a frame's text while preserving the box's OWN (designer-chosen)
// paragraph style — capture it first, then re-apply it to every flowed
// paragraph (setting contents can otherwise reset styling).
function setFieldText(doc, frame, value) {
  if (!frame || value == null || value === '') return false;
  let styleName = '';
  try { styleName = frame.parentStory.paragraphs.item(0).appliedParagraphStyle.name; } catch {}
  const ok = setFrameText(frame, value);
  if (ok && styleName) {
    try {
      const st = doc.paragraphStyles.itemByName(styleName);
      if (st && st.isValid) {
        const ps = frame.parentStory.paragraphs;
        for (let i = 0; i < ps.length; i++) ps.item(i).applyParagraphStyle(st, true);
      }
    } catch {}
  }
  return ok;
}

// Blox-style combined cutline + credit in one box: the cutline as the
// first paragraph (IMU style), the credit as the second (IMR style).
function flowCaptionCredit(doc, frame, caption, credit, capStyle, credStyle) {
  if (!frame || !frame.parentStory) return;
  const parts = [];
  if (caption) parts.push({ text: String(caption), style: capStyle });
  if (credit)  parts.push({ text: String(credit),  style: credStyle });
  if (!parts.length) return;
  try {
    frame.parentStory.contents = '';
    frame.parentStory.contents = parts.map(p => p.text).join('\r');
    const paras = frame.parentStory.paragraphs;
    for (let i = 0; i < parts.length && i < paras.length; i++) {
      try {
        const st = doc.paragraphStyles.itemByName(parts[i].style);
        if (st && st.isValid) paras.item(i).applyParagraphStyle(st, true);
      } catch {}
    }
  } catch (e) { console.warn('[wvnews-print] caption+credit failed:', e?.message || e); }
}

// Apply a styleMap paragraph style to every paragraph of a frame's story.
function applyParaStyleByKey(doc, frame, styleKey, styleMap) {
  const name = styleMap && styleMap.paragraph && styleMap.paragraph[styleKey];
  if (!name || !frame || !frame.parentStory) return;
  try {
    const st = doc.paragraphStyles.itemByName(name);
    if (!st || !st.isValid) return;
    const paras = frame.parentStory.paragraphs;
    for (let i = 0; i < paras.length; i++) paras.item(i).applyParagraphStyle(st, true);
  } catch { /* best-effort */ }
}

// Auto-jump: if a body frame overflows, split it at a sentence boundary,
// truncate the source to what fits, append a "See SLUG, DEST" turnline
// (JTL Jump Turnline), and return the overflow text for the jump page.
// Returns '' when nothing overflows. (Mirrors captureSourceForJump.)
function captureOverflow(doc, frame, styleMap, slug, destFolio) {
  let overflows = false;
  try { overflows = frame.overflows; } catch {}
  if (!overflows) return '';
  const story = frame.parentStory;
  const fullText = story.contents;
  const totalLen = fullText.length;
  let visibleLen = totalLen;
  try {
    const lc = frame.lines.length;
    if (lc <= 0) return '';
    const lastLine = frame.lines.item(lc - 1);
    visibleLen = lastLine.characters.item(lastLine.characters.length - 1).index + 1;
  } catch { try { visibleLen = frame.characters.length; } catch { return ''; } }
  if (visibleLen >= totalLen || visibleLen < 0) return '';
  let splitAt = visibleLen, i = visibleLen - 1;
  while (i > 0) {
    const ch = fullText.charAt(i);
    if (ch === '\r') { splitAt = i + 1; break; }
    if (ch === '.' || ch === '!' || ch === '?') {
      const nx = fullText.charAt(i + 1);
      if (nx === ' ' || nx === '\r' || nx === '\n' || nx === '\t' || i + 1 >= visibleLen) { splitAt = i + 1; break; }
    }
    i--;
  }
  if (i <= 0) splitAt = visibleLen;
  const overflowText = fullText.slice(splitAt).replace(/^[\s\r]+/, '');
  if (splitAt < totalLen) {
    try { story.characters.itemByRange(splitAt, totalLen - 1).remove(); }
    catch { try { story.contents = fullText.slice(0, splitAt); } catch {} }
  }
  try {
    const tl = story.contents.length, tt = story.contents.replace(/[\s\r]+$/, '').length;
    if (tl > tt) story.characters.itemByRange(tt, tl - 1).remove();
  } catch {}
  try {
    const safeSlug = String(slug || 'CONTINUED').trim().toUpperCase().replace(/[^A-Z0-9 -]/g, '') || 'CONTINUED';
    story.insertionPoints.lastItem().contents = '\r' + `See ${safeSlug}, ${destFolio}`;
    const stName = (styleMap && styleMap.paragraph && styleMap.paragraph.jumpOut) || 'JTL Jump Turnline';
    const st = doc.paragraphStyles.itemByName(stName);
    if (st && st.isValid) story.paragraphs.item(story.paragraphs.length - 1).applyParagraphStyle(st, true);
  } catch {}
  return overflowText;
}

// Fill a jumplanding page's `jumpstoryN` / `jumpheadlineN` slots from the
// queue of captured overflows.
function fillJumpLanding(doc, page, spread, jumpQueue, styleMap) {
  const containers = [page, spread];
  const find = (name) => { for (const c of containers) { const f = frameByLabelOrName(c, name); if (f) return f; } return null; };
  let filled = 0;
  for (let n = 1; jumpQueue.length && n <= 20; n++) {
    const bodyBox = find('jumpstory' + n) || find('jumpstory-' + n);
    if (!bodyBox) continue;
    const item = jumpQueue.shift();
    try { applyAutoColumns(doc, bodyBox); setFieldText(doc, bodyBox, item.text); } catch {}
    const headBox = find('jumpheadline' + n) || find('jumpheadline-' + n);
    if (headBox) { try { setFieldText(doc, headBox, `Continued from Page ${item.sourceFolio}`); } catch {} }
    filled++;
  }
  console.log(`[wvnews-print] jumplanding: filled ${filled} continuation(s), ${jumpQueue.length} left over`);
  return filled;
}

// Story placement. Two layouts, chosen by what frames the snippet carries:
//
//  A) Separate-frame (news): a `headline` and/or `body` frame present.
//     headline / deck / kicker each go in their OWN styled frame; the
//     `body` frame (set to N columns in the snippet) receives the
//     byline + dateline + body as one styled stream (byline first line).
//     This lets the headline span full width while body runs in columns.
//     Multi-story pages number the frames headline-1/body-1, … keyed by
//     the asset's frameKey (story-2 → suffix "-2"); plain names also work.
//
//  B) Combined box (opinion-style): a `story-N` box present and no
//     separate frames — the WHOLE story (headline+body) flows into the
//     one styled box; multiple stories auto-distribute across the boxes.
//
// Photo + cutline always live in their own frames either way.
async function placeStoryAsset(page, spread, asset, styleMap, opts = {}) {
  const containers = [page, spread];
  const doc = activeDocument();
  const slot = asset.frameKey ? ((String(asset.frameKey).match(/\d+$/) || [''])[0]) : '';

  // Field → label aliases. Boxes may be numbered per story slot, with or
  // without a hyphen (headline1 / headline-1). The ET opinion scheme uses
  // `story` for the body box and `columnsig` for the byline.
  const FIELD_ALIASES = {
    kicker:       ['kicker'],
    headline:     ['headline'],
    deck:         ['deck', 'subhead'],
    byline:       ['byline', 'columnsig'],
    body:         ['body', 'story'],
    pullquote:    ['pullquote'],
    photo:        ['photo', 'image'],
    caption:      ['caption'],
    credit:       ['credit'],
    imagecaption: ['imagecaption'],   // combined cutline + credit box
  };
  const findField = (field) => {
    for (const a of (FIELD_ALIASES[field] || [field])) {
      const names = slot ? [a + '-' + slot, a + slot, a] : [a];
      for (const nm of names) {
        for (const c of containers) {
          const f = frameByLabelOrName(c, nm);
          if (f) return f;
        }
      }
    }
    return null;
  };
  // Fill a field's box, keeping the box's own paragraph style. Returns the
  // box (if present) so callers can tell whether the box exists.
  const setField = (field, value) => {
    const f = findField(field);
    if (f) setFieldText(doc, f, value);
    return f;
  };
  const placePhoto = async () => {
    if (!asset.photo) return;
    if (asset.photo.url) {
      const f = findField('photo');
      if (f) await placeUrlIntoFrame(f, asset.photo.url, `story-${asset.id}-photo`);
    }
    // Prefer one combined `imagecaptionN` box (cutline IMU + credit IMR);
    // otherwise fall back to separate caption / credit boxes.
    const capBox = findField('imagecaption');
    if (capBox && capBox.parentStory) {
      const sp = (styleMap && styleMap.paragraph) || {};
      flowCaptionCredit(doc, capBox, asset.photo.caption, asset.photo.credit,
        sp.caption || 'IMU Image Cutline Caption', sp.credit || 'IMR Image Credit');
    } else {
      setField('caption', asset.photo.caption);
      setField('credit',  asset.photo.credit);
    }
  };

  // A) Separate-element model: this slot has its own headline box, so each
  // element goes in its own labeled box (headline, deck, byline/columnsig,
  // pullquote, body/story), keeping each box's chosen paragraph style. The
  // body box auto-fits its columns.
  const headlineBox = findField('headline');
  const bodyBox = findField('body');
  const deckBox = findField('deck');
  // Diagnostic v4 (2026-06-12): which frames did findField actually
  // resolve given asset.frameKey/slot? If you see headlineBox=null with a
  // slot derived from frameKey but the snippet has a `headline<slot>`
  // Script Label, the script-label lookup is missing the frame (likely
  // pasteboard / nested-group container issue).
  try {
    const dumpLabels = () => {
      const out = [];
      for (const c of containers) {
        if (!c) continue;
        let items; try { items = c.allPageItems; } catch { continue; }
        const n = items?.length || 0;
        for (let i = 0; i < n; i++) {
          try {
            const lab = items[i].label || '';
            if (lab) out.push(lab);
          } catch {}
        }
      }
      return out;
    };
    const lbls = dumpLabels();
    console.log(`[wvnews-print] DIAG-v4 placeStory id=${asset.id} frameKey=${asset.frameKey} slot=${slot || '(empty)'} -> headlineBox=${!!headlineBox} bodyBox=${!!bodyBox} deckBox=${!!deckBox} | container labels: [${lbls.join(',')}]`);
  } catch {}
  if (headlineBox) {
    setField('kicker',    asset.kicker);
    setField('headline',  asset.headline);
    setField('deck',      asset.deck);
    setField('pullquote', asset.pullquote);
    // Byline: split on commas → BY1 Byline 1 (first paragraph) + BY2
    // Byline 2 (remaining paragraphs). If no separate `byline` box,
    // fall through and the body path prepends the SPLIT byline to the
    // body, styling those leading paragraphs BY1/BY2 and the rest BCJ.
    const bylineBox = findField('byline');
    if (bylineBox && asset.byline) setBylineParagraphs(doc, bylineBox, asset.byline, styleMap);
    if (bodyBox && bodyBox.parentStory) {
      const ncol = applyAutoColumns(doc, bodyBox);
      // Build the flowed paragraphs: optionally [byline paras…] then body.
      const bodyParas = String(asset.bodyText || asset.body || '')
        .split(/\r?\n+/).filter(p => p.trim());
      let bylineParaCount = 0;
      let flowed = bodyParas;
      if (!bylineBox && asset.byline) {
        const bylineParas = splitBylineByCommas(asset.byline).split('\r').filter(Boolean);
        bylineParaCount = bylineParas.length;
        flowed = [...bylineParas, ...bodyParas];
      }
      console.log(`[wvnews-print] slot ${slot || '?'} body box -> ${ncol} cols (byline ${bylineBox ? 'own box' : `in body (${bylineParaCount} paras)`})`);
      setFieldText(doc, bodyBox, flowed.join('\r'));
      // Per-section paragraph styling on the body box:
      //   paragraphs [0..bylineParaCount-1] → BY1 then BY2…
      //   paragraphs [bylineParaCount..end] → BCJ Body Copy Justified
      // This is the explicit override over setFieldText's frame-style
      // preservation, because the snippet's `story-N` frame often
      // ships with [No paragraph style] and the WV News stylesheet
      // REQUIRES BCJ to win on body and BY1/BY2 on the byline lines.
      try {
        const by1Name  = styleMap?.paragraph?.byline  || 'BY1 Byline 1';
        const by2Name  = styleMap?.paragraph?.byline2 || 'BY2 Byline 2';
        const bodyName = styleMap?.paragraph?.body    || 'BCJ Body Copy Justified';
        const by1  = doc.paragraphStyles.itemByName(by1Name);
        const by2  = doc.paragraphStyles.itemByName(by2Name);
        const bod  = doc.paragraphStyles.itemByName(bodyName);
        const paras = bodyBox.parentStory.paragraphs;
        for (let i = 0; i < paras.length; i++) {
          let st = null;
          if (i < bylineParaCount) {
            st = (i === 0)
              ? (by1 && by1.isValid ? by1 : null)
              : (by2 && by2.isValid ? by2 : (by1 && by1.isValid ? by1 : null));
          } else {
            st = (bod && bod.isValid ? bod : null);
          }
          if (st) paras.item(i).applyParagraphStyle(st, true);
        }
      } catch { /* best-effort */ }
      // Auto-jump: if the body overflows and the edition has a jump page,
      // capture the overflow + turnline and queue the continuation.
      if (opts.jumpQueue && opts.jumpFolio) {
        const slug = String(asset.slug || asset.headline || '').split(/\s+/).slice(0, 2).join(' ');
        const overflow = captureOverflow(doc, bodyBox, styleMap, slug, opts.jumpFolio);
        if (overflow) {
          opts.jumpQueue.push({ slug, text: overflow, sourceFolio: opts.folio || '' });
          console.log(`[wvnews-print] jump: ${asset.id} overflows -> "See ${slug}, ${opts.jumpFolio}" (${overflow.length} chars queued)`);
        }
      }
    }
    await placePhoto();
    return;
  }

  // B) Combined box (story-N) model.
  const boxes = opts.storyBoxes || collectStoryFrames(containers);
  const used = opts.used || new Set();
  let box = null;
  if (asset.frameKey) box = boxes.find(b => b.key === asset.frameKey) || null;
  if (!box) box = boxes.find(b => !used.has(b.id)) || null;
  console.log(`[wvnews-print] placeStory ${asset.id} frameKey=${asset.frameKey} pathA(headline=${!!headlineBox},body=${!!bodyBox}) boxes=[${boxes.map(b => b.key).join(',')}] -> ${box ? 'box ' + box.key : 'NO TARGET'}`);
  if (box) {
    used.add(box.id);
    // Auto-fit the box's columns to its width (headline/deck span them).
    const ncol = applyAutoColumns(doc, box.frame);
    console.log(`[wvnews-print] story box ${box.key} -> ${ncol} columns`);
    await flowCombinedStoryStream(box.frame, asset, styleMap, { includeHeadline: true });
    await placePhoto();
    return;
  }

  // C) Last resort: drop each field into any matching frame, styled.
  setField('kicker', asset.kicker, 'kicker');
  setField('headline', asset.headline, 'headline');
  setField('deck', asset.deck, 'deck');
  setField('byline', asset.byline, 'byline');
  setField('body', asset.body, 'body');
  await placePhoto();
}

// Order: place ad file into 'ad' frame.
async function placeOrderAsset(page, spread, asset) {
  if (!asset.fileUrl) return;
  for (const c of [page, spread]) {
    const f = frameByLabelOrName(c, 'ad');
    if (f) {
      await placeUrlIntoFrame(f, asset.fileUrl, `order-${asset.id}`);
      return;
    }
  }
  console.warn('[wvnews-print] no frame labeled "ad" for order', asset.id);
}

// Classified: text-only into 'classified-body'.
async function placeClassifiedAsset(page, spread, asset) {
  for (const c of [page, spread]) {
    const f = frameByLabelOrName(c, 'classified-body');
    if (f) {
      setFrameText(f, `${asset.category}\n${asset.text}`);
      return;
    }
  }
  console.warn('[wvnews-print] no frame labeled "classified-body" for', asset.id);
}

// Classifieds section: all of a page's classifieds grouped by category,
// flowed into the page's `classified-body` frame with one TEXT header per
// category (e.g. "Vehicles", "Real Estate — For Sale"). Category graphics
// (the WHEELS-style art) are a later pass — text headers for now. Header
// paragraphs get a paragraph style if the template defines one
// (styleMap.paragraph.classifiedHeader, else "Classified Category");
// otherwise they render as plain header lines.
async function placeClassifiedSection(page, spread, items, styleMap, doc) {
  let frame = null;
  for (const c of [page, spread]) frame = frame || frameByLabelOrName(c, 'classified-body');
  if (!frame) { console.warn('[wvnews-print] no frame labeled "classified-body" for classifieds'); return; }

  // Group by category, stable alphabetical order.
  const byCat = new Map();
  for (const it of items) {
    const cat = String(it.category || 'Classifieds').trim() || 'Classifieds';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(it);
  }
  const cats = [...byCat.keys()].sort((a, b) => a.localeCompare(b));

  // One paragraph per line; track which paragraph indices are headers.
  const lines = [];
  const headerIdx = [];
  for (const cat of cats) {
    headerIdx.push(lines.length);
    lines.push(cat);
    for (const it of byCat.get(cat)) {
      const t = String(it.text || '').trim();
      if (t) lines.push(t);
    }
  }
  if (!lines.length) return;
  setFrameText(frame, lines.join('\n'));

  // Best-effort header styling (no-op if the style isn't in the template).
  try {
    const headerStyleName =
      (styleMap && styleMap.paragraph && (styleMap.paragraph.classifiedHeader || styleMap.paragraph.classifiedCategory))
      || 'Classified Category';
    const style = doc && doc.paragraphStyles.itemByName(headerStyleName);
    if (style && style.isValid) {
      const paras = frame.parentStory.paragraphs;
      for (const i of headerIdx) {
        if (i < paras.length) paras.item(i).applyParagraphStyle(style, true);
      }
    }
  } catch (e) {
    console.warn('[wvnews-print] classified header styling skipped:', e?.message || e);
  }
}

// Obituary: text-only into 'obituary-body' (falls back to 'classified-body').
async function placeObituaryAsset(page, spread, asset) {
  const body = [asset.name, asset.city, asset.text, asset.funeral].filter(Boolean).join('\n');
  for (const c of [page, spread]) {
    const f = frameByLabelOrName(c, 'obituary-body') || frameByLabelOrName(c, 'classified-body');
    if (f) { setFrameText(f, body); return; }
  }
  console.warn('[wvnews-print] no frame labeled "obituary-body" for', asset.id);
}

// Map emphasis flags to an InDesign font-style name. Returns null when the
// run is plain so we leave the base paragraph style's typeface untouched.
function fontStyleName(bold, italic) {
  if (bold && italic) return 'Bold Italic';
  if (bold) return 'Bold';
  if (italic) return 'Italic';
  return null;
}

// Apply the platform's structured rich-text model (blocks of styled runs)
// to a text frame, PRESERVING the frame's existing paragraph style as the
// base and layering bold/italic/underline + L/C/R alignment on top. This
// is how website formatting survives into InDesign — see lib/legal-richtext
// on the platform for the source shape:
//   blocks: [ { align: 'left'|'center'|'right'|'justify',
//               runs: [ { text, bold, italic, underline }, ... ] }, ... ]
function applyRichTextToFrame(id, frame, blocks, baseFormat = null) {
  const story = frame && frame.parentStory;
  if (!story || !Array.isArray(blocks) || !blocks.length) return false;

  // Build the full string once, recording each styled run's character range
  // and keeping paragraph boundaries. In InDesign DOM contents, '\r' starts
  // a new paragraph; '\n' is a forced line break WITHIN a paragraph (what a
  // <br> in the source should become). Both count as one character, so
  // offsets into `full` line up with story character indices after we set
  // contents.
  let full = '';
  const runRanges = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const runs = (blocks[bi].runs && blocks[bi].runs.length) ? blocks[bi].runs : [{ text: '' }];
    for (const r of runs) {
      const t = String(r.text == null ? '' : r.text).replace(/\r/g, '');
      const start = full.length;
      full += t;
      if (t && (r.bold || r.italic || r.underline)) {
        runRanges.push({ start, end: full.length - 1, bold: !!r.bold, italic: !!r.italic, underline: !!r.underline });
      }
    }
    if (bi < blocks.length - 1) full += '\r';
  }

  // Without a baseFormat we deliberately do NOT set appliedParagraphStyle —
  // the target frame's base style stays intact; we only override alignment +
  // inline emphasis. With a baseFormat (manual content block) we stamp the
  // block's font/size/leading on the whole story FIRST, so the per-run
  // bold/italic below combines with that family (e.g. Helvetica Neue Bold).
  story.contents = full;

  if (baseFormat) {
    const t = story.texts.item(0);
    if (baseFormat.font)      { try { t.appliedFont = baseFormat.font; } catch (e) { console.warn('[wvnews-print] font not found:', baseFormat.font); } }
    if (baseFormat.pointSize) { try { t.pointSize = baseFormat.pointSize; } catch (e) {} }
    if (baseFormat.leading)   { try { t.leading = baseFormat.leading; } catch (e) {} }
    // No indents on placed content.
    try { t.leftIndent = 0; } catch (e) {}
    try { t.rightIndent = 0; } catch (e) {}
    try { t.firstLineIndent = 0; } catch (e) {}
  }

  const JUST = {
    left:    id.Justification.LEFT_ALIGN,
    center:  id.Justification.CENTER_ALIGN,
    right:   id.Justification.RIGHT_ALIGN,
    justify: id.Justification.LEFT_JUSTIFIED,
  };
  const paras = story.paragraphs;
  if (baseFormat && baseFormat.justification != null) {
    // Default every paragraph to the block justification, but CARRY OVER
    // center alignment from the source (centered is the only alignment we
    // preserve; left/right/justify all fall back to the block default).
    for (let i = 0; i < paras.length; i++) {
      const centered = blocks[i] && blocks[i].align === 'center';
      const j = centered ? id.Justification.CENTER_ALIGN : baseFormat.justification;
      try { paras.item(i).justification = j; } catch (e) {}
    }
  } else {
    for (let bi = 0; bi < blocks.length && bi < paras.length; bi++) {
      const j = JUST[blocks[bi].align];
      if (j != null) { try { paras.item(bi).justification = j; } catch (e) { /* keep base */ } }
    }
  }

  // Inline character formatting. Each range is wrapped so one missing font
  // style (e.g. a face with no 'Bold Italic') never aborts the rest.
  for (const r of runRanges) {
    let chars;
    try { chars = story.characters.itemByRange(r.start, r.end); } catch (e) { continue; }
    const fs = fontStyleName(r.bold, r.italic);
    if (fs) { try { chars.fontStyle = fs; } catch (e) { /* font lacks this style */ } }
    if (r.underline) { try { chars.underline = true; } catch (e) {} }
  }
  return true;
}

// Legal notice into 'legal-body' (falls back to 'classified-body'). Prefers
// the website's formatting via asset.richText; falls back to plain text for
// older platform builds that don't send it.
async function placeLegalAsset(page, spread, asset) {
  const id = host();
  for (const c of [page, spread]) {
    const f = frameByLabelOrName(c, 'legal-body') || frameByLabelOrName(c, 'classified-body');
    if (!f) continue;
    if (Array.isArray(asset.richText) && asset.richText.length) {
      // Title is intentionally not placed — body text only.
      const blocks = asset.richText.slice();
      if (applyRichTextToFrame(id, f, blocks)) return;
    }
    setFrameText(f, String(asset.text || ''));
    return;
  }
  console.warn('[wvnews-print] no frame labeled "legal-body" for', asset.id);
}

async function placeAssetsForPage(edition, page, doc, styleMap, jumpCtx = {}) {
  const list = Array.isArray(page.assets) ? page.assets : [];
  if (!list.length) return { placed: 0, missed: 0 };
  const pageObj = doc.pages.item(0);
  const spread = (() => { try { return pageObj.parent; } catch { return null; } })();
  // Collect the page's story boxes once and track which are filled, so
  // multiple assigned stories auto-distribute across them in order.
  const storyBoxes = collectStoryFrames([pageObj, spread]);
  const usedBoxes = new Set();
  // Auto-slot counter for story-kind assets without an explicit
  // frameKey. We hand each successive story a `story-N` key so the
  // plugin's slot-suffixed label lookup (headline-N, body-N, photo)
  // routes it to the matching frames in Path A. Without this, slot
  // is empty and findField only matches unsuffixed labels — pages
  // with numbered labels (the WV News convention) fall through to
  // Path B and lose headline-in-its-own-box.
  let autoStoryIdx = 0;
  let placed = 0, missed = 0;
  // Classifieds are placed together as a grouped section (one header per
  // category) after the loop, not one-frame-each — so collect them here.
  const classifiedItems = [];
  for (const a of list) {
    try {
      const content = await fetchAssetContent(edition.id, a.kind, a.id);
      if (!content) { missed++; console.warn(`[wvnews-print] asset content missing for ${a.kind}/${a.id}`); continue; }
      // Carry the asset's frameKey (explicit box target) OR auto-assign
      // the next story-N slot in label order so frame-suffix lookups fire.
      if (a.frameKey != null) {
        content.frameKey = a.frameKey;
      } else if (a.kind === 'story') {
        content.frameKey = `story-${++autoStoryIdx}`;
      }
      if (a.kind === 'story')       await placeStoryAsset(pageObj, spread, content, styleMap, { storyBoxes, used: usedBoxes, jumpQueue: jumpCtx.jumpQueue, jumpFolio: jumpCtx.jumpFolio, folio: page.folio });
      else if (a.kind === 'order')  await placeOrderAsset(pageObj, spread, content);
      else if (a.kind === 'classified') { classifiedItems.push(content); }
      else if (a.kind === 'obituary') await placeObituaryAsset(pageObj, spread, content);
      else if (a.kind === 'legal') await placeLegalAsset(pageObj, spread, content);
      else { console.warn(`[wvnews-print] kind not yet wired: ${a.kind}`); missed++; continue; }
      placed++;
    } catch (e) {
      missed++;
      console.warn(`[wvnews-print] asset placement failed for ${a.kind}/${a.id}:`, e?.message || e);
    }
  }
  // Classifieds: grouped into the `classified-body` frame with one text
  // header per category (graphics come later — text headers for now).
  if (classifiedItems.length) {
    try { await placeClassifiedSection(pageObj, spread, classifiedItems, styleMap, doc); }
    catch (e) { console.warn('[wvnews-print] classified section failed:', e?.message || e); }
  }
  return { placed, missed };
}

// Build every page in an edition and check each one in to the website
// (Firebase Storage) as a new version — no local TCMS folder. onProgress
// ({ folio, index, total, phase }) fires as each page moves through
// checkout→create→place→save(check-in). Returns
// { results:[{folio, placed, saved, version?, error?}], built, failed }.
async function buildEditionPages(edition, snippetsById, onProgress) {
  const id = host();
  console.log('[wvnews-print] ===== BUILD DIAG v3 — story-box diagnostics ACTIVE =====');
  if (!edition || !Array.isArray(edition.pages)) {
    throw new Error('Edition has no pages to build.');
  }
  // Built pages are saved back to the website (Firebase Storage) via the
  // per-page check-out → check-in flow — NOT to a local TCMS volume.
  const templateEntry = await resolveTemplateEntry(edition);
  // Effective style map for this pub — maps story field keys to the
  // InDesign paragraph styles applied when a story flows into a single
  // `storyFrame` box. Best-effort: build still runs (unstyled) if absent.
  let styleMap = null;
  try { styleMap = await fetchStyleMap(edition.siteId); }
  catch (e) { console.warn('[wvnews-print] style map fetch failed:', e?.message || e); }
  console.log('[wvnews-print] build: target=website (check-in)',
    'template=', (templateEntry && templateEntry.nativePath) || '(blank docs)',
    'styleMap=', styleMap ? (styleMap.id || 'loaded') : '(none)');

  const pages = edition.pages;
  const results = [];
  const notify = (folio, index, phase) => {
    try { onProgress && onProgress({ folio, index, total: pages.length, phase }); } catch {}
  };

  // Auto-jump wiring: find the jump-landing page (its snippet carries
  // `jumpstory-N` wells, surfaced as jumpSlots on the record). Source
  // stories that overflow push their tails into a shared queue with a
  // "See SLUG, <jumpFolio>" turnline; the jump page is built LAST so the
  // queue is full when fillJumpLanding pours the continuations in.
  const isJumpPage = (pg) => {
    const sn = pg.snippetId && snippetsById ? snippetsById[pg.snippetId] : null;
    return !!(sn && Number(sn.jumpSlots) > 0);
  };
  const jumpQueue = [];
  const jumpPg = pages.find(isJumpPage);
  const jumpFolio = jumpPg ? jumpPg.folio : '';
  if (jumpFolio) console.log(`[wvnews-print] auto-jump: continuations land on page ${jumpFolio}`);
  // Build order: every non-jump page first (in document order), then the
  // jump page(s) last so captured overflows are available to pour in.
  const order = [];
  for (let i = 0; i < pages.length; i++) if (!isJumpPage(pages[i])) order.push(i);
  for (let i = 0; i < pages.length; i++) if (isJumpPage(pages[i])) order.push(i);

  for (const i of order) {
    const pg = pages[i];
    const pgIsJump = isJumpPage(pg);
    let doc = null;
    try {
      // Acquire the page lock on the website before building, so the
      // check-in upload is accepted. We build fresh from the template +
      // snippet, so we ignore whatever version checkout returns — we only
      // need the lock. Throws 423 here if someone else holds the page.
      notify(pg.folio, i, 'checkout');
      await checkoutPage({ editionId: edition.id, folio: pg.folio, host: 'Build Pages' });

      notify(pg.folio, i, 'create');
      // Open the template (.indt opens as a new untitled doc) or, if no
      // template is uploaded for this pub, create a blank document.
      doc = await openBuildDoc(templateEntry);

      // Resolve the assigned snippet up-front so we can use its
      // pageRole to drive the master choice (e.g. Opinion lands on
      // A3 but wants A-Master regardless of position).
      const snip = pg.snippetId && snippetsById ? snippetsById[pg.snippetId] : null;
      if (pg.snippetId && !snip) {
        throw new Error(`assigned snippet ${pg.snippetId} not in library`);
      }

      // Apply the right master to page 1. Snippet pageRole wins if set;
      // otherwise fall back to position (A1/B1/C1 = opener, else inside).
      applyMasterByFolio(doc, pg.folio, snip);

      // Place the assigned snippet, if any.
      let placed = false;
      if (pg.snippetId) {
        notify(pg.folio, i, 'download');
        const buf = await downloadSnippetBinary(snip);
        const tempPath = await writeTemp(`${pg.snippetId}.idms`, buf);
        notify(pg.folio, i, 'place');
        placed = await placeSnippetIntoActiveDoc(doc, tempPath, snip);
        if (!placed) console.warn('[wvnews-print] build: snippet did not land for', pg.folio);
      }

      // Place any content assets (stories/ads/classifieds) the editor
      // assigned to this folio. Each asset's payload is fetched on
      // demand and flowed into frames that match its canonical labels.
      let assetStats = { placed: 0, missed: 0 };
      if (Array.isArray(pg.assets) && pg.assets.length) {
        notify(pg.folio, i, 'assets');
        // Don't queue jumps off the jump page itself; only source pages
        // capture overflow (and only when a jump landing exists).
        const jumpCtx = (jumpFolio && !pgIsJump) ? { jumpQueue, jumpFolio } : {};
        assetStats = await placeAssetsForPage(edition, pg, doc, styleMap, jumpCtx);
        if (assetStats.placed) console.log(`[wvnews-print] placed ${assetStats.placed} asset(s) on ${pg.folio}, ${assetStats.missed} missed`);
      }

      // Jump landing: pour any captured story tails into the page's
      // jumpstory-N / jumpheadline-N wells. Built last, so the queue holds
      // every overflow from the source pages.
      if (pgIsJump && jumpQueue.length) {
        const pageObj2 = doc.pages.item(0);
        const spread2 = (() => { try { return pageObj2.parent; } catch { return null; } })();
        fillJumpLanding(doc, pageObj2, spread2, jumpQueue, styleMap);
      }

      stampFolio(doc, pg.folio, edition);

      // Save the built page to a temp file, read its bytes, and check it
      // in to the website (Firebase Storage) as a new version. keepLock
      // false releases the lock we took above.
      notify(pg.folio, i, 'save');
      const fileName = cloudPageTempName(edition.id, pg.folio);
      const tFolder = await tempFolder();
      let entry;
      try {
        entry = await tFolder.createFile(fileName, { overwrite: true });
        await doc.save(entry);
      } catch {
        await doc.save(`${tFolder.nativePath}/${fileName}`);
        entry = await tFolder.getEntry(fileName);
      }
      const bytes = await entry.read({ format: require('uxp').storage.formats.binary });
      const checkin = await checkinPage({
        editionId: edition.id, folio: pg.folio, bytes,
        note: 'Built by plugin', keepLock: false,
      });
      const version = checkin?.page?.currentVersion ?? checkin?.currentVersion ?? null;
      const path = `website v${version ?? '?'}`;

      // Abort any place gun that page.place() may have left loaded.
      // doc.close() will throw "User canceled this action." if the
      // place gun still carries items at close time.
      try {
        const w = id.app.activeWindow;
        if (w && w.placeGun && w.placeGun.loaded) w.placeGun.abortPlaceGun();
      } catch {}
      try { if (id.app.placeGun && id.app.placeGun.loaded) id.app.placeGun.abortPlaceGun(); } catch {}

      // Close the doc. The first form throws "User canceled this
      // action." on some UXP InDesign builds when the place gun has
      // residual state, so we try several close forms before giving
      // up. The file is already on disk either way.
      let closeOk = false;
      const closeAttempts = [
        () => doc.close(id.SaveOptions.NO),
        () => doc.close(),
        () => { if (id.SaveOptions && id.SaveOptions.no !== undefined) return doc.close(id.SaveOptions.no); throw new Error('no SaveOptions.no'); },
        // Last resort: close every doc that isn't the one we plan to
        // touch next. Heavy-handed but avoids the lock-file pileup.
        () => { try { id.app.documents.everyItem(); } catch {} doc.close(id.SaveOptions.NO); },
      ];
      for (const fn of closeAttempts) {
        try { fn(); closeOk = true; break; }
        catch (e) { /* try next form */ }
      }
      if (!closeOk) {
        console.warn('[wvnews-print] build: all close forms threw; doc + .idlk lock may linger for', pg.folio);
      }
      doc = null;
      results.push({ folio: pg.folio, placed, saved: true, version, path, closed: closeOk, assets: assetStats });
      console.log('[wvnews-print] build: checked in', pg.folio, '->', path, closeOk ? '' : '(close failed)');
    } catch (e) {
      const msg = e?.message || String(e);
      console.error('[wvnews-print] build: failed for', pg.folio, msg);
      // Try not to leave a half-built doc open.
      if (doc) { try { doc.close(id.SaveOptions.NO); } catch {} }
      results.push({ folio: pg.folio, placed: false, saved: false, error: msg });
    }
  }

  const built = results.filter(r => r.saved).length;
  const failed = results.length - built;
  return { results, built, failed };
}

// ── Cloud check-out / check-in ─────────────────────────────────────
//
// A cloud-stored page binary arrives as an ArrayBuffer from the API.
// We write it to a stable per-page filename in the UXP temp folder
// (so a subsequent Cmd-S saves back to the same file we can read),
// then open it in InDesign. The returned object holds everything the
// caller needs to drive heartbeats + check-in.
//
// The temp filename is keyed by `<editionId>_<folio>.indd` so two
// pages checked out from the same edition don't collide, and a
// re-check-out (e.g. after an InDesign crash) lands on the same path
// rather than leaving an orphan.

function cloudPageTempName(editionId, folio) {
  const safeEdition = String(editionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFolio = String(folio).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `wv_${safeEdition}_${safeFolio}.indd`;
}

// Download → write to temp → open. `arrayBuffer` is the .indd bytes,
// `editionId`/`folio` name the temp file. Returns the opened doc
// reference plus the temp path so heartbeats / check-in know where to
// read the bytes back from.
async function openDownloadedPage({ editionId, folio, arrayBuffer }) {
  const tempPath = await writeTemp(
    cloudPageTempName(editionId, folio),
    arrayBuffer
  );
  // Get the file entry back as a token InDesign.app.open() will accept.
  const folder = await tempFolder();
  const entry = await folder.getEntry(cloudPageTempName(editionId, folio));
  const id = host();
  let doc;
  try { doc = await id.app.open(entry); }
  catch (e1) {
    // Some UXP/InDesign versions only accept a string path here.
    try { doc = await id.app.open(tempPath); }
    catch (e2) {
      throw new Error(`Could not open ${folio}.indd: ${e2.message || e1.message}`);
    }
  }
  return { doc, tempPath, fileName: cloudPageTempName(editionId, folio) };
}

// Create a new blank InDesign document and save it to the same temp
// path scheme `openDownloadedPage` uses. Same return shape, so the
// caller can treat both paths identically.
//
// Used when checking out a page whose record has currentVersion=0 —
// the publication has no .indt template yet, so there's no v1 binary
// to download. Designer gets a fresh blank doc; first check-in writes
// v1 to cloud storage. From that point on every check-out downloads
// the saved v1 like a normal page.
async function createBlankPage({ editionId, folio }) {
  const id = host();
  const fileName = cloudPageTempName(editionId, folio);
  const doc = id.app.documents.add();
  const folder = await tempFolder();
  let tempPath;
  try {
    const entry = await folder.createFile(fileName, { overwrite: true });
    await doc.save(entry);
    tempPath = entry.nativePath;
  } catch (e1) {
    // Some UXP builds want a native string path on initial save.
    try {
      tempPath = `${folder.nativePath}/${fileName}`;
      await doc.save(tempPath);
    } catch (e2) {
      try { doc.close(id.SaveOptions.NO); } catch { /* best effort */ }
      throw new Error(`Could not save blank ${folio}: ${e2.message || e1.message}`);
    }
  }
  return { doc, tempPath, fileName };
}

// Find the open document matching a previously-downloaded temp path.
// Used by check-in / close-without-save flows so we don't blindly
// operate on whatever the user has frontmost.
function findOpenDocByTempPath(tempPath) {
  if (!tempPath) return null;
  const id = host();
  try {
    for (let i = 0; i < id.app.documents.length; i++) {
      const d = id.app.documents.item(i);
      try {
        if (d.fullName && String(d.fullName).indexOf(tempPath) !== -1) return d;
        if (d.filePath && String(d.filePath).indexOf(tempPath.replace(/\/[^/]+$/, '')) !== -1) return d;
      } catch { /* keep looking */ }
    }
  } catch { /* no docs */ }
  return null;
}

// Save the active document in place (back to the temp path it was opened
// from) and read the bytes back. Returns the ArrayBuffer the caller
// uploads via api.checkinPage.
//
// Caller can pass a specific doc reference; otherwise we use the
// activeDocument. We DO NOT close the doc here — the caller decides
// (e.g. close on check-in, keep open on "save without checking in").
async function saveAndReadPageBytes({ doc, fileName }) {
  const target = doc || activeDocument();
  try { await target.save(); }
  catch (e) {
    // Some InDesign builds require an explicit destination on the
    // first save-back even for an already-on-disk doc.
    try {
      const folder = await tempFolder();
      const entry = await folder.getEntry(fileName);
      await target.save(entry);
    } catch (e2) {
      throw new Error(`Save failed: ${e2.message || e.message}`);
    }
  }
  const folder = await tempFolder();
  const entry = await folder.getEntry(fileName);
  return await entry.read({ format: require('uxp').storage.formats.binary });
}

async function closePageDoc(doc) {
  if (!doc) return;
  const id = host();
  try { doc.close(id.SaveOptions.NO); } catch { /* already closed */ }
}

module.exports = {
  placeTemplate, flowIntoSelectedFrame, placePhotoInSelection, placeMarketplaceBlock,
  flowFullStoryIntoLabelledFrames, threadAndJump,
  captureSourceForJump, completeJumpToFrame,
  placeStoryIntoSelectedFrame,
  placeAndBindStoryBlock,
  autoPaginatePage,
  STORY_BLOCK_IDS,
  verifyPlacedAssets,
  buildEditionPages,
  activeDocument, activePageLabel,
  openDownloadedPage, createBlankPage, findOpenDocByTempPath, saveAndReadPageBytes, closePageDoc,
};
