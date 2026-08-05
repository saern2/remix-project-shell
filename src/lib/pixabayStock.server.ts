import type {
  Orientation,
  StockProvider,
  StockSearchSession,
  StockVideo,
  StockVideoFile,
} from "@/lib/stock.server";

const PIXABAY_VIDEO_URL = "https://pixabay.com/api/videos/";

type PixabayRendition = {
  url?: string;
  width?: number;
  height?: number;
  /**
   * Bytes. Pixabay is the one provider that reports this, and dropping it was
   * how a 235 MB rendition got selected against the worker's 150 MB ceiling —
   * the size was in the search response we already had (round 7).
   */
  size?: number;
  thumbnail?: string;
};

type PixabayHit = {
  id?: number;
  duration?: number;
  tags?: string;
  videos?: Record<string, PixabayRendition>;
};

export const pixabayProvider: StockProvider = {
  name: "pixabay",
  async search(query, orientation, page, session) {
    const apiKey = process.env.PIXABAY_API_KEY?.trim();
    if (!apiKey) return [];

    const params = new URLSearchParams({
      key: apiKey,
      q: query.slice(0, 100),
      orientation: pixabayOrientation(orientation),
      safesearch: "true",
      per_page: "80",
      page: String(page),
    });
    recordRequest(session);
    const response = await fetch(`${PIXABAY_VIDEO_URL}?${params.toString()}`);
    if (!response.ok) {
      console.warn("[pixabay] search request unavailable", {
        status: response.status,
        detail: (await response.text().catch(() => response.statusText)).slice(0, 200),
      });
      return [];
    }

    const payload = (await response.json()) as { hits?: PixabayHit[] };
    return (payload.hits ?? []).flatMap(toStockVideo);
  },
};

function toStockVideo(hit: PixabayHit): StockVideo[] {
  if (!Number.isFinite(hit.id) || !hit.videos) return [];
  const files = Object.values(hit.videos)
    .filter(
      (
        file,
      ): file is Required<Pick<PixabayRendition, "url" | "width" | "height">> & PixabayRendition =>
        typeof file.url === "string" &&
        Number.isFinite(file.width) &&
        Number.isFinite(file.height) &&
        Number(file.width) > 0 &&
        Number(file.height) > 0,
    )
    .map((file): StockVideoFile => ({
      url: file.url,
      width: Number(file.width),
      height: Number(file.height),
      ...(Number.isFinite(file.size) && Number(file.size) > 0 ? { bytes: Number(file.size) } : {}),
    }));
  if (files.length === 0) return [];

  const largest = [...files].sort((a, b) => b.width - a.width)[0];
  const thumbnail =
    Object.values(hit.videos).find((file) => typeof file.thumbnail === "string")?.thumbnail ?? null;
  const keywords = (hit.tags ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return [
    {
      provider: "pixabay",
      provider_clip_id: String(hit.id),
      duration_sec: Math.max(0, Number(hit.duration ?? 0)),
      duration_known: true,
      width: largest.width,
      height: largest.height,
      thumbnail_url: thumbnail,
      files,
      title: hit.tags?.trim(),
      keywords,
    },
  ];
}

function pixabayOrientation(orientation: Orientation): "horizontal" | "vertical" | "all" {
  if (orientation === "landscape") return "horizontal";
  if (orientation === "portrait") return "vertical";
  return "all";
}

function recordRequest(session?: StockSearchSession) {
  if (!session) return;
  const counts = session.usage.get("pixabay") ?? { requests: 0, cacheHits: 0 };
  counts.requests += 1;
  session.usage.set("pixabay", counts);
}
