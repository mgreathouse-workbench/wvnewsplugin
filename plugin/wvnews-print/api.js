// Server API client — thin wrappers around /api/print/* with the
// access token threaded through Authorization headers.

const { CONFIG } = require('./config.js');
const { getAccessToken } = require('./auth.js');

async function call(path, init = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(`${CONFIG.SERVER_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

async function fetchSites() {
  return await call(`/api/print/sites`);
}

async function fetchBudget(siteId, editionDate) {
  return await call(`/api/print/budget/${encodeURIComponent(siteId)}/${encodeURIComponent(editionDate)}`);
}

async function listTemplates({ siteId, kind } = {}) {
  const qs = new URLSearchParams();
  if (siteId) qs.set('siteId', siteId);
  if (kind) qs.set('kind', kind);
  return await call(`/api/print/templates?${qs.toString()}`);
}

async function getTemplate(id) {
  return await call(`/api/print/templates/${encodeURIComponent(id)}`);
}

async function recordPlacement(placement) {
  return await call(`/api/print/placements`, {
    method: 'PUT',
    body: JSON.stringify(placement),
  });
}

async function deletePlacement(id) {
  return await call(`/api/print/placements?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Flip the given display-ad orders to Published for an edition (Publish Page).
async function publishAds({ editionId, orderIds }) {
  return await call(`/api/print/ads/publish`, {
    method: 'POST',
    body: JSON.stringify({ editionId, orderIds }),
  });
}

// Hosts we trust to serve binaries the plugin will write to disk and
// hand to InDesign. Mirrors the manifest's network.domains: own backend
// (any port, dev or prod), Firebase Storage, and bare GCS. Anything
// else gets rejected before the fetch lands — defense in depth on top
// of UXP's manifest-domain enforcement.
const ALLOWED_BINARY_HOSTS = [
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
];

function isAllowedBinaryUrl(url) {
  try {
    const u = new URL(url);
    // Our own backend (whatever SERVER_BASE points at).
    if (url.startsWith(CONFIG.SERVER_BASE)) return true;
    // Allowlisted hosts (Firebase / GCS signed URLs).
    if (ALLOWED_BINARY_HOSTS.includes(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

async function fetchBinary(url) {
  if (!isAllowedBinaryUrl(url)) {
    throw new Error(`Refused fetch — host not in plugin's allowlist: ${url.slice(0, 80)}`);
  }
  // Our own backend routes (e.g. /api/print/section-headers) require the
  // plugin's bearer token; public Firebase/GCS URLs (obit photos) don't.
  const headers = {};
  if (url.startsWith(CONFIG.SERVER_BASE)) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

// List the available classified/legal section-header graphics. Returns
// { count, headers: [{ slug, url }] }. The plugin maps a category to a slug
// and places the matching PDF at the top of that section.
async function fetchSectionHeaders() {
  return await call(`/api/print/section-headers`);
}

// ── Publication-creation feature ───────────────────────────────────
// See PUBLICATION-CREATION-SPEC.md in the repo root.

async function listSnippets({ siteId, category } = {}) {
  const qs = new URLSearchParams();
  if (siteId) qs.set('siteId', siteId);
  if (category) qs.set('category', category);
  return await call(`/api/print/snippets${qs.toString() ? '?' + qs : ''}`);
}

async function getSnippet(id) {
  return await call(`/api/print/snippets/${encodeURIComponent(id)}`);
}

// Download a snippet's binary content as an ArrayBuffer. Two paths:
//   1. The snippet metadata response carries a signed Firebase Storage
//      URL — fastest, no backend round-trip.
//   2. Fallback to /api/print/snippets/[id]/download which streams
//      through our backend (used in demo mode and when the signed URL
//      is missing/expired).
async function downloadSnippetBinary(snippet) {
  if (snippet?.downloadUrl) {
    try { return await fetchBinary(snippet.downloadUrl); }
    catch { /* fall through to backend route */ }
  }
  const id = typeof snippet === 'string' ? snippet : snippet?.id;
  if (!id) throw new Error('downloadSnippetBinary: snippet id required');
  // Backend route requires our Bearer token, so route through `call`'s
  // header logic. Returns an ArrayBuffer-compatible blob via response.
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(
    `${CONFIG.SERVER_BASE}/api/print/snippets/${encodeURIComponent(id)}/download`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

// Fetch the publication template metadata + signed download URL for a
// given publication. Returns null if no template has been uploaded.
async function getPublicationTemplate(siteId, variant) {
  if (!siteId) return null;
  const q = variant && variant !== 'weekday' ? `?variant=${encodeURIComponent(variant)}` : '';
  try {
    const r = await call(`/api/print/publication-templates/${encodeURIComponent(siteId)}${q}`);
    return r?.template || null;
  } catch (e) {
    // 404 means no template uploaded — treat as null rather than fatal.
    if (/HTTP 404|Not found/i.test(e.message)) return null;
    throw e;
  }
}

// Fetch a publication's effective style map (field key → InDesign
// paragraph/character style name). Used by the build flow to style the
// combined single-box story stream. Returns null on 404.
async function fetchStyleMap(siteId) {
  if (!siteId) return null;
  try {
    const r = await call(`/api/print/style-maps/${encodeURIComponent(siteId)}`);
    return r?.styleMap || null;
  } catch (e) {
    if (/HTTP 404|Not found/i.test(e.message)) return null;
    throw e;
  }
}

// Download a publication-template binary as ArrayBuffer. Mirrors the
// snippet-download two-path logic (signed URL first, backend fallback).
async function downloadPublicationTemplateBinary(template) {
  if (template?.downloadUrl) {
    try { return await fetchBinary(template.downloadUrl); }
    catch { /* fall through to backend route */ }
  }
  const siteId = typeof template === 'string' ? template : template?.siteId;
  if (!siteId) throw new Error('downloadPublicationTemplateBinary: siteId required');
  const variant = (typeof template === 'object' && template?.variant) || 'weekday';
  const q = variant !== 'weekday' ? `?variant=${encodeURIComponent(variant)}` : '';
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(
    `${CONFIG.SERVER_BASE}/api/print/publication-templates/${encodeURIComponent(siteId)}/download${q}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

async function listEditions({ siteId, editionDate } = {}) {
  const qs = new URLSearchParams();
  if (siteId) qs.set('siteId', siteId);
  if (editionDate) qs.set('editionDate', editionDate);
  return await call(`/api/print/editions${qs.toString() ? '?' + qs : ''}`);
}

async function getEdition(id) {
  return await call(`/api/print/editions/${encodeURIComponent(id)}`);
}

// Fetch the trimmed-for-print payload for a single content asset
// (story/order/classified/obituary/legal) assigned to this edition.
// Returns null on 404 so the build loop can skip missing assets without
// killing the whole run.
async function fetchAssetContent(editionId, kind, assetId) {
  if (!editionId || !kind || !assetId) {
    throw new Error('fetchAssetContent: editionId + kind + assetId required');
  }
  try {
    const r = await call(`/api/print/editions/${encodeURIComponent(editionId)}/asset/${encodeURIComponent(kind)}/${encodeURIComponent(assetId)}`);
    return r?.asset || null;
  } catch (e) {
    if (/HTTP 404|not assigned|not found/i.test(e.message)) return null;
    throw e;
  }
}

async function updateEditionStatus(id, status) {
  return await call(`/api/print/editions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

// ── Cloud page files (check-out / check-in) ────────────────────────
// Server-side: src/lib/print-page-files.js + api/print/editions/[id]/pages/*

async function listEditionPages(editionId) {
  if (!editionId) throw new Error('listEditionPages: editionId required');
  const r = await call(`/api/print/editions/${encodeURIComponent(editionId)}/pages`);
  return r?.pages || [];
}

// Acquire (or refresh) the lock on a page. Returns { page, downloadUrl }.
// downloadUrl is a signed URL (prod) or a back-end stream (demo). If
// someone else holds the lock the server replies 423; we surface the
// holder via err.lock so the UI can render "Brian has this page open."
async function checkoutPage({ editionId, folio, host }) {
  if (!editionId || !folio) throw new Error('checkoutPage: editionId + folio required');
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(
    `${CONFIG.SERVER_BASE}/api/print/editions/${encodeURIComponent(editionId)}/pages/${encodeURIComponent(folio)}/checkout`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: host || '' }),
    }
  );
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (res.status === 423) {
    const err = new Error(data?.error || 'Page is checked out');
    err.statusCode = 423;
    err.lock = data?.lock || null;
    throw err;
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function heartbeatPage({ editionId, folio }) {
  return await call(
    `/api/print/editions/${encodeURIComponent(editionId)}/pages/${encodeURIComponent(folio)}/heartbeat`,
    { method: 'POST' }
  );
}

// Upload an .indd binary as a new version. `bytes` is an ArrayBuffer
// read from the local temp file we downloaded into. Server bumps
// currentVersion + clears the lock (unless keepLock=true).
async function checkinPage({ editionId, folio, bytes, note = '', keepLock = false }) {
  if (!editionId || !folio || !bytes) {
    throw new Error('checkinPage: editionId + folio + bytes required');
  }
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');
  const form = new FormData();
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  form.append('file', blob, `${folio}.indd`);
  if (note) form.append('note', note);
  if (keepLock) form.append('keepLock', 'true');
  const res = await fetch(
    `${CONFIG.SERVER_BASE}/api/print/editions/${encodeURIComponent(editionId)}/pages/${encodeURIComponent(folio)}/checkin`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.statusCode = res.status;
    err.lock = data?.lock || null;
    throw err;
  }
  return data;
}

async function breakPageLock({ editionId, folio }) {
  return await call(
    `/api/print/editions/${encodeURIComponent(editionId)}/pages/${encodeURIComponent(folio)}/lock`,
    { method: 'DELETE' }
  );
}

// Fetch a page binary as ArrayBuffer. In prod the checkout response
// returns a signed GCS URL; in demo it's a back-end stream at
// /pages/.../download (auth-gated). Either way, just fetch it.
// List available classifieds / legals / obits for a publication (the
// Marketplace tab). kind = 'classifieds' | 'legals' | 'obits'.
async function fetchMarketplace(siteId, kind, date) {
  if (!siteId || !kind) throw new Error('fetchMarketplace: siteId + kind required');
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const r = await call(`/api/print/marketplace/${encodeURIComponent(siteId)}/${encodeURIComponent(kind)}${qs}`);
  return { count: r?.count || 0, items: Array.isArray(r?.items) ? r.items : [] };
}

async function fetchPageBinary(downloadUrl) {
  if (!downloadUrl) throw new Error('fetchPageBinary: downloadUrl required');
  if (downloadUrl.startsWith(CONFIG.SERVER_BASE)) {
    const token = await getAccessToken();
    if (!token) throw new Error('Not signed in');
    const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return await res.arrayBuffer();
  }
  return await fetchBinary(downloadUrl);
}

module.exports = {
  fetchSites, fetchBudget, listTemplates, getTemplate, recordPlacement, deletePlacement, publishAds, fetchBinary,
  listSnippets, getSnippet, downloadSnippetBinary,
  getPublicationTemplate, downloadPublicationTemplateBinary, fetchStyleMap,
  listEditions, getEdition, updateEditionStatus, fetchAssetContent,
  listEditionPages, checkoutPage, heartbeatPage, checkinPage, breakPageLock,
  fetchPageBinary, fetchMarketplace, fetchSectionHeaders,
};
