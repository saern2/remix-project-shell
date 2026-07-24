// Stock footage provider interface + Pexels implementation.
// Server-only: PEXELS_API_KEYS never touches the client.

export type StockVideoFile = {
  url: string;
  width: number;
  height: number;
};

export type StockVideo = {
  provider: "pexels" | "pixabay";
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

async function pexelsFetch(query: string, orientation: Orientation, page: number): Promise<Response> {
  const keys = parsePexelsKeys();
  const params = new URLSearchParams({
    query,
    orientation,
    per_page: "20",
    page: String(page),
  });
  const url = `${PEXELS_URL}?${params.toString()}`;

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
  if (aspect === "9:16") return "portrait";
  if (aspect === "1:1") return "square";
  return "landscape"; // 16:9
}

export function targetWidthForAspect(aspect: string): number {
  if (aspect === "9:16") return 1080;
  if (aspect === "1:1") return 1080;
  return 1920; // 16:9
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Search stock footage, dedup against usedIds, filter by minimum duration
 * (with fallback), and randomly pick from the top candidates. Selects the
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
}): Promise<{ pick: StockVideo; chosenFile: StockVideoFile; candidates: StockVideo[] } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const provider = getStockProvider();
  const normQuery = opts.query.trim().toLowerCase();
  if (!normQuery) return null;

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
    const page = 1 + Math.floor(Math.random() * 3);
    results = await provider.search(normQuery, opts.orientation, page);
    await bumpUsage(provider.name, { cache_hit: false });
    // Upsert cache
    await supabaseAdmin
      .from("stock_search_cache")
      .upsert(
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

  // 3. Dedup against usedIds
  const used = new Set(opts.usedIds);
  let pool = results.filter((v) => !used.has(v.provider_clip_id) && v.files.length > 0);
  if (pool.length === 0) pool = results.filter((v) => v.files.length > 0);
  if (pool.length === 0) return null;

  // 4. Duration filter, with full-pool fallback
  const longEnough = pool.filter((v) => v.duration_sec >= opts.minDurationSec);
  const candidates = longEnough.length > 0 ? longEnough : pool;

  // 5. Random pick from top 5 for variety
  const topN = candidates.slice(0, Math.min(5, candidates.length));
  const pick = topN[Math.floor(Math.random() * topN.length)];

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
