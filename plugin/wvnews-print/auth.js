// PKCE auth — code_verifier/challenge generation, OOB authorize URL
// construction, code exchange, refresh.

const { CONFIG } = require('./config.js');
const { saveTokens, loadTokens, clearTokens } = require('./storage.js');

function base64url(buf) {
  let bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Pure-JS SHA-256. UXP 8 doesn't expose crypto.subtle as a global, so
// we can't depend on the WebCrypto API. ~50 lines; works on any string.
function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const bitLen = len * 8;
  const padLen = (len + 9 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const W = new Uint32Array(64);
  const rotr = (n, b) => ((n >>> b) | (n << (32 - b))) >>> 0;
  for (let chunk = 0; chunk < padLen; chunk += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, H[i], false);
  return out;
}

function randomString(bytes = 32) {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return base64url(arr.buffer);
}

// PKCE state held in module scope, with a hard expiry. If the user
// clicks Sign in but never completes the browser flow, the verifier +
// state are dropped after `PENDING_PKCE_TTL_MS` so a later paste of a
// foreign code (e.g. from a phishing email) can't bind to the stale
// verifier. The user has to click Sign in again to start a fresh flow.
let pendingPkce = null;
const PENDING_PKCE_TTL_MS = 5 * 60 * 1000; // 5 min — matches the server's code TTL

async function beginAuthorize() {
  const verifier = randomString(48);
  const challenge = base64url(await sha256(verifier));
  const state = randomString(16);
  const params = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.OOB_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const url = `${CONFIG.SERVER_BASE}/api/plugin/oauth/authorize?${params.toString()}`;
  pendingPkce = { verifier, state, expiresAt: Date.now() + PENDING_PKCE_TTL_MS };
  return url;
}

// Format the code the user pastes into the panel: accept either a bare
// code (legacy) OR `<state>.<code>` so we can verify the state binding
// before exchanging the verifier. The server's OOB page concatenates in
// this shape; the older plain-code shape stays accepted for backwards
// compatibility with already-deployed authorize pages that don't include
// the state prefix.
function parsePastedCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return { state: null, code: '' };
  // Allow both `state.code` and bare `code`. Codes are base64url chars
  // (no dots) so a dot is an unambiguous separator.
  const dot = s.indexOf('.');
  if (dot < 0) return { state: null, code: s };
  return { state: s.slice(0, dot), code: s.slice(dot + 1) };
}

async function exchangeCode(rawCode) {
  if (!pendingPkce) throw new Error('No PKCE flow in progress — click Sign in first.');
  if (Date.now() > pendingPkce.expiresAt) {
    pendingPkce = null;
    throw new Error('Sign-in attempt expired (over 5 minutes). Click Sign in again.');
  }
  const { state: pastedState, code } = parsePastedCode(rawCode);
  // If the OOB page returned a state, it MUST match what we sent so a
  // phishing-induced paste of a code minted from a different verifier
  // can't complete. Bare-code pastes (no state prefix) are still
  // accepted for compatibility, but the server tracks the state too
  // and will reject mismatches there if the OOB page evolves.
  if (pastedState && pastedState !== pendingPkce.state) {
    throw new Error('State mismatch — this code was issued for a different sign-in attempt.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: pendingPkce.verifier,
    redirect_uri: CONFIG.OOB_REDIRECT,
    client_id: CONFIG.CLIENT_ID,
  });
  const res = await fetch(`${CONFIG.SERVER_BASE}/api/plugin/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'token exchange failed');
  pendingPkce = null;
  await saveTokens({
    access:  data.access_token,
    refresh: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data;
}

async function getAccessToken() {
  const t = await loadTokens();
  if (!t) return null;
  if (t.expiresAt && t.expiresAt - Date.now() < 60_000) {
    try {
      const refreshed = await refresh(t.refresh);
      return refreshed.access;
    } catch (err) {
      await clearTokens();
      throw err;
    }
  }
  return t.access;
}

async function refresh(refreshToken) {
  if (!refreshToken) throw new Error('No refresh token');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CONFIG.CLIENT_ID,
  });
  const res = await fetch(`${CONFIG.SERVER_BASE}/api/plugin/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'refresh failed');
  const next = {
    access: data.access_token,
    refresh: refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  await saveTokens(next);
  return next;
}

async function signOut() {
  await clearTokens();
  pendingPkce = null;
}

module.exports = { beginAuthorize, exchangeCode, getAccessToken, signOut };
