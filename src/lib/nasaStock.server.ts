import type { StockVideo, StockVideoFile } from "@/lib/stock.server";

const NASA_SEARCH_URL = "https://images-api.nasa.gov/search";
const NASA_ASSET_URL = "https://images-api.nasa.gov/asset";
const NASA_METADATA_URL = "https://images-api.nasa.gov/metadata";
const NASA_PAGE_SIZE = 50;
const NASA_RESOLVE_CONCURRENCY = 5;
const NASA_ASSET_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const NASA_UNKNOWN_DURATION_SECONDS = 60 * 60;

type NasaSearchItem = {
  data?: Array<{ nasa_id?: string; title?: string }>;
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

type NasaMetadataLocationResponse = { location?: string };
type NasaMetadata = Record<string, unknown>;
type NasaTier = "small" | "medium" | "large" | "orig";

type CachedNasaAsset = {
  nasa_id: string;
  files: unknown;
  duration_seconds: number | null;
  duration_known: boolean;
  thumbnail_url: string | null;
  cached_at: string;
};

const NASA_TIER_SIZE: Record<NasaTier, { width: number; height: number }> = {
  small: { width: 640, height: 360 },
  medium: { width: 1280, height: 720 },
  large: { width: 1920, height: 1080 },
  orig: { width: 3840, height: 2160 },
};

export async function searchNasaFootage(
  query: string,
  opts: { targetWidth: number; seed?: string },
): Promise<StockVideo[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const firstPage = await fetchNasaSearchPage(normalizedQuery, 1);
  const totalHits = Number(firstPage.collection?.metadata?.total_hits ?? 0);
  const maxPage = Math.max(1, Math.ceil(totalHits / NASA_PAGE_SIZE));
  const seededPage = nasaPageForSeed(opts.seed ?? normalizedQuery, maxPage);
  const extraPage = seededPage > 1 ? await fetchNasaSearchPage(normalizedQuery, seededPage) : null;

  const items = dedupeSearchItems(
    extraPage?.collection?.items ?? firstPage.collection?.items ?? [],
  );
  if (items.length === 0) return [];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nasaIds = items
    .map((item) => item.data?.[0]?.nasa_id?.trim())
    .filter((id): id is string => !!id);
  const { data: cachedRows, error: cacheError } = await supabaseAdmin
    .from("nasa_asset_cache")
    .select("nasa_id, files, duration_seconds, duration_known, thumbnail_url, cached_at")
    .in("nasa_id", nasaIds);
  if (cacheError) {
    console.warn("[nasa-stock] asset cache read failed", { error: cacheError.message });
  }

  const cache = new Map(((cachedRows ?? []) as CachedNasaAsset[]).map((row) => [row.nasa_id, row]));
  const resolved = new Array<StockVideo | null>(items.length).fill(null);
  const cacheWrites: Array<{
    nasa_id: string;
    files: never;
    duration_seconds: number | null;
    duration_known: boolean;
    thumbnail_url: string | null;
    cached_at: string;
  }> = [];

  await asyncPool(
    items.map((item, index) => ({ item, index })),
    NASA_RESOLVE_CONCURRENCY,
    async ({ item, index }) => {
      const nasaId = item.data?.[0]?.nasa_id?.trim();
      if (!nasaId) return;
      const thumbnail = selectThumbnailUrl(item.links);
      const cached = cache.get(nasaId);
      if (cached && Date.now() - new Date(cached.cached_at).getTime() < NASA_ASSET_CACHE_TTL_MS) {
        const files = parseCachedFiles(cached.files);
        if (files.length > 0) {
          resolved[index] = toStockVideo({
            nasaId,
            files,
            duration: cached.duration_seconds,
            durationKnown: cached.duration_known,
            thumbnail: cached.thumbnail_url ?? thumbnail,
            targetWidth: opts.targetWidth,
          });
          return;
        }
      }

      try {
        const [files, metadata] = await Promise.all([
          fetchNasaFiles(nasaId),
          fetchNasaMetadata(nasaId).catch((error) => {
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
        });
        cacheWrites.push({
          nasa_id: nasaId,
          files: files as unknown as never,
          duration_seconds: duration,
          duration_known: duration !== null,
          thumbnail_url: thumbnail,
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

  return resolved.filter((video): video is StockVideo => video !== null);
}

async function fetchNasaSearchPage(query: string, page: number): Promise<NasaSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    media_type: "video",
    page_size: String(NASA_PAGE_SIZE),
    page: String(page),
  });
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

function dedupeSearchItems(items: NasaSearchItem[]): NasaSearchItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = item.data?.[0]?.nasa_id?.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function fetchNasaFiles(nasaId: string): Promise<StockVideoFile[]> {
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

async function fetchNasaMetadata(nasaId: string): Promise<NasaMetadata> {
  const res = await fetch(`${NASA_METADATA_URL}/${encodeURIComponent(nasaId)}`);
  if (!res.ok) {
    throw new Error(`NASA metadata lookup failed (${res.status}): ${await safeResponseText(res)}`);
  }
  const locationJson = (await res.json()) as NasaMetadataLocationResponse;
  if (!locationJson.location) throw new Error("NASA metadata response did not include a location.");
  const metadataRes = await fetch(normalizeNasaAssetUrl(locationJson.location));
  if (!metadataRes.ok) {
    throw new Error(
      `NASA metadata file failed (${metadataRes.status}): ${await safeResponseText(metadataRes)}`,
    );
  }
  return (await metadataRes.json()) as NasaMetadata;
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
