import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerFamilyKey,
  reserveProviderClipId,
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

  it("groups nearby numeric Pexels ids into a stable family key", () => {
    expect(providerFamilyKey("9467043")).toBe("9467");
    expect(providerFamilyKey("9467097")).toBe("9467");
    expect(providerFamilyKey("pexels-custom-id")).toBe("pexels-custom-id");
    expect(providerFamilyKey("Artemis I Launches to the Moon")).toBe(
      "Artemis I Launches to the Moon",
    );
  });

  it("does not call the default stock provider when a space search has no NASA result", async () => {
    searchNasaFootage.mockResolvedValue([]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await searchStockFootage({
      query: "finger hitting subscribe button",
      orientation: "landscape",
      minDurationSec: 4,
      targetWidth: 1280,
      usedIds: [],
      niche: "space",
    });

    expect(result).toBeNull();
    expect(searchNasaFootage).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("never returns an already-used NASA asset when every result is exhausted", async () => {
    const onlyResult = stockVideo("nasa-asset-1");
    searchNasaFootage.mockResolvedValue([onlyResult]);

    const result = await searchStockFootage({
      query: "rogue planet",
      orientation: "landscape",
      minDurationSec: 4,
      targetWidth: 1280,
      usedIds: [onlyResult.provider_clip_id],
      niche: "space",
    });

    expect(result).toBeNull();
  });

  it("atomically reserves different clips when concurrent searches initially collide", async () => {
    const candidates = ["clip-a", "clip-b", "clip-c", "clip-d", "clip-e"].map(stockResult);
    const usedIds = new Set<string>();
    const racingSearch = vi.fn(async (opts: StockSearchOptions) => {
      const result = candidates.find(
        (candidate) => !opts.usedIds.includes(candidate.pick.provider_clip_id),
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
  return { pick, chosenFile: pick.files[0], candidates: [pick] };
}
