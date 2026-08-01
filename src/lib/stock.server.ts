import { CATEGORY_THEMES } from "@/lib/visual-queries.server";

export type StockVideoFile = { url: string; width: number; height: number };

export type StockVideo = {
  provider: "pexels" | "pixabay" | "nasa";
  provider_clip_id: string;
  duration_sec: number;
  duration_known?: boolean;
  width: number;
  height: number;
  thumbnail_url: string | null;
  files: StockVideoFile[];
};

export type Orientation = "landscape" | "portrait" | "square";
export type ProjectNiche = "general" | "space";

export interface StockProvider {
  readonly name: "pexels" | "pixabay";
  search(query: string, orientation: Orientation, page: number): Promise<StockVideo[]>;
}

const PEXELS_URL = "https://api.pexels.com/videos/search";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEEDED_TOP_CANDIDATES = 10;
const NASA_IN_POINT_BUCKET_SECONDS = 5;
const NASA_TAIL_MARGIN_SECONDS = 2;
const SPACE_THEME_TERMS = CATEGORY_THEMES.space;

type PoolKey = {
  id: string;
  api_key: string;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: string | null;
};

export async function rotatePexelsKeysForRequest(opts: {
  keys: Array<Pick<PoolKey, "id" | "api_key">>;
  request: (apiKey: string) => Promise<Response>;
  onDead: (id: string, response: Response) => Promise<void>;
  onRateLimited: (id: string, response: Response) => Promise<void>;
  onSuccess: (id: string, response: Response) => Promise<void>;
}): Promise<Response | null> {
  for (const key of opts.keys) {
    const response = await opts.request(key.api_key);
    if (response.status === 401 || response.status === 403) {
      await opts.onDead(key.id, response);
      continue;
    }
    if (response.status === 429) {
      await opts.onRateLimited(key.id, response);
      continue;
    }
    if (response.ok) await opts.onSuccess(key.id, response);
    return response;
  }
  return null;
}

type CachedSearch = { results: StockVideo[]; cachedAt: string };
type UsageCount = { requests: number; cacheHits: number };

export type StockSearchSession = {
  cache: Map<string, CachedSearch>;
  inflight: Map<string, Promise<StockVideo[]>>;
  pendingCache: Map<
    string,
    {
      provider: string;
      query: string;
      orientation: string;
      results: never;
      cached_at: string;
    }
  >;
  usage: Map<string, UsageCount>;
};

export type StockSearchOptions = {
  query: string;
  orientation: Orientation;
  minDurationSec: number;
  targetWidth: number;
  usedIds: string[];
  seed?: string;
  niche?: ProjectNiche | string | null;
  session?: StockSearchSession;
};

export type StockSearchResult = {
  pick: StockVideo;
  chosenFile: StockVideoFile;
  candidates: StockVideo[];
  inPoint: number;
  reservationKey: string;
};

function parsePexelsKeys(): string[] {
  return (process.env.PEXELS_API_KEYS ?? process.env.PEXELS_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function buildPexelsUrl(query: string, orientation: Orientation, page: number): string {
  const params = new URLSearchParams({
    query,
    orientation,
    per_page: "80",
    page: String(page),
  });
  return `${PEXELS_URL}?${params.toString()}`;
}

async function pexelsFetchFromEnv(
  query: string,
  orientation: Orientation,
  page: number,
): Promise<Response | null> {
  const keys = parsePexelsKeys();
  if (keys.length === 0) return null;
  const url = buildPexelsUrl(query, orientation, page);
  const firstIndex = seededIndex(`${query}:${orientation}:${page}`, keys.length);
  for (let offset = 0; offset < keys.length; offset++) {
    const key = keys[(firstIndex + offset) % keys.length];
    const res = await fetch(url, { headers: { authorization: key } });
    if (res.ok) return res;
    if ([401, 403, 429].includes(res.status) || res.status >= 500) continue;
    return res;
  }
  console.warn("[pexels-env] all configured keys are unavailable for this request");
  return null;
}

async function loadActivePoolKeys(): Promise<{ configured: boolean; keys: PoolKey[] }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("pexels_api_keys")
      .select("id, api_key, rate_limit_remaining, rate_limit_reset_at")
      .eq("is_active", true);
    if (error) {
      console.error("[pexels-pool] failed to load keys, falling back to env", error.message);
      return { configured: false, keys: [] };
    }
    const allKeys = (data ?? []) as PoolKey[];
    const now = Date.now();
    const keys = allKeys.filter((key) => {
      const resetAt = key.rate_limit_reset_at
        ? new Date(key.rate_limit_reset_at).getTime()
        : Number.NaN;
      const stillLimited = Number.isFinite(resetAt) && resetAt > now;
      if (stillLimited) return false;
      if (key.rate_limit_remaining == null || key.rate_limit_remaining >= 5) return true;
      return Number.isFinite(resetAt) && resetAt <= now;
    });
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    return { configured: allKeys.length > 0, keys };
  } catch (error) {
    console.error("[pexels-pool] pool lookup threw, falling back to env", error);
    return { configured: false, keys: [] };
  }
}

function pexelsResetAt(res: Response): string | null {
  const raw = res.headers.get("x-ratelimit-reset");
  if (!raw) return null;
  const epochSeconds = Number(raw);
  const date = Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000) : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function markKeyUsed(id: string, res: Response) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const remainingHeader = res.headers.get("x-ratelimit-remaining");
  const remaining = remainingHeader == null ? null : Number(remainingHeader);
  await supabaseAdmin.rpc("record_pexels_key_response", {
    p_id: id,
    p_remaining: remaining !== null && Number.isFinite(remaining) ? remaining : null,
    p_reset_at: pexelsResetAt(res),
  });
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

async function markKeyRateLimited(id: string, res: Response) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const resetAt = pexelsResetAt(res) ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from("pexels_api_keys")
    .update({
      rate_limit_remaining: 0,
      rate_limit_reset_at: resetAt,
      last_error: "Pexels rate limit reached; key will retry after reset",
      last_error_at: new Date().toISOString(),
    })
    .eq("id", id);
  console.info("[pexels-pool] rotated rate-limited key", { keyId: id, resetAt });
}

async function pexelsFetch(
  query: string,
  orientation: Orientation,
  page: number,
): Promise<Response | null> {
  const pool = await loadActivePoolKeys();
  if (!pool.configured) return pexelsFetchFromEnv(query, orientation, page);
  if (pool.keys.length === 0) {
    console.warn("[pexels-pool] every active key is inside its rate-limit window");
    return null;
  }
  const url = buildPexelsUrl(query, orientation, page);
  const response = await rotatePexelsKeysForRequest({
    keys: pool.keys,
    request: (apiKey) => fetch(url, { headers: { authorization: apiKey } }),
    onDead: (id, rejected) => markKeyDead(id, `Pexels rejected key (HTTP ${rejected.status})`),
    onRateLimited: markKeyRateLimited,
    onSuccess: markKeyUsed,
  });
  if (!response) console.warn("[pexels-pool] no database key could serve this request");
  return response;
}

export const pexelsProvider: StockProvider = {
  name: "pexels",
  async search(query, orientation, page) {
    const res = await pexelsFetch(query, orientation, page);
    if (!res) return [];
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      console.warn("[pexels] search request unavailable", {
        status: res.status,
        detail: detail.slice(0, 200),
      });
      return [];
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
    return (json.videos ?? []).map((video) => ({
      provider: "pexels" as const,
      provider_clip_id: String(video.id),
      duration_sec: video.duration,
      duration_known: true,
      width: video.width,
      height: video.height,
      thumbnail_url: video.image ?? null,
      files: (video.video_files ?? [])
        .filter((file) => file.link && file.width && file.height)
        .map((file) => ({ url: file.link, width: file.width, height: file.height })),
    }));
  },
};

export function getStockProvider(): StockProvider {
  return pexelsProvider;
}

export function orientationForAspect(aspect: string): Orientation {
  if (aspect === "portrait" || aspect === "9:16") return "portrait";
  if (aspect === "square" || aspect === "1:1") return "square";
  return "landscape";
}

export function targetWidthForAspect(aspect: string): number {
  if (aspect === "portrait" || aspect === "9:16") return 1080;
  if (aspect === "square" || aspect === "1:1") return 1080;
  return 1920;
}

export function providerFamilyKey(providerClipId: string): string {
  return providerClipId.trim();
}

export function stockReservationKey(
  provider: StockVideo["provider"],
  providerClipId: string,
  inPoint = 0,
): string {
  if (provider !== "nasa") return `${provider}:${providerClipId}`;
  return `${provider}:${providerClipId}:${Math.floor(inPoint / NASA_IN_POINT_BUCKET_SECONDS)}`;
}

export function reserveProviderClipId(usedIds: Set<string>, providerClipId: string): boolean {
  if (usedIds.has(providerClipId)) return false;
  usedIds.add(providerClipId);
  return true;
}

export async function createStockSearchSession(
  queries: string[],
  orientation: Orientation,
  niche?: string | null,
): Promise<StockSearchSession> {
  const session: StockSearchSession = {
    cache: new Map(),
    inflight: new Map(),
    pendingCache: new Map(),
    usage: new Map(),
  };
  const normalized = [...new Set(queries.map(normalizeStockQuery).filter(Boolean))];
  const nasaQueries =
    niche === "space"
      ? [...new Set(normalized.flatMap((query) => [query, nasaFallbackQuery(query)]))]
      : [];
  const pexelsQueries = niche === "space" ? normalized.map(spaceBiasedPexelsQuery) : normalized;
  await Promise.all([
    prefetchCacheRows(session, "pexels", orientation, pexelsQueries),
    prefetchCacheRows(session, "nasa", "any", nasaQueries),
  ]).catch((error) => {
    console.warn("[stock] cache prefetch unavailable; continuing with provider search", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return session;
}

export async function flushStockSearchSession(session: StockSearchSession): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rows = [...session.pendingCache.values()];
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("stock_search_cache").upsert(rows, {
      onConflict: "provider,query,orientation",
    });
    if (error) throw new Error(`Stock cache write failed: ${error.message}`);
  }
  const usageResults = await Promise.all(
    [...session.usage.entries()].map(([provider, counts]) =>
      supabaseAdmin.rpc("increment_provider_usage_counts", {
        p_provider: provider,
        p_date: new Date().toISOString().slice(0, 10),
        p_request_count: counts.requests,
        p_cache_hit_count: counts.cacheHits,
      }),
    ),
  );
  const usageError = usageResults.find((result) => result.error)?.error;
  if (usageError) console.warn("[stock] usage counter flush failed", usageError.message);
  session.pendingCache.clear();
  session.usage.clear();
}

export async function searchStockFootage(
  opts: StockSearchOptions,
): Promise<StockSearchResult | null> {
  const normQuery = normalizeStockQuery(opts.query);
  if (!normQuery) return null;
  if (opts.niche === "space") {
    const nasaQueries = [normQuery, nasaFallbackQuery(normQuery)].filter(
      (query, index, all) => all.indexOf(query) === index,
    );
    for (const nasaQuery of nasaQueries) {
      const result = await searchNasaWithCacheAndSelect({ ...opts, normQuery: nasaQuery });
      if (result) return result;
    }
    return searchPexelsWithCacheAndSelect({
      ...opts,
      normQuery: spaceBiasedPexelsQuery(normQuery),
    });
  }
  return searchPexelsWithCacheAndSelect({ ...opts, normQuery });
}

export async function searchUniqueStockFootage(
  opts: Omit<StockSearchOptions, "usedIds" | "seed"> & {
    usedIds: Set<string>;
    seed: string;
    maxAttempts?: number;
  },
  search: (
    searchOpts: StockSearchOptions,
  ) => Promise<StockSearchResult | null> = searchStockFootage,
): Promise<StockSearchResult | null> {
  const { usedIds, seed, maxAttempts = 8, ...searchOpts } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await search({
      ...searchOpts,
      usedIds: [...usedIds],
      seed: `${seed}:${attempt}`,
    });
    if (!result) return null;
    if (reserveProviderClipId(usedIds, result.reservationKey)) return result;
  }
  return null;
}

async function searchPexelsWithCacheAndSelect(
  opts: StockSearchOptions & { normQuery: string },
): Promise<StockSearchResult | null> {
  const results = await getCachedOrSearch({
    provider: "pexels",
    query: opts.normQuery,
    orientation: opts.orientation,
    session: opts.session,
    search: async () => {
      const first = await pexelsProvider.search(opts.normQuery, opts.orientation, 1);
      if (first.length === 0) return [];
      const second = await pexelsProvider.search(opts.normQuery, opts.orientation, 2);
      return dedupeVideos([...first, ...second]);
    },
  });
  return selectStockCandidate({ ...opts, results, requireMinDuration: false });
}

async function searchNasaWithCacheAndSelect(
  opts: StockSearchOptions & { normQuery: string },
): Promise<StockSearchResult | null> {
  const { searchNasaFootage } = await import("@/lib/nasaStock.server");
  const results = await getCachedOrSearch({
    provider: "nasa",
    query: opts.normQuery,
    orientation: "any",
    session: opts.session,
    search: () =>
      searchNasaFootage(opts.normQuery, { targetWidth: opts.targetWidth, seed: opts.seed }),
  }).catch((error) => {
    console.warn("[nasa-stock] search failed", {
      query: opts.normQuery,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  return selectStockCandidate({ ...opts, results, requireMinDuration: false });
}

async function getCachedOrSearch(opts: {
  provider: string;
  query: string;
  orientation: string;
  session?: StockSearchSession;
  search: () => Promise<StockVideo[]>;
}): Promise<StockVideo[]> {
  const key = cacheKey(opts.provider, opts.query, opts.orientation);
  let cached = opts.session?.cache.get(key) ?? null;
  if (!opts.session) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("stock_search_cache")
      .select("results, cached_at")
      .eq("provider", opts.provider)
      .eq("query", opts.query)
      .eq("orientation", opts.orientation)
      .maybeSingle();
    if (data) {
      cached = { results: data.results as unknown as StockVideo[], cachedAt: data.cached_at };
    }
  }
  const hasCurrentPexelsBreadth =
    opts.provider !== "pexels" || cached == null || cached.results.length > 20;
  if (
    cached &&
    hasCurrentPexelsBreadth &&
    Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS
  ) {
    await recordUsage(opts.provider, true, opts.session);
    return cached.results;
  }
  let searchPromise = opts.session?.inflight.get(key);
  const ownsSearch = !searchPromise;
  if (!searchPromise) {
    searchPromise = opts.search();
    opts.session?.inflight.set(key, searchPromise);
  }

  let results: StockVideo[];
  try {
    results = await searchPromise;
  } finally {
    opts.session?.inflight.delete(key);
  }
  if (ownsSearch) await recordUsage(opts.provider, false, opts.session);
  const row = {
    provider: opts.provider,
    query: opts.query,
    orientation: opts.orientation,
    results: results as unknown as never,
    cached_at: new Date().toISOString(),
  };
  if (opts.session) {
    opts.session.cache.set(key, { results, cachedAt: row.cached_at });
    opts.session.pendingCache.set(key, row);
  } else {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("stock_search_cache").upsert(row, {
      onConflict: "provider,query,orientation",
    });
  }
  return results;
}

async function prefetchCacheRows(
  session: StockSearchSession,
  provider: string,
  orientation: string,
  queries: string[],
) {
  if (queries.length === 0) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  for (let start = 0; start < queries.length; start += 75) {
    const { data, error } = await supabaseAdmin
      .from("stock_search_cache")
      .select("provider, query, orientation, results, cached_at")
      .eq("provider", provider)
      .eq("orientation", orientation)
      .in("query", queries.slice(start, start + 75));
    if (error) throw new Error(`Stock cache prefetch failed: ${error.message}`);
    for (const row of data ?? []) {
      session.cache.set(cacheKey(row.provider, row.query, row.orientation), {
        results: row.results as unknown as StockVideo[],
        cachedAt: row.cached_at,
      });
    }
  }
}

async function recordUsage(provider: string, cacheHit: boolean, session?: StockSearchSession) {
  if (session) {
    const counts = session.usage.get(provider) ?? { requests: 0, cacheHits: 0 };
    counts.requests += cacheHit ? 0 : 1;
    counts.cacheHits += cacheHit ? 1 : 0;
    session.usage.set(provider, counts);
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.rpc("increment_provider_usage", {
    p_provider: provider,
    p_date: new Date().toISOString().slice(0, 10),
    p_cache_hit: cacheHit,
  });
}

export function selectStockCandidate(opts: {
  results: StockVideo[] | null;
  minDurationSec: number;
  targetWidth: number;
  usedIds: string[];
  seed?: string;
  requireMinDuration?: boolean;
}): StockSearchResult | null {
  const { results } = opts;
  if (!results || results.length === 0) return null;
  const used = new Set(opts.usedIds);
  const eligible = results
    .map((video, index) => ({
      video,
      index,
      inPoint: nasaInPoint(video, opts.minDurationSec, opts.seed),
    }))
    .filter(({ video, inPoint }) => {
      const reservation = stockReservationKey(video.provider, video.provider_clip_id, inPoint);
      if (video.files.length === 0 || used.has(reservation)) return false;
      return video.provider === "nasa" || !used.has(video.provider_clip_id);
    });
  if (eligible.length === 0) return null;
  const longEnough = eligible.filter(
    ({ video }) => video.duration_sec >= opts.minDurationSec || video.duration_known === false,
  );
  if (opts.requireMinDuration && longEnough.length === 0) return null;
  const candidateMeta = longEnough.length > 0 ? longEnough : eligible;
  const top = [...candidateMeta].sort((a, b) => a.index - b.index).slice(0, SEEDED_TOP_CANDIDATES);
  const selected = top[seededIndex(`${opts.seed ?? "stock"}:candidate`, top.length)];
  const pick = selected.video;
  const sortedFiles = [...pick.files].sort((a, b) => a.width - b.width);
  let chosenFile = sortedFiles.find((file) => file.width >= opts.targetWidth);
  if (!chosenFile) chosenFile = sortedFiles[sortedFiles.length - 1];
  return {
    pick,
    chosenFile,
    candidates: candidateMeta.map(({ video }) => video),
    inPoint: selected.inPoint,
    reservationKey: stockReservationKey(pick.provider, pick.provider_clip_id, selected.inPoint),
  };
}

function nasaInPoint(video: StockVideo, requiredDuration: number, seed?: string): number {
  if (video.provider !== "nasa" || video.duration_known === false) return 0;
  const usableStart = video.duration_sec - requiredDuration - NASA_TAIL_MARGIN_SECONDS;
  if (usableStart < NASA_IN_POINT_BUCKET_SECONDS) return 0;
  const buckets = Math.floor(usableStart / NASA_IN_POINT_BUCKET_SECONDS) + 1;
  return (
    seededIndex(`${seed ?? "nasa"}:${video.provider_clip_id}:in-point`, buckets) *
    NASA_IN_POINT_BUCKET_SECONDS
  );
}

function normalizeStockQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function spaceBiasedPexelsQuery(query: string): string {
  return normalizeStockQuery(`${query} ${SPACE_THEME_TERMS}`);
}

function nasaFallbackQuery(query: string): string {
  if (/\b(planet|world|solar|orbit|star)\b/.test(query)) return "planet solar system";
  if (/\b(galaxy|milky|deep space|cosmic)\b/.test(query)) return "deep space galaxy";
  if (/\b(astronaut|rocket|launch|spacecraft|telescope)\b/.test(query)) {
    return "space mission science";
  }
  return "space astronomy";
}

function cacheKey(provider: string, query: string, orientation: string): string {
  return `${provider}\u0000${query}\u0000${orientation}`;
}

function dedupeVideos(videos: StockVideo[]): StockVideo[] {
  const seen = new Set<string>();
  return videos.filter((video) => {
    const key = `${video.provider}:${video.provider_clip_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
