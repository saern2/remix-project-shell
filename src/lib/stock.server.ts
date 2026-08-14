import { CATEGORY_THEMES } from "@/lib/visual-queries.server";
import type { MatchingProfile } from "@/lib/matching-profile";

export type StockVideoFile = {
  url: string;
  width: number;
  height: number;
  /**
   * Byte size, when the provider volunteers it. Pixabay does (per rendition);
   * Pexels and NASA do not. Undefined means unknown, never "unlimited" — the
   * worker's Content-Length pre-check remains the authority.
   */
  bytes?: number;
};

export type StockVideo = {
  provider: "pexels" | "pixabay" | "nasa";
  provider_clip_id: string;
  duration_sec: number;
  duration_known?: boolean;
  width: number;
  height: number;
  thumbnail_url: string | null;
  files: StockVideoFile[];
  title?: string;
  description?: string;
  keywords?: string[];
  has_captions?: boolean;
};

export type Orientation = "landscape" | "portrait" | "square";
export type ProjectNiche = "general" | "space";

export interface StockProvider {
  readonly name: "pexels" | "pixabay";
  search(
    query: string,
    orientation: Orientation,
    page: number,
    session?: StockSearchSession,
  ): Promise<StockVideo[]>;
}

const PEXELS_URL = "https://api.pexels.com/videos/search";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEEDED_TOP_CANDIDATES = 10;
const NASA_IN_POINT_BUCKET_SECONDS = 5;

// Round 6, Issue 1 / 2b: a scene needs only a few seconds of footage, but the
// stock APIs expose no file size — only width/height/duration. File size is
// dominated by duration, so a multi-minute source for a five-second scene is the
// 986 MB download. Prefer sources whose duration is within a budget of what the
// scene needs, falling back to longer clips only when no shorter candidate exists.
// This composes with the worker's hard MAX_CLIP_BYTES ceiling: selection avoids
// oversized clips; the worker rejects any that still slip through.
const SOURCE_DURATION_BUDGET_MULTIPLE = 6;
const MIN_SOURCE_DURATION_BUDGET_SEC = 30;

export function sourceDurationBudgetSeconds(minDurationSec: number): number {
  return Math.max(minDurationSec * SOURCE_DURATION_BUDGET_MULTIPLE, MIN_SOURCE_DURATION_BUDGET_SEC);
}

/**
 * Lower bound on a source: does it actually contain as much footage as the
 * scene needs? A source that fails this still *renders* — tpad clones the last
 * frame to fill the slot — so the failure mode is a silent freeze frame rather
 * than an error, which is why selection has to care.
 *
 * Unknown-duration NASA assets pass: their length is genuinely unknown rather
 * than known-to-be-short, and buildNasaSourceWindows pins them to in-point 0 so
 * the whole asset is available.
 */
export function meetsMinimumSourceDuration(video: StockVideo, minDurationSec: number): boolean {
  if (video.duration_known === false) return true;
  return video.duration_sec >= minDurationSec;
}

/**
 * Byte ceiling for a single source clip. MUST mirror the worker's
 * MAX_CLIP_BYTES — the worker rejects anything above it on the Content-Length
 * pre-check, so a selection that ignores this is choosing a guaranteed failure.
 *
 * Round 7: a 235,132,958-byte Pixabay rendition was selected against the
 * worker's 150 MB limit and burned the chunk's first attempt every time it was
 * drawn. The round-6 budget bounds DURATION, which does not bound bytes: that
 * clip was short enough to pass and still far too large.
 */
export function maxClipBytes(): number {
  const configured = Number(process.env.MAX_CLIP_BYTES ?? 157_286_400);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 157_286_400;
}

/** A file is oversized only when its size is KNOWN to exceed the ceiling. */
export function isOversizedFile(file: StockVideoFile, ceilingBytes = maxClipBytes()): boolean {
  return typeof file.bytes === "number" && file.bytes > ceilingBytes;
}

/**
 * Picks the rendition to download: the smallest that still meets the target
 * width, skipping any whose size is known to exceed the ceiling.
 *
 * Falling back deliberately prefers a SMALLER-than-target file over a
 * known-oversized one — a slightly soft clip renders, a rejected download does
 * not. When nothing has a known size (Pexels, NASA) this behaves exactly as
 * before, and the worker's pre-check stays the backstop.
 */
export function selectRenditionForTarget(
  files: StockVideoFile[],
  targetWidth: number,
  ceilingBytes = maxClipBytes(),
): StockVideoFile | null {
  if (files.length === 0) return null;
  const ascending = [...files].sort((a, b) => a.width - b.width);
  const affordable = ascending.filter((file) => !isOversizedFile(file, ceilingBytes));
  // Every rendition is known to be too large: take the SMALLEST rather than the
  // one matching the target. The download will likely be rejected either way, so
  // prefer the one most likely to squeak under a slightly different real
  // Content-Length, and cheapest to reject if not.
  if (affordable.length === 0) return ascending[0];
  return affordable.find((file) => file.width >= targetWidth) ?? affordable[affordable.length - 1];
}

/**
 * Renditions of the same source the worker may fall back to, best-first.
 *
 * Only smaller renditions, and only ones not already known to be oversized:
 * falling "up" would re-hit the same ceiling. Same source throughout, so a
 * fallback swaps the file and never the footage — which is what keeps clip
 * uniqueness and scene relevance intact without a round trip to the matcher.
 */
export function fallbackRenditions(
  files: StockVideoFile[],
  chosen: StockVideoFile,
  ceilingBytes = maxClipBytes(),
): string[] {
  return [...files]
    .filter((file) => file.url !== chosen.url && file.width <= chosen.width)
    .filter((file) => !isOversizedFile(file, ceilingBytes))
    .sort((a, b) => b.width - a.width)
    .map((file) => file.url);
}

export function withinSourceDurationBudget(video: StockVideo, minDurationSec: number): boolean {
  // Unknown duration (e.g. some NASA assets) is not penalised — the NASA source
  // window logic already bounds how much of it is used.
  if (video.duration_known === false) return true;
  return video.duration_sec <= sourceDurationBudgetSeconds(minDurationSec);
}

const SPACE_THEME_TERMS = CATEGORY_THEMES.space;

export type PoolKey = {
  id: string;
  api_key: string;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: string | null;
};

export class PexelsPoolDegradedError extends Error {
  constructor(
    readonly rejected: number,
    readonly initial: number,
  ) {
    super(`Pexels key pool degraded: ${rejected} of ${initial} keys rejected mid-run`);
    this.name = "PexelsPoolDegradedError";
  }
}

export class StockRequestBudgetExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Stock provider request budget exceeded (${limit} Pexels requests per project).`);
    this.name = "StockRequestBudgetExceededError";
  }
}

export type PexelsStagePool = {
  configured: boolean;
  keys: PoolKey[];
  initialCount: number;
  rejectedIds: Set<string>;
  unavailableIds: Set<string>;
  deactivationPromises: Map<string, Promise<void>>;
  requestCount: number;
  requestLimit: number;
  /**
   * Where the next request starts its key walk. Advanced once per call,
   * synchronously at entry, so CONCURRENT calls fan out across the pool
   * instead of all landing on keys[0], exhausting it together, and then
   * moving to keys[1] together. That collision costs budget as well as time:
   * every attempted key consumes a requestCount, so N calls colliding on one
   * rate-limited key burn N counts to discover the same fact once.
   */
  cursor: number;
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

export type NasaRequestMetrics = {
  searchRequests: number;
  assetCalls: number;
  metadataCalls: number;
  metadataJsonFetches: number;
  captionCalls: number;
  assetCacheHits: number;
  assetCacheMisses: number;
};

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
  /**
   * Cache keys already looked up in stock_search_cache during this session,
   * including misses. Successive slices cluster into overlapping query buckets,
   * so without this the same rows are re-read once per slice.
   */
  prefetched?: Set<string>;
  pexelsPool: PexelsStagePool;
  nasaMetrics?: NasaRequestMetrics;
  /** Optional timing instrumentation (round 6 profiling). Measurement only. */
  profile?: MatchingProfile;
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
  /**
   * Smaller renditions of the SAME source, best-first, for the worker to fall
   * back to when the chosen one is rejected as oversized. Same footage, same
   * provider_clip_id — so a fallback changes the file, never the shot, and
   * cannot disturb clip uniqueness.
   */
  fallbackUrls: string[];
  /**
   * Which selection tier produced this. "unique" is the norm; the others record
   * a deliberate, logged degradation rather than a failure.
   */
  tier?: "unique" | "alternate-window" | "distant-reuse" | "last-resort";
};

function parsePexelsKeys(): string[] {
  return (process.env.PEXELS_API_KEYS ?? process.env.PEXELS_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

/**
 * Results asked of Pexels per page. Exported because the page-2 skip in
 * searchTwoPages is only sound while it matches what the request asks for.
 */
export const PEXELS_PAGE_SIZE = 80;

function buildPexelsUrl(query: string, orientation: Orientation, page: number): string {
  const params = new URLSearchParams({
    query,
    orientation,
    per_page: String(PEXELS_PAGE_SIZE),
    page: String(page),
  });
  return `${PEXELS_URL}?${params.toString()}`;
}

/**
 * Page 1, and page 2 only when page 1 could have a successor.
 *
 * MEASURED 2026-08-13 over 15,058 cached Pexels rows: 5,296 had a non-empty
 * page 1 and so fetched page 2, but only 466 reached a full first page. That is
 * 4,830 guaranteed-empty round trips — 91% of the page-2 fetches Pexels makes,
 * one wasted HTTP call for every three Pexels searches.
 *
 * PEXELS ONLY, and this is not conservatism. pexelsProvider.search maps the
 * API's `videos` array one-to-one, so a page returning fewer than PEXELS_PAGE_SIZE
 * results IS the end of the result set. pixabayProvider.search flatMaps and
 * drops any hit whose renditions are unusable (pixabayStock.server.ts:61, :79),
 * so a FULL page of 80 hits can yield fewer than 80 videos — a short page there
 * does not mean the results ran out, and skipping page 2 would silently lose
 * footage. Pixabay's own numbers say the same: 3,327 of its 3,340 page-2
 * fetches were justified.
 */
async function searchTwoPages(
  provider: StockProvider,
  query: string,
  orientation: Orientation,
  session?: StockSearchSession,
): Promise<StockVideo[]> {
  const first = await provider.search(query, orientation, 1, session);
  if (first.length === 0) return [];
  if (provider.name === "pexels" && first.length < PEXELS_PAGE_SIZE) {
    session?.profile?.count("pexelsSecondPageSkipped");
    return dedupeVideos(first);
  }
  const second = await provider.search(query, orientation, 2, session);
  return dedupeVideos([...first, ...second]);
}

// Round 6: the key pool was reloaded from the DB on every matching invocation.
// With 20-25 invocations per project that is 20-25 identical reads of a table
// that changes only when a key is added, exhausted, or rejected — all of which
// invalidate the snapshot explicitly below. A short TTL bounds staleness for the
// one case that is not explicitly invalidated: a rate-limit window expiring.
const PEXELS_POOL_SNAPSHOT_TTL_MS = 45_000;

let pexelsPoolSnapshot: {
  loadedAt: number;
  value: { configured: boolean; keys: PoolKey[] };
} | null = null;

/**
 * Drops the cached key-pool snapshot. Called whenever this process learns a key
 * changed state (dead, rate-limited) so the next stage reloads instead of
 * re-selecting a key it already knows is unusable.
 */
export function invalidatePexelsPoolSnapshot(): void {
  pexelsPoolSnapshot = null;
}

async function loadActivePoolKeysCached(
  now: () => number = Date.now,
): Promise<{ configured: boolean; keys: PoolKey[] }> {
  const snapshot = pexelsPoolSnapshot;
  if (snapshot && now() - snapshot.loadedAt < PEXELS_POOL_SNAPSHOT_TTL_MS) return snapshot.value;
  const value = await loadActivePoolKeys();
  pexelsPoolSnapshot = { loadedAt: now(), value };
  return value;
}

/** Requests left before a key is treated as spent for the current window. */
const PEXELS_MIN_REMAINING = 5;

/**
 * Whether a key can serve a request right now.
 *
 * MEASURED 2026-08-13: the previous predicate began `if (reset_at > now)
 * return false`, reading a future reset date as "this key is exhausted". It
 * means the opposite — Pexels reports the END OF THE CURRENT QUOTA WINDOW, so
 * for a monthly quota it is always about a month ahead. Every key that had ever
 * served a successful request carried a future reset_at, because markKeyUsed
 * writes the response headers back, so every working key disqualified itself
 * the first time it worked. Against production rows: 34 active keys, minimum
 * 14,933 requests remaining, and the pool loaded ZERO of them. Adding keys
 * could not fix it; a new key worked until its first success and then vanished
 * until its window rolled over a month later.
 *
 * Symptom: `pexelsProvider.search` returned [] with no HTTP attempted, which is
 * indistinguishable from "Pexels had no results" — and in capture 47 Pexels
 * contributed nothing to a 356-scene project while 56% of scenes fell to the
 * alternate-window degradation tier on a quarter-full candidate pool.
 *
 * The window bound applies ONLY to a key that is actually spent.
 */
function usablePexelsKey(key: PoolKey, now: number): boolean {
  // Unknown quota, or plenty left: usable regardless of where the window ends.
  if (key.rate_limit_remaining == null || key.rate_limit_remaining >= PEXELS_MIN_REMAINING) {
    return true;
  }
  const resetAt = key.rate_limit_reset_at ? new Date(key.rate_limit_reset_at).getTime() : Number.NaN;
  // Spent, and the window has not rolled over yet.
  if (Number.isFinite(resetAt) && resetAt > now) return false;
  // Spent with no usable reset date: try it. One request either succeeds or
  // returns 429, and markKeyRateLimited then writes a real reset. Excluding it
  // forever is the same mistake this function exists to undo.
  return true;
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
    const keys = allKeys.filter((key) => usablePexelsKey(key, now));
    keys.sort((a, b) => a.id.localeCompare(b.id));
    return { configured: allKeys.length > 0, keys };
  } catch (error) {
    console.error("[pexels-pool] pool lookup threw, falling back to env", error);
    return { configured: false, keys: [] };
  }
}

function stockRequestLimit(): number {
  const configured = Number(process.env.STOCK_REQUEST_BUDGET ?? 120);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 120;
}

export function createPexelsStagePool(
  keys: PoolKey[],
  configured = true,
  requestLimit = stockRequestLimit(),
): PexelsStagePool {
  return {
    configured,
    keys: [...keys],
    initialCount: keys.length,
    rejectedIds: new Set(),
    unavailableIds: new Set(),
    deactivationPromises: new Map(),
    requestCount: 0,
    requestLimit,
    cursor: 0,
  };
}

async function loadPexelsStagePool(): Promise<PexelsStagePool> {
  const loaded = await loadActivePoolKeysCached();
  if (loaded.configured) return createPexelsStagePool(loaded.keys, true);
  const envKeys = parsePexelsKeys().map((api_key, index) => ({
    id: `env-${index}`,
    api_key,
    rate_limit_remaining: null,
    rate_limit_reset_at: null,
  }));
  return createPexelsStagePool(envKeys, false);
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
    // The RPC accepts nulls for both ("unknown"), but generated types mark them required.
    p_remaining: (remaining !== null && Number.isFinite(remaining) ? remaining : null) as number,
    p_reset_at: pexelsResetAt(res) as string,
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
  invalidatePexelsPoolSnapshot();
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
  invalidatePexelsPoolSnapshot();
  console.info("[pexels-pool] rotated rate-limited key", { keyId: id, resetAt });
}

export async function requestWithPexelsPool(
  pool: PexelsStagePool,
  url: string,
  hooks: {
    onDead?: (id: string, response: Response) => Promise<void>;
    onRateLimited?: (id: string, response: Response) => Promise<void>;
    onSuccess?: (id: string, response: Response) => Promise<void>;
    onRequest?: () => void;
  } = {},
): Promise<Response | null> {
  const total = pool.keys.length;
  if (total === 0) return null;
  // Round-robin, taken SYNCHRONOUSLY before the first await: an async
  // function body runs synchronously up to its first await, so a batch of
  // concurrent calls each claims a distinct starting key before any of them
  // fetches. Within one call the walk still visits every key, wrapping, so a
  // call that starts on an unavailable key behaves exactly as before.
  const start = pool.cursor % total;
  pool.cursor = (start + 1) % total;
  for (let offset = 0; offset < total; offset++) {
    const key = pool.keys[(start + offset) % total];
    if (pool.unavailableIds.has(key.id)) continue;
    if (pool.requestCount >= pool.requestLimit) {
      throw new StockRequestBudgetExceededError(pool.requestLimit);
    }
    pool.requestCount += 1;
    hooks.onRequest?.();
    const response = await fetch(url, { headers: { authorization: key.api_key } });
    if (response.status === 401 || response.status === 403) {
      const firstRejection = !pool.rejectedIds.has(key.id);
      pool.unavailableIds.add(key.id);
      if (firstRejection) {
        pool.rejectedIds.add(key.id);
        const write = hooks.onDead?.(key.id, response) ?? Promise.resolve();
        pool.deactivationPromises.set(key.id, write);
        await write;
      }
      if (pool.initialCount > 0 && pool.rejectedIds.size * 4 > pool.initialCount) {
        throw new PexelsPoolDegradedError(pool.rejectedIds.size, pool.initialCount);
      }
      continue;
    }
    if (response.status === 429) {
      pool.unavailableIds.add(key.id);
      await hooks.onRateLimited?.(key.id, response);
      continue;
    }
    if (response.ok) await hooks.onSuccess?.(key.id, response);
    return response;
  }
  return null;
}

async function pexelsFetch(
  query: string,
  orientation: Orientation,
  page: number,
  session?: StockSearchSession,
): Promise<Response | null> {
  const pool = session?.pexelsPool ?? (await loadPexelsStagePool());
  if (pool.keys.length === 0) {
    // AUDIBLE, because this was silent for eleven days. Returning null here
    // makes search() return [], which is indistinguishable from "no results" —
    // and PexelsPoolDegradedError cannot help: it counts keys rejected DURING
    // requests, so the one case it was built for, total unavailability, is the
    // one case it never sees. These two counters reach the pollPipeline payload.
    session?.profile?.count(pool.configured ? "pexelsPoolEmpty" : "pexelsPoolUnconfigured");
    console.warn("[pexels-pool] no usable key is available", {
      configured: pool.configured,
      keysLoaded: pool.keys.length,
      keysSeenAtLoad: pool.initialCount,
    });
    return null;
  }
  const response = await requestWithPexelsPool(pool, buildPexelsUrl(query, orientation, page), {
    onDead: pool.configured
      ? (id, rejected) => markKeyDead(id, `Pexels rejected key (HTTP ${rejected.status})`)
      : undefined,
    onRateLimited: pool.configured ? markKeyRateLimited : undefined,
    onSuccess: pool.configured ? markKeyUsed : undefined,
    onRequest: () => {
      if (!session) return;
      const counts = session.usage.get("pexels") ?? { requests: 0, cacheHits: 0 };
      counts.requests += 1;
      session.usage.set("pexels", counts);
      // Same count as session.pexelsPool.requestCount, but recorded as it
      // happens. The pool's own counter is only read by a log line on the
      // legacy assignment path, which a corpus-build invocation never reaches.
      session.profile?.count("pexelsRequests");
    },
  });
  if (!response) console.warn("[pexels-pool] no key could serve this request");
  return response;
}

export const pexelsProvider: StockProvider = {
  name: "pexels",
  async search(query, orientation, page, session) {
    const res = await pexelsFetch(query, orientation, page, session);
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

/**
 * Creates a per-stage search session (in-memory cache, in-flight dedupe, key
 * pool, pending cache writes).
 *
 * Round 6: this used to eagerly prefetch stock_search_cache rows for EVERY
 * scene query in the project — 145 rows of multi-hundred-KB JSON on every one of
 * ~56 matching invocations, of which one invocation used two or three. It was
 * also largely wasted work: matchStockCorpus prefetches the *clustered bucket*
 * queries it is about to search (see stock-corpus.server.ts), which are not the
 * raw per-scene queries prefetched here, so most rows were fetched and never
 * read. Prefetching is now left entirely to matchStockCorpus, where it is scoped
 * to the slice actually being processed. Session setup is O(1).
 */
export async function createStockSearchSession(
  profile?: MatchingProfile,
): Promise<StockSearchSession> {
  const pexelsPool = await loadPexelsStagePool();
  return {
    cache: new Map(),
    inflight: new Map(),
    pendingCache: new Map(),
    prefetched: new Set(),
    usage: new Map(),
    pexelsPool,
    profile,
    nasaMetrics: emptyNasaMetrics(),
  };
}

/**
 * Concurrent NASA searches allowed in this PROCESS, across every batch and
 * every project.
 *
 * NASA_CELL_CONCURRENCY caps a single invocation's batch, which is the wrong
 * scope for a rate limit: two concurrent projects at 2 cells x 3 parallel
 * search pages put 12 simultaneous requests on images-api.nasa.gov — unkeyed,
 * with no rate-limit handling anywhere in this codebase.
 *
 * MEASURED 2026-08-14, two concurrent batched projects: 69 and 36 NASA cells
 * failed (86% and 82%), with the rate-limit signature exactly — the first
 * invocation clean at 182ms/request, failures from the second invocation
 * onward completing in ~35ms, the shape of fast rejection after a burst. The
 * serial loop's 357 requests at <=3 concurrent pages never failed, so <=6
 * pages (two cells) is the empirically safe envelope. The batch sub-cap stays
 * as the scheduler; this is the enforcer.
 *
 * The cost of a queued cell is its batch slot while it waits — acceptable at
 * NASA cell times of 0.1-0.5s, and recorded as nasaSearchQueueMs so a capture
 * shows when the cap actually bound.
 */
const NASA_SEARCH_CONCURRENCY = 2;
let nasaSearchesActive = 0;
const nasaSearchWaiters: Array<() => void> = [];

async function acquireNasaSearchSlot(profile?: MatchingProfile): Promise<void> {
  if (nasaSearchesActive < NASA_SEARCH_CONCURRENCY) {
    nasaSearchesActive += 1;
    return;
  }
  const queuedAt = Date.now();
  // The releaser hands the slot over directly — the count is NOT decremented
  // and re-incremented across the wake-up, because in that gap a fresh caller
  // could see a free slot and enter, putting three searches in flight.
  await new Promise<void>((resolve) => nasaSearchWaiters.push(resolve));
  profile?.add("nasaSearchQueue", Date.now() - queuedAt);
}

function releaseNasaSearchSlot(): void {
  const next = nasaSearchWaiters.shift();
  if (next) next();
  else nasaSearchesActive -= 1;
}

function emptyNasaMetrics(): NasaRequestMetrics {
  return {
    searchRequests: 0,
    assetCalls: 0,
    metadataCalls: 0,
    metadataJsonFetches: 0,
    captionCalls: 0,
    assetCacheHits: 0,
    assetCacheMisses: 0,
  };
}

/**
 * Runs one NASA search against its OWN metrics object, merging into the
 * session's afterwards.
 *
 * The session-wide object cannot be shared with a before/after snapshot once
 * searches overlap: two concurrent searches each read "before" as zero, both
 * finish, and each reads the other's requests in its "after" — nasaSearchRequests
 * roughly doubles while the real HTTP is unchanged. Bucket-parallel corpus
 * builds (B3) make overlap the normal case rather than a curiosity, and a
 * capture that double-counts NASA would send the next optimisation round
 * chasing a phantom.
 *
 * Counted in `finally` so a failed search still reports the calls it made —
 * the invocation where NASA threw is exactly the one worth explaining. The
 * per-search object also means a joiner (session.inflight) can never
 * double-count: only the caller that owns the search runs this function.
 */
async function searchNasaMetered(
  search: (metrics: NasaRequestMetrics) => Promise<StockVideo[]>,
  session: StockSearchSession | undefined,
): Promise<StockVideo[]> {
  const metrics = emptyNasaMetrics();
  // Acquired here rather than at a call site so EVERY NASA search in the
  // process passes through the cap — both the corpus path and the legacy one —
  // and only searches that actually execute pay for a slot: a cache hit or an
  // inflight join never reaches this function.
  await acquireNasaSearchSlot(session?.profile);
  try {
    return await search(metrics);
  } finally {
    releaseNasaSearchSlot();
    const shared = session?.nasaMetrics;
    if (shared) {
      shared.searchRequests += metrics.searchRequests;
      shared.assetCalls += metrics.assetCalls;
      shared.metadataCalls += metrics.metadataCalls;
      shared.metadataJsonFetches += metrics.metadataJsonFetches;
      shared.captionCalls += metrics.captionCalls;
      shared.assetCacheHits += metrics.assetCacheHits;
      shared.assetCacheMisses += metrics.assetCacheMisses;
    }
    const profile = session?.profile;
    if (profile) {
      profile.count("nasaSearchRequests", metrics.searchRequests);
      profile.count("nasaAssetCalls", metrics.assetCalls);
      profile.count("nasaMetadataCalls", metrics.metadataCalls);
      profile.count("nasaMetadataJsonFetches", metrics.metadataJsonFetches);
      profile.count("nasaCaptionCalls", metrics.captionCalls);
      profile.count("nasaAssetCacheHits", metrics.assetCacheHits);
      profile.count("nasaAssetCacheMisses", metrics.assetCacheMisses);
    }
  }
}

export async function flushStockSearchSession(session: StockSearchSession): Promise<void> {
  const profile = session.profile;
  const flushStartedAt = Date.now();
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
  profile?.add("sessionFlush", Date.now() - flushStartedAt);
  profile?.count("sessionFlushRows", rows.length);
  session.pendingCache.clear();
  session.usage.clear();
}

export async function searchStockFootage(
  opts: StockSearchOptions,
): Promise<StockSearchResult | null> {
  const normQuery = normalizeStockQuery(opts.query);
  if (!normQuery) return null;
  if (opts.niche === "space") {
    for (const nasaQuery of expandNasaQueries(normQuery)) {
      const result = await searchNasaWithCacheAndSelect({ ...opts, normQuery: nasaQuery });
      if (result) return result;
    }
    const pexels = await searchPexelsWithCacheAndSelect({
      ...opts,
      normQuery: spaceBiasedPexelsQuery(normQuery),
    });
    if (pexels) return pexels;
    return searchPixabayWithCacheAndSelect({
      ...opts,
      normQuery: spaceBiasedPexelsQuery(normQuery),
    });
  }
  const pexels = await searchPexelsWithCacheAndSelect({ ...opts, normQuery });
  return pexels ?? searchPixabayWithCacheAndSelect({ ...opts, normQuery });
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

export async function searchProviderCandidatePool(opts: {
  provider: "pexels" | "pixabay" | "nasa";
  query: string;
  orientation: Orientation;
  targetWidth: number;
  seed?: string;
  session: StockSearchSession;
}): Promise<StockVideo[]> {
  const normQuery = normalizeStockQuery(opts.query);
  if (!normQuery) return [];

  if (opts.provider === "nasa") {
    const { searchNasaFootage } = await import("@/lib/nasaStock.server");
    return getCachedOrSearch({
      provider: "nasa",
      query: normQuery,
      orientation: "any",
      session: opts.session,
      search: () =>
        searchNasaMetered(
          (metrics) =>
            searchNasaFootage(normQuery, {
              targetWidth: opts.targetWidth,
              seed: opts.seed,
              metrics,
            }),
          opts.session,
        ),
    });
  }

  const provider =
    opts.provider === "pexels"
      ? pexelsProvider
      : (await import("@/lib/pixabayStock.server")).pixabayProvider;
  return getCachedOrSearch({
    provider: opts.provider,
    query: normQuery,
    orientation: opts.orientation,
    session: opts.session,
    search: () => searchTwoPages(provider, normQuery, opts.orientation, opts.session),
  });
}

async function searchPexelsWithCacheAndSelect(
  opts: StockSearchOptions & { normQuery: string },
): Promise<StockSearchResult | null> {
  const results = await getCachedOrSearch({
    provider: "pexels",
    query: opts.normQuery,
    orientation: opts.orientation,
    session: opts.session,
    search: () => searchTwoPages(pexelsProvider, opts.normQuery, opts.orientation, opts.session),
  });
  return selectStockCandidate({ ...opts, results, requireMinDuration: false });
}

async function searchPixabayWithCacheAndSelect(
  opts: StockSearchOptions & { normQuery: string },
): Promise<StockSearchResult | null> {
  const { pixabayProvider } = await import("@/lib/pixabayStock.server");
  const results = await getCachedOrSearch({
    provider: "pixabay",
    query: opts.normQuery,
    orientation: opts.orientation,
    session: opts.session,
    search: () => searchTwoPages(pixabayProvider, opts.normQuery, opts.orientation, opts.session),
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
      searchNasaMetered(
        (metrics) =>
          searchNasaFootage(opts.normQuery, {
            targetWidth: opts.targetWidth,
            seed: opts.seed,
            metrics,
          }),
        opts.session,
      ),
  }).catch((error) => {
    console.warn("[nasa-stock] search failed", {
      query: opts.normQuery,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  return selectStockCandidate({ ...opts, results, requireMinDuration: false });
}

/**
 * Timing bucket for one provider's outbound search.
 *
 * MEASURED capture 46: providerSearch is 4,577 ms per invocation, 39% of
 * matching — five times the whole corpus path — but it is one bucket for three
 * providers with very different shapes. Pexels and Pixabay are two sequential
 * page fetches; a NASA cell is three parallel search pages plus up to twelve
 * asset resolutions at concurrency two. Choosing a fix without knowing which of
 * those the 4,577 ms is would be guesswork.
 */
function providerSearchBucket(provider: string): string {
  return `providerSearch${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
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
  const profile = opts.session?.profile;
  if (
    cached &&
    hasCurrentPexelsBreadth &&
    Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS
  ) {
    profile?.count("searchCacheHits");
    await recordUsage(opts.provider, true, opts.session);
    return cached.results;
  }
  let searchPromise = opts.session?.inflight.get(key);
  const ownsSearch = !searchPromise;
  if (!searchPromise) {
    profile?.count("searchCacheMisses");
    // Single choke point for every provider (Pexels, Pixabay, NASA): all
    // outbound provider HTTP for a search flows through here.
    //
    // Timed twice on purpose. `providerSearch` is the series every capture so
    // far has been read against and must stay comparable; the per-provider
    // bucket is what says WHICH provider the time belongs to, which the single
    // bucket could never answer. Buckets are allowed to overlap — see
    // matching-profile.ts.
    searchPromise = profile
      ? profile.time("providerSearch", () =>
          profile.time(providerSearchBucket(opts.provider), () => opts.search()),
        )
      : opts.search();
    opts.session?.inflight.set(key, searchPromise);
  } else {
    profile?.count("searchInflightJoins");
  }

  let results: StockVideo[];
  try {
    // NASA per-search HTTP counters are attributed inside searchNasaMetered,
    // which the owner's search closure wraps — a per-search metrics object, so
    // overlapping searches cannot read each other's requests and a joiner
    // (whose closure never runs) cannot double-count.
    results = await searchPromise;
  } finally {
    opts.session?.inflight.delete(key);
  }
  if (ownsSearch && opts.provider === "nasa") {
    await recordUsage(opts.provider, false, opts.session);
  }
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

export async function prefetchStockProviderCache(
  session: StockSearchSession,
  provider: "pexels" | "pixabay" | "nasa",
  orientation: Orientation | "any",
  queries: string[],
): Promise<void> {
  await prefetchCacheRows(session, provider, orientation, [
    ...new Set(queries.map(normalizeStockQuery).filter(Boolean)),
  ]);
}

async function prefetchCacheRows(
  session: StockSearchSession,
  provider: string,
  orientation: string,
  queries: string[],
) {
  // Skip anything this session already looked up — a hit is already in
  // session.cache, and a miss would just re-read nothing. Slices cluster into
  // overlapping buckets, so the overlap between consecutive slices is real.
  const pending = queries.filter(
    (query) => !session.prefetched?.has(cacheKey(provider, query, orientation)),
  );
  if (pending.length === 0) return;
  const profile = session.profile;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  for (let start = 0; start < pending.length; start += 75) {
    const batch = pending.slice(start, start + 75);
    profile?.count("cacheReadQueries");
    const startedAt = Date.now();
    const { data, error } = await supabaseAdmin
      .from("stock_search_cache")
      .select("provider, query, orientation, results, cached_at")
      .eq("provider", provider)
      .eq("orientation", orientation)
      .in("query", batch);
    profile?.add("cacheRead", Date.now() - startedAt);
    if (error) throw new Error(`Stock cache prefetch failed: ${error.message}`);
    // Only after a successful read: a failed batch must stay re-readable.
    for (const query of batch) session.prefetched?.add(cacheKey(provider, query, orientation));
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
  const longEnough = eligible.filter(({ video }) =>
    meetsMinimumSourceDuration(video, opts.minDurationSec),
  );
  if (opts.requireMinDuration && longEnough.length === 0) return null;
  const candidateMeta = longEnough.length > 0 ? longEnough : eligible;
  // Prefer sources within the duration budget; fall back to all only if none fit.
  const budgeted = candidateMeta.filter(({ video }) =>
    withinSourceDurationBudget(video, opts.minDurationSec),
  );
  const preferredMeta = budgeted.length > 0 ? budgeted : candidateMeta;
  const top = [...preferredMeta].sort((a, b) => a.index - b.index).slice(0, SEEDED_TOP_CANDIDATES);
  const selected = top[seededIndex(`${opts.seed ?? "stock"}:candidate`, top.length)];
  const pick = selected.video;
  const chosenFile = selectRenditionForTarget(pick.files, opts.targetWidth)!;
  return {
    pick,
    chosenFile,
    candidates: candidateMeta.map(({ video }) => video),
    inPoint: selected.inPoint,
    reservationKey: stockReservationKey(pick.provider, pick.provider_clip_id, selected.inPoint),
    fallbackUrls: fallbackRenditions(pick.files, chosenFile),
  };
}

export function buildNasaSourceWindows(
  video: StockVideo,
  requiredDuration: number,
  seed?: string,
  maxWindows = 6,
): number[] {
  if (video.provider !== "nasa" || video.duration_known === false) return [0];
  const duration = Math.max(0, video.duration_sec);
  const clipDuration = Math.max(1, requiredDuration);
  const margin = duration * 0.1;
  const firstStart =
    Math.ceil(margin / NASA_IN_POINT_BUCKET_SECONDS) * NASA_IN_POINT_BUCKET_SECONDS;
  const lastStart = duration - margin - clipDuration;
  if (lastStart < firstStart) return duration >= clipDuration ? [0] : [];

  const step =
    Math.max(1, Math.ceil(clipDuration / NASA_IN_POINT_BUCKET_SECONDS)) *
    NASA_IN_POINT_BUCKET_SECONDS;
  const starts: number[] = [];
  for (let start = firstStart; start <= lastStart + 0.001; start += step) {
    starts.push(start);
  }
  if (starts.length === 0) return [0];
  const offset = seededIndex(
    `${seed ?? "nasa"}:${video.provider_clip_id}:window-order`,
    starts.length,
  );
  const ordered = [...starts.slice(offset), ...starts.slice(0, offset)];
  return ordered.slice(0, Math.max(1, maxWindows));
}

function nasaInPoint(video: StockVideo, requiredDuration: number, seed?: string): number {
  return buildNasaSourceWindows(video, requiredDuration, seed, 1)[0] ?? 0;
}

function normalizeStockQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function spaceBiasedPexelsQuery(query: string): string {
  return normalizeStockQuery(`${query} ${SPACE_THEME_TERMS}`);
}

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

export function stockQueryTokens(query: string): string[] {
  return normalizeStockQuery(query)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token));
}

export function expandNasaQueries(query: string): string[] {
  const normalized = normalizeStockQuery(query);
  const tokens = stockQueryTokens(normalized);
  if (tokens.length === 0) return normalized ? [normalized] : [];
  const variants = [
    normalized,
    tokens.slice(0, 4).join(" "),
    tokens.slice(-4).join(" "),
    [...tokens]
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 3)
      .join(" "),
  ];
  return variants.filter((value, index) => value && variants.indexOf(value) === index);
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
