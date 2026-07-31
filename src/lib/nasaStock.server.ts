import type { StockVideo, StockVideoFile } from "@/lib/stock.server";

const NASA_SEARCH_URL = "https://images-api.nasa.gov/search";
const NASA_ASSET_URL = "https://images-api.nasa.gov/asset";
const NASA_METADATA_URL = "https://images-api.nasa.gov/metadata";
const NASA_MAX_SEARCH_RESULTS = 6;

type NasaSearchResponse = {
  collection?: {
    items?: Array<{
      data?: Array<{
        nasa_id?: string;
        title?: string;
      }>;
      links?: NasaLink[];
    }>;
  };
};

type NasaLink = {
  href?: string;
  rel?: string;
  render?: string;
  width?: number;
};

type NasaAssetResponse = {
  collection?: {
    items?: Array<{ href?: string }>;
  };
};

type NasaMetadataLocationResponse = {
  location?: string;
};

type NasaMetadata = Record<string, unknown>;

type NasaTier = "small" | "medium" | "large" | "orig";

const NASA_TIER_WIDTH: Record<NasaTier, number> = {
  small: 640,
  medium: 1280,
  large: 1920,
  orig: 3840,
};

const NASA_TIER_HEIGHT: Record<NasaTier, number> = {
  small: 360,
  medium: 720,
  large: 1080,
  orig: 2160,
};

export async function searchNasaFootage(
  query: string,
  opts: { targetWidth: number },
): Promise<StockVideo[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const params = new URLSearchParams({
    q: normalizedQuery,
    media_type: "video",
    page_size: String(NASA_MAX_SEARCH_RESULTS),
  });

  const searchRes = await fetch(`${NASA_SEARCH_URL}?${params.toString()}`);
  if (!searchRes.ok) {
    throw new Error(
      `NASA search failed (${searchRes.status}): ${await safeResponseText(searchRes)}`,
    );
  }

  const searchJson = (await searchRes.json()) as NasaSearchResponse;
  const items = searchJson.collection?.items?.slice(0, NASA_MAX_SEARCH_RESULTS) ?? [];
  const videos: StockVideo[] = [];

  for (const item of items) {
    const nasaId = item.data?.[0]?.nasa_id?.trim();
    if (!nasaId) continue;

    try {
      const [files, metadata] = await Promise.all([
        fetchNasaFiles(nasaId, opts.targetWidth),
        fetchNasaMetadata(nasaId),
      ]);
      const duration = parseNasaDurationSeconds(
        metadata["QuickTime:Duration"] ?? metadata["QuickTime:MediaDuration"],
      );
      if (!duration || files.length === 0) continue;

      videos.push({
        provider: "nasa",
        provider_clip_id: nasaId,
        duration_sec: duration,
        width: files[0].width,
        height: files[0].height,
        thumbnail_url: selectThumbnailUrl(item.links),
        files,
      });
    } catch (error) {
      console.warn("[nasa-stock] skipping unusable NASA result", {
        nasaId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return videos;
}

async function fetchNasaFiles(nasaId: string, targetWidth: number): Promise<StockVideoFile[]> {
  const res = await fetch(`${NASA_ASSET_URL}/${encodeURIComponent(nasaId)}`);
  if (!res.ok) {
    throw new Error(`NASA asset lookup failed (${res.status}): ${await safeResponseText(res)}`);
  }

  const json = (await res.json()) as NasaAssetResponse;
  const files = (json.collection?.items ?? [])
    .map((item) => item.href)
    .filter((href): href is string => !!href && /\.mp4($|\?)/i.test(href))
    .map((href) => {
      const tier = nasaTierFromUrl(href);
      if (!tier) return null;
      return {
        tier,
        file: {
          url: normalizeNasaAssetUrl(href),
          width: NASA_TIER_WIDTH[tier],
          height: NASA_TIER_HEIGHT[tier],
        },
      };
    })
    .filter((entry): entry is { tier: NasaTier; file: StockVideoFile } => entry !== null);

  return files
    .sort((a, b) => nasaTierScore(a.tier, targetWidth) - nasaTierScore(b.tier, targetWidth))
    .map((entry) => entry.file);
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

export function parseNasaDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
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

function nasaTierFromUrl(url: string): NasaTier | null {
  const match = /~(small|medium|large|orig)\.mp4(?:$|\?)/i.exec(url);
  return match ? (match[1].toLowerCase() as NasaTier) : null;
}

function nasaTierScore(tier: NasaTier, targetWidth: number): number {
  const width = NASA_TIER_WIDTH[tier];
  if (tier === "orig") return 10_000;
  if (width >= targetWidth) return width - targetWidth;
  return 5_000 + (targetWidth - width);
}

function selectThumbnailUrl(links: NasaLink[] | undefined): string | null {
  const imageLinks = (links ?? []).filter((link) => link.href && link.render === "image");
  const preview = imageLinks.find((link) => link.rel === "preview") ?? imageLinks[0];
  return preview?.href ? normalizeNasaAssetUrl(preview.href) : null;
}

function normalizeNasaAssetUrl(url: string): string {
  const parsed = new URL(
    url.replace(/^http:\/\/images-assets\.nasa\.gov/i, "https://images-assets.nasa.gov"),
  );
  return parsed.href;
}

async function safeResponseText(res: Response): Promise<string> {
  return (await res.text().catch(() => res.statusText)).slice(0, 300);
}
