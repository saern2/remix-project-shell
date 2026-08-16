/**
 * Where the voice model actually comes from: our Cloudflare R2 bucket.
 *
 * WHY. MEASURED 2026-08-15 (capture 69): Hugging Face serves the 325.5 MB
 * model from a US-region bridge marked cache-control: no-store — one
 * transatlantic TCP stream at 0.96 MB/s, 5m37s of first-load wait. The same
 * client moves 9-15 MB/s to CDN-served endpoints. R2 serves the identical
 * bytes from Cloudflare's edge with zero egress cost at any volume.
 *
 * NO SILENT FALLBACK, BY CONSTRUCTION. Overriding env.remoteHost REPLACES the
 * only remote source transformers.js has — hub.js builds exactly one URL from
 * it and throws on any non-200, with our URL in the error. The string
 * "huggingface.co" survives in this codebase in exactly one place: the cache
 * KEY below, because kokoro-js hardcodes that URL as the voice loader's cache
 * lookup — the key names where kokoro LOOKS, never where bytes come FROM.
 * A failed R2 fetch is a thrown, plainly-worded error. The eleven silent days
 * of the Pexels outage are the class this design excludes.
 */

/**
 * The R2 public base URL — THE single place it exists. The bucket layout
 * mirrors the Hugging Face path shape ({model}/{revision}/...), uploaded by
 * hand from the V5 manifest, model.onnx verified at 325,532,232 bytes.
 *
 * OPEN ITEM (ledger): r2.dev URLs are documented by Cloudflare as
 * rate-limited and not intended for production. Fine at 10-20 clients;
 * before the product goes public, attach a custom domain to the bucket and
 * change this constant — one edit.
 *
 * CORS LIVES IN THE CLOUDFLARE DASHBOARD, NOT HERE: the bucket's policy
 * allows the production and preview Lovable origins, GET + HEAD. WHEN THE
 * APP'S DOMAIN CHANGES, THAT POLICY MUST BE UPDATED FIRST — a stale origin
 * list fails the model fetch with a CORS error that names neither the bucket
 * nor the real cause, and looks like nothing else in this app's failures.
 */
export const TTS_MODEL_BASE_URL = "https://pub-42a1fa5fb300434c9a06eaf5b7966394.r2.dev/";

/**
 * Every voice file in the bucket is exactly this long (verified against the
 * files kokoro-js ships). The seeding refuses anything else: a truncated or
 * substituted voice must fail loudly here, not produce garbled speech later.
 */
export const VOICE_BIN_BYTES = 522_240;

/**
 * The exact URL prefix kokoro-js hardcodes for voice fetches. Used ONLY as
 * the cache key its loader matches against — see seedVoiceCache.
 */
const KOKORO_VOICE_CACHE_KEY_PREFIX =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/";

/** The bucket path for the same voice — where the bytes actually come from. */
const R2_VOICE_URL_PREFIX = `${TTS_MODEL_BASE_URL}onnx-community/Kokoro-82M-v1.0-ONNX/main/voices/`;

/** The slice of transformers.js env this module configures. */
type TransformersEnv = { remoteHost: string; remotePathTemplate: string };

/**
 * Points transformers.js at the bucket. Called inside loadEngine BEFORE
 * from_pretrained, so config, tokenizer and the model all resolve to R2.
 * The browser's transformers-cache keys on the resolved URL, so per-browser
 * once-only caching works exactly as it did against Hugging Face.
 */
export function configureModelHost(env: TransformersEnv): void {
  env.remoteHost = TTS_MODEL_BASE_URL;
  env.remotePathTemplate = "{model}/{revision}/";
}

/** Voices already seeded this session — repeat generates skip everything. */
const seededVoices = new Set<string>();

/**
 * Test seam: forget which voices this session seeded, so failure paths can
 * be exercised more than once.
 */
export function resetSeededVoices(): void {
  seededVoices.clear();
}

/**
 * Puts a voice's bytes where kokoro-js will look for them, sourced from R2.
 *
 * kokoro-js's voice loader checks caches.open("kokoro-voices") for its
 * hardcoded huggingface.co URL BEFORE fetching it. Seeding that cache from
 * the bucket means the lookup always hits and the hardcoded fetch never runs.
 *
 * ON THE CRITICAL PATH, AND IT THROWS. This function runs before every
 * generation (loadEngine's wrapper awaits it ahead of the model call), and
 * every failure — no Cache API, a failed or non-200 fetch, a wrong byte
 * length, a rejected cache.put — aborts with a plain sentence. Proceeding
 * past a failed seed is what would let kokoro-js silently fall back to
 * Hugging Face and "work": the exact invisibility class that hid the Pexels
 * outage for eleven days. There is deliberately no catch-and-continue here.
 */
export async function seedVoiceCache(
  voice: string,
  deps: { fetchImpl?: typeof fetch; cacheStorage?: CacheStorage } = {},
): Promise<void> {
  if (seededVoices.has(voice)) return;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const cacheStorage = deps.cacheStorage ?? (typeof caches !== "undefined" ? caches : undefined);
  const fail = (detail: string): never => {
    throw new Error(
      `The narrator's voice could not be downloaded. Please try again in a moment. (internal: ${detail})`,
    );
  };

  // No Cache API means the no-fallback guarantee cannot be given, so the
  // feature stops here rather than degrading to a third-party fetch.
  if (!cacheStorage) fail("Cache API unavailable in this browser context");

  const cache = await cacheStorage!.open("kokoro-voices");
  const cacheKey = `${KOKORO_VOICE_CACHE_KEY_PREFIX}${voice}.bin`;
  const already = await cache.match(cacheKey);
  if (already) {
    seededVoices.add(voice);
    return;
  }

  let response: Response;
  try {
    response = await fetchImpl(`${R2_VOICE_URL_PREFIX}${voice}.bin`);
  } catch (err) {
    return fail(`voice fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) return fail(`voice fetch returned HTTP ${response.status}`);

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== VOICE_BIN_BYTES) {
    return fail(`voice file was ${bytes.byteLength} bytes, expected ${VOICE_BIN_BYTES}`);
  }

  try {
    await cache.put(cacheKey, new Response(bytes));
  } catch (err) {
    return fail(`voice cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  seededVoices.add(voice);
}
