// Stock footage provider interface + Pexels implementation.
// Server-only: PEXELS_API_KEYS never touches the client.

export type StockVideoFile = {
  url: string;
  width: number;
  height: number;
};

export type StockVideo = {
  provider: "pexels" | "pixabay" | "nasa";
  provider_clip_id: string;
  duration_sec: number;
  width: number;
  height: number;
  thumbnail_url: string | null;
  files: StockVideoFile[];
};

export type Orientation = "landscape" | "portrait" | "square";

export interface StockProvider {
  readonly name: "pexels" | "pixabay";
  search(query: string, orientation: Orientation, page: number): Promise<StockVideo[]>;
}

const PEXELS_URL = "https://api.pexels.com/videos/search";

function parsePexelsKeys(): string[] {
  const raw = process.env.PEXELS_API_KEYS ?? process.env.PEXELS_API_KEY ?? "";
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) {
    throw new Error(
      "PEXELS_API_KEYS is not configured or parsed to zero keys. Set PEXELS_API_KEYS to a comma-separated list of Pexels API keys.",
    );
  }
  return keys;
}

function buildPexelsUrl(query: string, orientation: Orientation, page: number): string {
  const params = new URLSearchParams({
    query,
    orientation,
    per_page: "20",
    page: String(page),
  });
  return `${PEXELS_URL}?${params.toString()}`;
}

/**
 * Legacy env-var key path. UNCHANGED behaviour — this is the fallback used
 * whenever the pexels_api_keys pool is empty (e.g. before any CSV upload).
 */
async function pexelsFetchFromEnv(
  query: string,
  orientation: Orientation,
  page: number,
): Promise<Response> {
  const keys = parsePexelsKeys();
  const url = buildPexelsUrl(query, orientation, page);

  const firstIdx = Math.floor(Math.random() * keys.length);
  const firstKey = keys[firstIdx];
  const res = await fetch(url, { headers: { authorization: firstKey } });
  if (res.status !== 401) return res;

  if (keys.length > 1) {
    const remaining = keys.filter((_, i) => i !== firstIdx);
    const retryKey = remaining[Math.floor(Math.random() * remaining.length)];
    const retry = await fetch(url, { headers: { authorization: retryKey } });
    if (retry.status !== 401) return retry;
    const detail = await retry.text().catch(() => retry.statusText);
    throw new Error(
      `Pexels search failed (401) after trying 2 of ${keys.length} keys: ${detail.slice(0, 200)}`,
    );
  }

  const detail = await res.text().catch(() => res.statusText);
  throw new Error(
    `Pexels search failed (401) after trying 1 of ${keys.length} keys: ${detail.slice(0, 200)}`,
  );
}

type PoolKey = { id: string; api_key: string };

async function loadActivePoolKeys(): Promise<PoolKey[]> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("pexels_api_keys")
      .select("id, api_key")
      .eq("is_active", true);
    if (error) {
      console.error("[pexels-pool] failed to load keys, falling back to env:", error.message);
      return [];
    }
    const keys = (data ?? []) as PoolKey[];
    // Random order.
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    return keys;
  } catch (e) {
    console.error("[pexels-pool] pool lookup threw, falling back to env:", e);
    return [];
  }
}

async function markKeyUsed(id: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.rpc("increment_pexels_key_usage", { p_id: id });
}

async function markKeyDead(id: string, message: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("pexels_api_keys")
    .update({
      is_active: false,
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
    })
    .eq("id", id);
}

async function pexelsFetch(
  query: string,
  orientation: Orientation,
  page: number,
): Promise<Response> {
  const pool = await loadActivePoolKeys();
  // CRITICAL: empty pool -> behave exactly as before, using env-var keys.
  if (pool.length === 0) return pexelsFetchFromEnv(query, orientation, page);

  const url = buildPexelsUrl(query, orientation, page);
  let lastAuthError = "";

  // Try up to 2 pool keys (initial + one retry) on 401/403.
  for (const key of pool.slice(0, 2)) {
    const res = await fetch(url, { headers: { authorization: key.api_key } });
    if (res.status === 401 || res.status === 403) {
      lastAuthError = `Pexels rejected key (HTTP ${res.status})`;
      await markKeyDead(key.id, lastAuthError);
      continue;
    }
    if (res.ok) await markKeyUsed(key.id);
    return res;
  }

  // Every attempted pool key was rejected — last resort: env keys.
  console.error(`[pexels-pool] ${lastAuthError}; falling back to env keys`);
  return pexelsFetchFromEnv(query, orientation, page);
}

export const pexelsProvider: StockProvider = {
  name: "pexels",
  async search(query, orientation, page) {
    const res = await pexelsFetch(query, orientation, page);
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Pexels search failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      videos?: Array<{
        id: number;
        width: number;
        height: number;
        duration: number;
        image?: string;
        video_files?: Array<{ link: string; width: number; height: number }>;
      }>;
    };
    return (json.videos ?? []).map((v) => ({
      provider: "pexels" as const,
      provider_clip_id: String(v.id),
      duration_sec: v.duration,
      width: v.width,
      height: v.height,
      thumbnail_url: v.image ?? null,
      files: (v.video_files ?? [])
        .filter((f) => f.link && f.width && f.height)
        .map((f) => ({ url: f.link, width: f.width, height: f.height })),
    }));
  },
};

export function getStockProvider(): StockProvider {
  return pexelsProvider;
}

export function orientationForAspect(aspect: string): Orientation {
  if (aspect === "portrait" || aspect === "9:16") return "portrait";
  if (aspect === "square" || aspect === "1:1") return "square";
  return "landscape"; // 'landscape' | '16:9' | anything else
}

export function targetWidthForAspect(aspect: string): number {
  if (aspect === "portrait" || aspect === "9:16") return 1080;
  if (aspect === "square" || aspect === "1:1") return 1080;
  return 1920; // 'landscape' | '16:9' | anything else
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededIndex(seed: string | undefined, modulo: number): number {
  if (modulo <= 1) return 0;
  if (!seed) return Math.floor(Math.random() * modulo);
  return stableHash(seed) % modulo;
}

export type ProjectNiche = "general" | "space";

export function providerFamilyKey(providerClipId: string): string {
  const id = providerClipId.trim();
  return /^\d{6,}$/.test(id) ? id.slice(0, 4) : id;
}

function stableCandidateScore(
  video: StockVideo,
  originalIndex: number,
  minDurationSec: number,
  seed: string | undefined,
): number {
  const durationSlack = Math.max(0, video.duration_sec - minDurationSec);
  const durationBonus = Math.min(durationSlack, 20) / 100;
  const seedJitter = stableHash(`${seed ?? "stock"}:${video.provider_clip_id}`) / 0xffffffff / 1000;
  return originalIndex - durationBonus + seedJitter;
}

/**
 * Search stock footage, dedup against usedIds, filter by minimum duration
 * (with fallback), and pick deterministically by relevance/diversity. Selects the
 * video_file whose width is closest to targetWidth. Uses 24h response cache
 * keyed by (provider, normalized query, orientation) and increments
 * provider_usage on real (non-cached) calls.
 */
export async function searchStockFootage(opts: {
  query: string;
  orientation: Orientation;
  minDurationSec: number;
  targetWidth: number;
  usedIds: string[];
  seed?: string;
  niche?: ProjectNiche | string | null;
}): Promise<{ pick: StockVideo; chosenFile: StockVideoFile; candidates: StockVideo[] } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const provider = getStockProvider();
  const normQuery = opts.query.trim().toLowerCase();
  if (!normQuery) return null;

  if (opts.niche === "space") {
    const nasaResult = await searchNasaWithCacheAndSelect({
      normQuery,
      minDurationSec: opts.minDurationSec,
      targetWidth: opts.targetWidth,
      usedIds: opts.usedIds,
      seed: opts.seed,
    });
    if (nasaResult) return nasaResult;
  }

  // 1. Cache lookup
  const { data: cached } = await supabaseAdmin
    .from("stock_search_cache")
    .select("results, cached_at")
    .eq("provider", provider.name)
    .eq("query", normQuery)
    .eq("orientation", opts.orientation)
    .maybeSingle();

  let results: StockVideo[] | null = null;
  const fresh = cached && Date.now() - new Date(cached.cached_at).getTime() < CACHE_TTL_MS;
  if (fresh) {
    results = cached!.results as unknown as StockVideo[];
    await bumpUsage(provider.name, { cache_hit: true });
  } else {
    // 2. Fresh call — random page 1..3 for variety
    const page = 1 + seededIndex(opts.seed ? `${opts.seed}:page` : undefined, 3);
    results = await provider.search(normQuery, opts.orientation, page);
    await bumpUsage(provider.name, { cache_hit: false });
    // Upsert cache
    await supabaseAdmin.from("stock_search_cache").upsert(
      {
        provider: provider.name,
        query: normQuery,
        orientation: opts.orientation,
        results: results as unknown as never,
        cached_at: new Date().toISOString(),
      },
      { onConflict: "provider,query,orientation" },
    );
  }

  if (!results || results.length === 0) return null;

  // 3. Dedup against exact clips and nearby Pexels series/families. Exact IDs
  // prevent literal repeats; family IDs reduce visually similar clips from the
  // same stock shoot when a theme produces broad repeated searches.
  const used = new Set(opts.usedIds);
  const usedFamilies = new Set(opts.usedIds.map(providerFamilyKey));
  let pool = results.filter(
    (v) =>
      !used.has(v.provider_clip_id) &&
      !usedFamilies.has(providerFamilyKey(v.provider_clip_id)) &&
      v.files.length > 0,
  );
  if (pool.length === 0) {
    pool = results.filter((v) => !used.has(v.provider_clip_id) && v.files.length > 0);
  }
  if (pool.length === 0) pool = results.filter((v) => v.files.length > 0);
  if (pool.length === 0) return null;

  // 4. Duration filter, with full-pool fallback
  const longEnough = pool.filter((v) => v.duration_sec >= opts.minDurationSec);
  const candidates = longEnough.length > 0 ? longEnough : pool;

  // 5. Stable relevance pick. Provider order is already relevance-weighted, so
  // index dominates; duration and seed only break close choices consistently.
  const pick = candidates
    .map((video) => ({
      video,
      index: results!.findIndex((result) => result.provider_clip_id === video.provider_clip_id),
    }))
    .sort(
      (a, b) =>
        stableCandidateScore(a.video, a.index, opts.minDurationSec, opts.seed) -
        stableCandidateScore(b.video, b.index, opts.minDurationSec, opts.seed),
    )[0].video;

  // 6. Choose smallest file >= targetWidth, fallback to largest if all smaller
  const sortedFiles = [...pick.files].sort((a, b) => a.width - b.width);
  let chosenFile = sortedFiles.find((f) => f.width >= opts.targetWidth);
  if (!chosenFile) chosenFile = sortedFiles[sortedFiles.length - 1];

  return { pick, chosenFile, candidates };
}

async function bumpUsage(provider: string, opts: { cache_hit: boolean }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.rpc("increment_provider_usage", {
    p_provider: provider,
    p_date: new Date().toISOString().slice(0, 10),
    p_cache_hit: opts.cache_hit,
  });
}

async function searchNasaWithCacheAndSelect(opts: {
  normQuery: string;
  minDurationSec: number;
  targetWidth: number;
  usedIds: string[];
  seed?: string;
}): Promise<{ pick: StockVideo; chosenFile: StockVideoFile; candidates: StockVideo[] } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { searchNasaFootage } = await import("@/lib/nasaStock.server");
  const provider = "nasa";
  const cacheOrientation = "any";

  let results: StockVideo[] | null = null;
  const { data: cached } = await supabaseAdmin
    .from("stock_search_cache")
    .select("results, cached_at")
    .eq("provider", provider)
    .eq("query", opts.normQuery)
    .eq("orientation", cacheOrientation)
    .maybeSingle();

  const fresh = cached && Date.now() - new Date(cached.cached_at).getTime() < CACHE_TTL_MS;
  if (fresh) {
    results = cached!.results as unknown as StockVideo[];
    await bumpUsage(provider, { cache_hit: true });
  } else {
    try {
      results = await searchNasaFootage(opts.normQuery, { targetWidth: opts.targetWidth });
      await bumpUsage(provider, { cache_hit: false });
      await supabaseAdmin.from("stock_search_cache").upsert(
        {
          provider,
          query: opts.normQuery,
          orientation: cacheOrientation,
          results: results as unknown as never,
          cached_at: new Date().toISOString(),
        },
        { onConflict: "provider,query,orientation" },
      );
    } catch (error) {
      console.warn("[nasa-stock] search failed; falling back to default stock provider", {
        query: opts.normQuery,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return selectStockCandidate({
    results,
    minDurationSec: opts.minDurationSec,
    targetWidth: opts.targetWidth,
    usedIds: opts.usedIds,
    seed: opts.seed,
    requireMinDuration: true,
  });
}

function selectStockCandidate(opts: {
  results: StockVideo[] | null;
  minDurationSec: number;
  targetWidth: number;
  usedIds: string[];
  seed?: string;
  requireMinDuration?: boolean;
}): { pick: StockVideo; chosenFile: StockVideoFile; candidates: StockVideo[] } | null {
  const { results } = opts;
  if (!results || results.length === 0) return null;

  const used = new Set(opts.usedIds);
  const usedFamilies = new Set(opts.usedIds.map(providerFamilyKey));
  let pool = results.filter(
    (v) =>
      !used.has(v.provider_clip_id) &&
      !usedFamilies.has(providerFamilyKey(v.provider_clip_id)) &&
      v.files.length > 0,
  );
  if (pool.length === 0) {
    pool = results.filter((v) => !used.has(v.provider_clip_id) && v.files.length > 0);
  }
  if (pool.length === 0) pool = results.filter((v) => v.files.length > 0);
  if (pool.length === 0) return null;

  const longEnough = pool.filter((v) => v.duration_sec >= opts.minDurationSec);
  if (opts.requireMinDuration && longEnough.length === 0) return null;
  const candidates = longEnough.length > 0 ? longEnough : pool;

  const pick = candidates
    .map((video) => ({
      video,
      index: results.findIndex((result) => result.provider_clip_id === video.provider_clip_id),
    }))
    .sort(
      (a, b) =>
        stableCandidateScore(a.video, a.index, opts.minDurationSec, opts.seed) -
        stableCandidateScore(b.video, b.index, opts.minDurationSec, opts.seed),
    )[0].video;

  const sortedFiles = [...pick.files].sort((a, b) => a.width - b.width);
  let chosenFile = sortedFiles.find((f) => f.width >= opts.targetWidth);
  if (!chosenFile) chosenFile = sortedFiles[sortedFiles.length - 1];

  return { pick, chosenFile, candidates };
}
