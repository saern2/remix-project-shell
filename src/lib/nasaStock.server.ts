import type { NasaRequestMetrics, StockVideo, StockVideoFile } from "@/lib/stock.server";

const NASA_SEARCH_URL = "https://images-api.nasa.gov/search";
const NASA_ASSET_URL = "https://images-api.nasa.gov/asset";
const NASA_METADATA_URL = "https://images-api.nasa.gov/metadata";
const NASA_CAPTIONS_URL = "https://images-api.nasa.gov/captions";
const NASA_PAGE_SIZE = 100;
const NASA_SEARCH_PAGES = 3;
const NASA_RESOLVE_LIMIT = 12;
const NASA_RESOLVE_CONCURRENCY = 2;
const NASA_ASSET_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const NASA_RELEVANCE_FLOOR = 0.18;
export const NASA_UNKNOWN_DURATION_SECONDS = 60 * 60;

type NasaSearchData = {
  nasa_id?: string;
  title?: string;
  description?: string;
  keywords?: string[];
  center?: string;
};

type NasaSearchItem = {
  data?: NasaSearchData[];
  links?: NasaLink[];
};

type NasaSearchResponse = {
  collection?: {
    metadata?: { total_hits?: number };
    items?: NasaSearchItem[];
  };
};

type NasaLink = {
  href?: string;
  rel?: string;
  render?: string;
  width?: number;
};

type NasaAssetResponse = {
  collection?: { items?: Array<{ href?: string }> };
};

type NasaLocationResponse = { location?: string };
type NasaMetadata = Record<string, unknown>;
type NasaTier = "small" | "medium" | "large" | "orig";

type CachedNasaAsset = {
  nasa_id: string;
  files: unknown;
  duration_seconds: number | null;
  duration_known: boolean;
  thumbnail_url: string | null;
  /** null = never probed; see the caption-probe comment in resolveNasaAssets. */
  has_captions: boolean | null;
  cached_at: string;
};

const NASA_TIER_SIZE: Record<NasaTier, { width: number; height: number }> = {
  small: { width: 640, height: 360 },
  medium: { width: 1280, height: 720 },
  large: { width: 1920, height: 1080 },
  orig: { width: 3840, height: 2160 },
};

const TALKING_HEAD_TERMS = [
  "this week @nasa",
  "asknasa",
  "briefing",
  "press conference",
  "announcement",
  "interview",
  "behind the spacecraft",
  "webcast",
  "panel",
];

const VISUAL_CONTENT_TERMS = [
  "simulation",
  "visualization",
  "animation",
  "flyover",
  "timelapse",
  "concept",
];

export async function searchNasaFootage(
  query: string,
  opts: { targetWidth: number; seed?: string; metrics?: NasaRequestMetrics },
): Promise<StockVideo[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const pages = await Promise.all(
    Array.from({ length: NASA_SEARCH_PAGES }, (_, index) =>
      fetchNasaSearchPage(normalizedQuery, index + 1, opts.metrics),
    ),
  );
  const allItems = dedupeSearchItems(pages.flatMap((page) => page.collection?.items ?? []));
  const rankedItems = rankNasaSearchItems(normalizedQuery, allItems, opts.seed).slice(
    0,
    NASA_RESOLVE_LIMIT,
  );
  if (rankedItems.length === 0) return [];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nasaIds = rankedItems
    .map((item) => item.data?.[0]?.nasa_id?.trim())
    .filter((id): id is string => !!id);
  const { data: cachedRows, error: cacheError } = await supabaseAdmin
    .from("nasa_asset_cache")
    .select(
      "nasa_id, files, duration_seconds, duration_known, thumbnail_url, has_captions, cached_at",
    )
    .in("nasa_id", nasaIds);
  if (cacheError) {
    console.warn("[nasa-stock] asset cache read failed", { error: cacheError.message });
  }

  const cache = new Map(((cachedRows ?? []) as CachedNasaAsset[]).map((row) => [row.nasa_id, row]));
  const resolved = new Array<StockVideo | null>(rankedItems.length).fill(null);
  const cacheWrites: Array<{
    nasa_id: string;
    files: never;
    duration_seconds: number | null;
    duration_known: boolean;
    thumbnail_url: string | null;
    has_captions: boolean | null;
    cached_at: string;
  }> = [];
  // Caption results for rows that were cached before has_captions existed, or
  // that have not been probed yet. Written back separately so a caption probe
  // never forces a re-fetch of files/metadata.
  const captionWrites: Array<{ nasa_id: string; has_captions: boolean }> = [];

  await asyncPool(
    rankedItems.map((item, index) => ({ item, index })),
    NASA_RESOLVE_CONCURRENCY,
    async ({ item, index }) => {
      const data = item.data?.[0] ?? {};
      const nasaId = data.nasa_id?.trim();
      if (!nasaId) return;
      const thumbnail = selectThumbnailUrl(item.links);
      const cached = cache.get(nasaId);

      // The caption probe used to run HERE, unconditionally, before the cache
      // was consulted — one HTTPS round trip per ranked item on every search,
      // even when everything else came from cache, and all of it inside the
      // matching_footage time budget. Captions never change for a given asset,
      // so the answer is cached alongside the rest and probed only on a miss.
      if (cached && Date.now() - new Date(cached.cached_at).getTime() < NASA_ASSET_CACHE_TTL_MS) {
        const files = parseCachedFiles(cached.files);
        if (files.length > 0) {
          incrementMetric(opts.metrics, "assetCacheHits");
          // null means this row predates the has_captions column: probe once,
          // persist, and it settles for every later search.
          let hasCaptions = cached.has_captions;
          if (hasCaptions == null) {
            hasCaptions = await fetchNasaCaptionSignal(nasaId, opts.metrics);
            captionWrites.push({ nasa_id: nasaId, has_captions: hasCaptions });
          }
          resolved[index] = toStockVideo({
            nasaId,
            files,
            duration: cached.duration_seconds,
            durationKnown: cached.duration_known,
            thumbnail: cached.thumbnail_url ?? thumbnail,
            targetWidth: opts.targetWidth,
            data,
            hasCaptions,
          });
          return;
        }
      }
      incrementMetric(opts.metrics, "assetCacheMisses");
      const hasCaptions = await fetchNasaCaptionSignal(nasaId, opts.metrics);

      try {
        const [files, metadata] = await Promise.all([
          fetchNasaFiles(nasaId, opts.metrics),
          fetchNasaMetadata(nasaId, opts.metrics).catch((error) => {
            console.warn("[nasa-stock] metadata unavailable; keeping video with unknown duration", {
              nasaId,
              error: error instanceof Error ? error.message : String(error),
            });
            return {} as NasaMetadata;
          }),
        ]);
        if (files.length === 0) return;
        const duration = findNasaDurationSeconds(metadata);
        resolved[index] = toStockVideo({
          nasaId,
          files,
          duration,
          durationKnown: duration !== null,
          thumbnail,
          targetWidth: opts.targetWidth,
          data,
          hasCaptions,
        });
        cacheWrites.push({
          nasa_id: nasaId,
          files: files as unknown as never,
          duration_seconds: duration,
          duration_known: duration !== null,
          thumbnail_url: thumbnail,
          has_captions: hasCaptions,
          cached_at: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("[nasa-stock] skipping unusable NASA result", {
          nasaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  if (cacheWrites.length > 0) {
    const { error } = await supabaseAdmin
      .from("nasa_asset_cache")
      .upsert(cacheWrites, { onConflict: "nasa_id" });
    if (error) console.warn("[nasa-stock] asset cache write failed", { error: error.message });
  }

  // Backfill only. Fire-and-forget: a failed backfill just means one more probe
  // on the next search, which is strictly better than failing the match.
  if (captionWrites.length > 0) {
    await Promise.all(
      captionWrites.map(({ nasa_id, has_captions }) =>
        supabaseAdmin.from("nasa_asset_cache").update({ has_captions }).eq("nasa_id", nasa_id),
      ),
    ).catch((error) => {
      console.warn("[nasa-stock] caption backfill failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const candidates = resolved.filter((video): video is StockVideo => video !== null);
  const scored = candidates
    .map((video) => ({
      video,
      relevance: nasaRelevanceScore(normalizedQuery, video),
      rankScore: scoreNasaCandidate(normalizedQuery, video),
    }))
    .sort(
      (a, b) =>
        b.rankScore - a.rankScore ||
        seededTieBreak(opts.seed, a.video.provider_clip_id, b.video.provider_clip_id),
    );
  const accepted = scored.filter(({ relevance }) => relevance >= NASA_RELEVANCE_FLOOR);
  const relevanceValues = scored.map(({ relevance }) => relevance).sort((a, b) => a - b);
  console.info("[nasa-stock] relevance", {
    query: normalizedQuery,
    resolved: scored.length,
    accepted: accepted.length,
    rejected: scored.length - accepted.length,
    min: roundScore(relevanceValues[0]),
    median: roundScore(relevanceValues[Math.floor(relevanceValues.length / 2)]),
    max: roundScore(relevanceValues.at(-1)),
    talkingHeadPenalized: scored.filter(({ video }) => hasTalkingHeadSignals(video)).length,
  });
  return accepted.map(({ video }) => video);
}

async function fetchNasaSearchPage(
  query: string,
  page: number,
  metrics?: NasaRequestMetrics,
): Promise<NasaSearchResponse> {
  const keywords = queryTokens(query).slice(0, 5).join(",");
  const params = new URLSearchParams({
    q: query,
    media_type: "video",
    page_size: String(NASA_PAGE_SIZE),
    page: String(page),
  });
  if (keywords) params.set("keywords", keywords);
  incrementMetric(metrics, "searchRequests");
  const res = await fetch(`${NASA_SEARCH_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`NASA search failed (${res.status}): ${await safeResponseText(res)}`);
  }
  return (await res.json()) as NasaSearchResponse;
}

export function nasaPageForSeed(seed: string, maxPage: number): number {
  const boundedPages = Math.max(1, Math.floor(maxPage));
  return 1 + (stableHash(seed) % boundedPages);
}

export function nasaRelevanceScore(query: string, video: StockVideo): number {
  const queryTerms = new Set(queryTokens(query));
  if (queryTerms.size === 0) return 0;
  const metadata = nasaMetadataText(video);
  const metadataTerms = new Set(queryTokens(metadata));
  const overlap = [...queryTerms].filter((term) => metadataTerms.has(term)).length;
  let score = overlap / queryTerms.size;
  if (metadata.toLowerCase().includes(query.trim().toLowerCase())) score += 0.2;
  return Math.max(0, Math.min(1, score));
}

export function scoreNasaCandidate(query: string, video: StockVideo): number {
  let score = nasaRelevanceScore(query, video);
  const normalizedMetadata = nasaMetadataText(video).toLowerCase();
  if (hasTalkingHeadSignals(video)) score -= 0.35;
  if (video.has_captions) score -= 0.12;
  if (
    VISUAL_CONTENT_TERMS.some((term) => normalizedMetadata.includes(term)) ||
    /^gsfc_.*_m\d+_/i.test(video.provider_clip_id)
  ) {
    score += 0.25;
  }
  return Math.max(0, Math.min(1, score));
}

export function rankNasaSearchItems(
  query: string,
  items: NasaSearchItem[],
  seed?: string,
): NasaSearchItem[] {
  return [...items].sort((a, b) => {
    const scoreDiff = scoreSearchData(query, b.data?.[0]) - scoreSearchData(query, a.data?.[0]);
    if (scoreDiff !== 0) return scoreDiff;
    return seededTieBreak(seed, a.data?.[0]?.nasa_id ?? "", b.data?.[0]?.nasa_id ?? "");
  });
}

function nasaMetadataText(video: StockVideo): string {
  return [video.title ?? "", video.description ?? "", ...(video.keywords ?? [])].join(" ");
}

function hasTalkingHeadSignals(video: StockVideo): boolean {
  const metadata = nasaMetadataText(video).toLowerCase();
  return TALKING_HEAD_TERMS.some((term) => metadata.includes(term));
}

function seededTieBreak(seed: string | undefined, a: string, b: string): number {
  if (!seed) return a.localeCompare(b);
  return stableHash([seed, a].join(":")) - stableHash([seed, b].join(":"));
}

function scoreSearchData(query: string, data?: NasaSearchData): number {
  if (!data) return 0;
  const video: StockVideo = {
    provider: "nasa",
    provider_clip_id: data.nasa_id ?? "",
    duration_sec: 0,
    width: 0,
    height: 0,
    thumbnail_url: null,
    files: [],
    title: data.title,
    description: data.description,
    keywords: data.keywords,
  };
  return scoreNasaCandidate(query, video);
}

function dedupeSearchItems(items: NasaSearchItem[]): NasaSearchItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = item.data?.[0]?.nasa_id?.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function fetchNasaFiles(
  nasaId: string,
  metrics?: NasaRequestMetrics,
): Promise<StockVideoFile[]> {
  incrementMetric(metrics, "assetCalls");
  const res = await fetch(`${NASA_ASSET_URL}/${encodeURIComponent(nasaId)}`);
  if (!res.ok) {
    throw new Error(`NASA asset lookup failed (${res.status}): ${await safeResponseText(res)}`);
  }
  const json = (await res.json()) as NasaAssetResponse;
  return (json.collection?.items ?? [])
    .map((item) => item.href)
    .filter((href): href is string => !!href && /\.mp4(?:$|\?)/i.test(href))
    .flatMap((href) => {
      try {
        return [nasaFileFromUrl(href)];
      } catch {
        return [];
      }
    });
}

export function nasaFileFromUrl(url: string): StockVideoFile {
  const tier = nasaTierFromUrl(url);
  const dimensions = tier ? NASA_TIER_SIZE[tier] : NASA_TIER_SIZE.medium;
  return { url: normalizeNasaAssetUrl(url), ...dimensions };
}

async function fetchNasaMetadata(
  nasaId: string,
  metrics?: NasaRequestMetrics,
): Promise<NasaMetadata> {
  incrementMetric(metrics, "metadataCalls");
  const res = await fetch(`${NASA_METADATA_URL}/${encodeURIComponent(nasaId)}`);
  if (!res.ok) {
    throw new Error(`NASA metadata lookup failed (${res.status}): ${await safeResponseText(res)}`);
  }
  const locationJson = (await res.json()) as NasaLocationResponse;
  if (!locationJson.location) throw new Error("NASA metadata response did not include a location.");
  incrementMetric(metrics, "metadataJsonFetches");
  const metadataRes = await fetch(normalizeNasaAssetUrl(locationJson.location));
  if (!metadataRes.ok) {
    throw new Error(
      `NASA metadata file failed (${metadataRes.status}): ${await safeResponseText(metadataRes)}`,
    );
  }
  return (await metadataRes.json()) as NasaMetadata;
}

async function fetchNasaCaptionSignal(
  nasaId: string,
  metrics?: NasaRequestMetrics,
): Promise<boolean> {
  incrementMetric(metrics, "captionCalls");
  const res = await fetch(`${NASA_CAPTIONS_URL}/${encodeURIComponent(nasaId)}`);
  if (res.status === 404) return false;
  if (!res.ok) return false;
  const payload = (await res.json().catch(() => null)) as NasaLocationResponse | null;
  return typeof payload?.location === "string" && /\.(?:vtt|srt)(?:$|\?)/i.test(payload.location);
}

function incrementMetric(
  metrics: NasaRequestMetrics | undefined,
  key: keyof NasaRequestMetrics,
): void {
  if (metrics) metrics[key] += 1;
}

export function findNasaDurationSeconds(metadata: NasaMetadata): number | null {
  for (const [key, value] of Object.entries(metadata)) {
    if (!/duration/i.test(key)) continue;
    const duration = parseNasaDurationSeconds(value);
    if (duration !== null) return duration;
  }
  return null;
}

export function parseNasaDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (value && typeof value === "object") {
    const scale = Number((value as { Scale?: unknown }).Scale);
    const rawValue = Number((value as { Value?: unknown }).Value);
    const scaled = scale * rawValue;
    return Number.isFinite(scaled) && scaled > 0 ? scaled : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const secondsMatch = /^(\d+(?:\.\d+)?)\s*s$/i.exec(trimmed);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    return seconds > 0 ? seconds : null;
  }
  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function toStockVideo(opts: {
  nasaId: string;
  files: StockVideoFile[];
  duration: number | null;
  durationKnown: boolean;
  thumbnail: string | null;
  targetWidth: number;
  data: NasaSearchData;
  hasCaptions: boolean;
}): StockVideo {
  const files = [...opts.files].sort(
    (a, b) => fileWidthScore(a.width, opts.targetWidth) - fileWidthScore(b.width, opts.targetWidth),
  );
  return {
    provider: "nasa",
    provider_clip_id: opts.nasaId,
    duration_sec: opts.duration ?? NASA_UNKNOWN_DURATION_SECONDS,
    duration_known: opts.durationKnown,
    width: files[0].width,
    height: files[0].height,
    thumbnail_url: opts.thumbnail,
    files,
    title: opts.data.title,
    description: opts.data.description,
    keywords: opts.data.keywords,
    has_captions: opts.hasCaptions,
  };
}

function parseCachedFiles(value: unknown): StockVideoFile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (file): file is StockVideoFile =>
      !!file &&
      typeof file === "object" &&
      typeof (file as StockVideoFile).url === "string" &&
      Number.isFinite(Number((file as StockVideoFile).width)) &&
      Number.isFinite(Number((file as StockVideoFile).height)),
  );
}

function nasaTierFromUrl(url: string): NasaTier | null {
  const match = /~(small|medium|large|orig)\.mp4(?:$|\?)/i.exec(url);
  return match ? (match[1].toLowerCase() as NasaTier) : null;
}

function fileWidthScore(width: number, targetWidth: number): number {
  return width >= targetWidth ? width - targetWidth : 5_000 + targetWidth - width;
}

function selectThumbnailUrl(links: NasaLink[] | undefined): string | null {
  const imageLinks = (links ?? []).filter((link) => link.href && link.render === "image");
  const preview = imageLinks.find((link) => link.rel === "preview") ?? imageLinks[0];
  return preview?.href ? normalizeNasaAssetUrl(preview.href) : null;
}

function normalizeNasaAssetUrl(url: string): string {
  return new URL(
    url.replace(/^http:\/\/images-assets\.nasa\.gov/i, "https://images-assets.nasa.gov"),
  ).href;
}

function queryTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function roundScore(score: number | undefined): number | null {
  return score == null ? null : Math.round(score * 1000) / 1000;
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function asyncPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()),
  );
}

async function safeResponseText(res: Response): Promise<string> {
  return (await res.text().catch(() => res.statusText)).slice(0, 300);
}
