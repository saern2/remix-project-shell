export const TRUSTED_CLIENT_HEADER = "x-scene-smith-client";
export const TRUSTED_CLIENT_STORAGE_KEY = "scene_smith_trusted_client";

let memoryToken: string | null = null;

function createToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getOrCreateTrustedClientToken() {
  if (typeof window === "undefined") return null;
  if (memoryToken) return memoryToken;

  try {
    const stored = window.localStorage.getItem(TRUSTED_CLIENT_STORAGE_KEY);
    if (stored && /^[a-f0-9]{64}$/.test(stored)) {
      memoryToken = stored;
      return stored;
    }
  } catch {
    // The in-memory fallback still keeps retries idempotent for this page session.
  }

  memoryToken = createToken();
  try {
    window.localStorage.setItem(TRUSTED_CLIENT_STORAGE_KEY, memoryToken);
  } catch {
    // Storage can be disabled in hardened or embedded browsers.
  }
  return memoryToken;
}
