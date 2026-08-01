import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerFamilyKey,
  reserveProviderClipId,
  rotatePexelsKeysForRequest,
  selectStockCandidate,
  searchStockFootage,
  searchUniqueStockFootage,
  type StockSearchOptions,
  type StockSearchResult,
  type StockVideo,
} from "../stock.server";

const { searchNasaFootage } = vi.hoisted(() => ({
  searchNasaFootage: vi.fn(),
}));

vi.mock("../nasaStock.server", () => ({
  searchNasaFootage,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const cacheQuery = {
    eq: () => cacheQuery,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return {
    supabaseAdmin: {
      from: () => ({
        select: () => cacheQuery,
        upsert: async () => ({ error: null }),
      }),
      rpc: async () => ({ error: null }),
    },
  };
});

describe("stock footage diversity helpers", () => {
  beforeEach(() => {
    searchNasaFootage.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PEXELS_API_KEY;
  });

  it("does not collapse unrelated numeric Pexels ids into one family", () => {
    expect(providerFamilyKey("9467043")).toBe("9467043");
    expect(providerFamilyKey("9467097")).toBe("9467097");
    expect(providerFamilyKey("pexels-custom-id")).toBe("pexels-custom-id");
    expect(providerFamilyKey("Artemis I Launches to the Moon")).toBe(
      "Artemis I Launches to the Moon",
    );
  });

  it("falls back to niche-biased Pexels when both NASA searches are empty", async () => {
    searchNasaFootage.mockResolvedValue([]);
    process.env.PEXELS_API_KEY = "test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            videos: [
              {
                id: 123,
                width: 1920,
                height: 1080,
                duration: 20,
                image: "https://example.com/thumb.jpg",
                video_files: [{ link: "https://example.com/video.mp4", width: 1920, height: 1080 }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await searchStockFootage({
      query: "finger hitting subscribe button",
      orientation: "landscape",
      minDurationSec: 4,
      targetWidth: 1280,
      usedIds: [],
      niche: "space",
    });

    expect(result?.pick.provider).toBe("pexels");
    expect(searchNasaFootage).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("space+astronomy+cosmos");
  });

  it("deduplicates NASA footage by asset and source-time bucket", async () => {
    const onlyResult = stockVideo("nasa-asset-1");
    searchNasaFootage.mockResolvedValue([onlyResult]);
    const options: StockSearchOptions = {
      query: "rogue planet",
      orientation: "landscape",
      minDurationSec: 4,
      targetWidth: 1280,
      usedIds: [],
      niche: "space",
      seed: "project-a:scene-a",
    };
    const first = await searchStockFootage(options);
    expect(first).not.toBeNull();
    const result = await searchStockFootage({ ...options, usedIds: [first!.reservationKey] });

    expect(result).toBeNull();
  });

  it("rotates a 429 key without marking it dead", async () => {
    const dead = vi.fn(async () => undefined);
    const limited = vi.fn(async () => undefined);
    const success = vi.fn(async () => undefined);
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await rotatePexelsKeysForRequest({
      keys: [
        { id: "key-1", api_key: "one" },
        { id: "key-2", api_key: "two" },
      ],
      request,
      onDead: dead,
      onRateLimited: limited,
      onSuccess: success,
    });

    expect(response?.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
    expect(limited).toHaveBeenCalledWith("key-1", expect.objectContaining({ status: 429 }));
    expect(dead).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("key-2", expect.objectContaining({ status: 200 }));
  });

  it("uses the project seed to select different clips from the top candidates", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => stockVideo(`clip-${index}`));
    const selections = new Set(
      Array.from(
        { length: 20 },
        (_, index) =>
          selectStockCandidate({
            results: candidates,
            minDurationSec: 4,
            targetWidth: 1280,
            usedIds: [],
            seed: `project-${index}:scene-1`,
          })?.pick.provider_clip_id,
      ),
    );
    expect(selections.size).toBeGreaterThan(1);
  });

  it("atomically reserves different clips when concurrent searches initially collide", async () => {
    const candidates = ["clip-a", "clip-b", "clip-c", "clip-d", "clip-e"].map(stockResult);
    const usedIds = new Set<string>();
    const racingSearch = vi.fn(async (opts: StockSearchOptions) => {
      const result = candidates.find(
        (candidate) => !opts.usedIds.includes(candidate.reservationKey),
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      return result ?? null;
    });

    const results = await Promise.all(
      ["scene-1", "scene-2", "scene-3", "scene-4", "scene-5"].map((seed) =>
        searchUniqueStockFootage(
          {
            query: "planet",
            orientation: "landscape",
            minDurationSec: 2,
            targetWidth: 1280,
            usedIds,
            seed,
          },
          racingSearch,
        ),
      ),
    );

    expect(results.map((result) => result?.pick.provider_clip_id)).toEqual([
      "clip-a",
      "clip-b",
      "clip-c",
      "clip-d",
      "clip-e",
    ]);
    expect(usedIds.size).toBe(5);
  });

  it("allows exactly one synchronous reservation for a provider clip", () => {
    const usedIds = new Set<string>();
    expect(reserveProviderClipId(usedIds, "same-clip")).toBe(true);
    expect(reserveProviderClipId(usedIds, "same-clip")).toBe(false);
  });
});

function stockVideo(id: string): StockVideo {
  return {
    provider: "nasa",
    provider_clip_id: id,
    duration_sec: 30,
    width: 1920,
    height: 1080,
    thumbnail_url: `https://example.com/${id}.jpg`,
    files: [{ url: `https://example.com/${id}.mp4`, width: 1920, height: 1080 }],
  };
}

function stockResult(id: string): StockSearchResult {
  const pick = stockVideo(id);
  return {
    pick,
    chosenFile: pick.files[0],
    candidates: [pick],
    inPoint: 0,
    reservationKey: `nasa:${id}:0`,
  };
}
