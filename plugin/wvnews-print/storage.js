// Token persistence using UXP's secureStorage. We never store tokens
// unencrypted on disk in a UXP runtime; the secureStorage path uses the
// OS keychain. The localStorage fallback exists for non-UXP test
// harnesses (e.g. running this code in a browser-based test) and is
// gated behind an explicit ALLOW_INSECURE_FALLBACK flag — otherwise a
// transient secureStorage error in production would silently downgrade
// the user to plaintext on-disk tokens with no signal.

const KEY = 'wvnews-print.tokens.v1';

// Set true ONLY for browser-based testing / dev harnesses where UXP's
// secureStorage isn't available. Must be false for any shipped UXP
// build; the manifest is published under that assumption.
const ALLOW_INSECURE_FALLBACK = false;

// Track whether we've already complained about a missing secureStorage
// so the warning fires once, not on every read/write.
let warnedFallback = false;

async function getStorage() {
  try {
    const uxp = require('uxp');
    if (uxp && uxp.storage && uxp.storage.secureStorage) {
      return { kind: 'uxp', secure: uxp.storage.secureStorage };
    }
  } catch {
    // Fallthrough.
  }
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      '[wvnews-print/storage] UXP secureStorage unavailable. ' +
      (ALLOW_INSECURE_FALLBACK
        ? 'Falling back to localStorage (plaintext on disk) — DEV ONLY.'
        : 'Refusing to fall back to plaintext storage — sign-in will fail until secureStorage is reachable.')
    );
  }
  if (!ALLOW_INSECURE_FALLBACK) {
    return { kind: 'none', secure: null };
  }
  return { kind: 'web', secure: null };
}

async function saveTokens(tokens) {
  const s = await getStorage();
  const payload = JSON.stringify(tokens);
  if (s.kind === 'uxp') {
    const enc = new TextEncoder().encode(payload);
    await s.secure.setItem(KEY, enc);
  } else if (s.kind === 'web') {
    localStorage.setItem(KEY, payload);
  } else {
    // kind === 'none' — refuse to persist. Surface the failure so the
    // caller can prompt for sign-in again rather than silently lose
    // the token on next reload.
    throw new Error('Token storage unavailable — secureStorage not reachable and insecure fallback disabled.');
  }
}

async function loadTokens() {
  const s = await getStorage();
  try {
    if (s.kind === 'uxp') {
      const raw = await s.secure.getItem(KEY);
      if (!raw) return null;
      const text = new TextDecoder().decode(raw);
      return JSON.parse(text);
    } else if (s.kind === 'web') {
      const text = localStorage.getItem(KEY);
      return text ? JSON.parse(text) : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function clearTokens() {
  const s = await getStorage();
  try {
    if (s.kind === 'uxp') {
      await s.secure.removeItem(KEY);
    } else if (s.kind === 'web') {
      localStorage.removeItem(KEY);
    }
    // kind === 'none' — nothing to clean.
  } catch { /* nothing to clean */ }
}

module.exports = { saveTokens, loadTokens, clearTokens };
