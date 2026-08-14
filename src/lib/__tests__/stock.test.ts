import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerFamilyKey,
  reserveProviderClipId,
  rotatePexelsKeysForRequest,
  selectStockCandidate,
  searchStockFootage,
  searchUniqueStockFootage,
  sourceDurationBudgetSeconds,
  withinSourceDurationBudget,
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
    delete process.env.PIXABAY_API_KEY;
  });

  it("does not collapse unrelated numeric Pexels ids into one family", () => {
    expect(providerFamilyKey("9467043")).toBe("9467043");
    expect(providerFamilyKey("9467097")).toBe("9467097");
    expect(providerFamilyKey("pexels-custom-id")).toBe("pexels-custom-id");
    expect(providerFamilyKey("Artemis I Launches to the Moon")).toBe(
      "Artemis I Launches to the Moon",
    );
  });

  it("matches through NASA to Pexels when Pixabay is unconfigured", async () => {
    searchNasaFootage.mockResolvedValue([]);
    process.env.PEXELS_API_KEY = "test-key";
    delete process.env.PIXABAY_API_KEY;
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
    // ONE request, not two. Page 1 returned a single video against a page size
    // of 80, so there is no page 2 to fetch — measured over 15,058 cached rows,
    // 91% of the page-2 fetches Pexels used to make were guaranteed empty. The
    // fetch count was never the property under test here; the fall-through from
    // NASA to Pexels is, and it is unchanged.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.every(([url]) => String(url).includes("api.pexels.com"))).toBe(true);
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

describe("source duration budget (round 6, Issue 1)", () => {
  function pexelsVideo(id: string, durationSec: number): StockVideo {
    return {
      provider: "pexels",
      provider_clip_id: id,
      duration_sec: durationSec,
      duration_known: true,
      width: 1920,
      height: 1080,
      thumbnail_url: null,
      files: [{ url: `https://videos.pexels.com/${id}.mp4`, width: 1920, height: 1080 }],
    };
  }

  it("computes a budget that never drops below the floor", () => {
    expect(sourceDurationBudgetSeconds(1)).toBe(30); // 1*6 < 30 → floor
    expect(sourceDurationBudgetSeconds(10)).toBe(60); // 10*6 = 60
  });

  it("treats unknown-duration sources (e.g. NASA) as within budget", () => {
    const nasa = {
      ...pexelsVideo("nasa-1", 9999),
      provider: "nasa" as const,
      duration_known: false,
    };
    expect(withinSourceDurationBudget(nasa, 4)).toBe(true);
  });

  it("classifies a 4-minute source as over budget for a 5-second scene", () => {
    expect(withinSourceDurationBudget(pexelsVideo("long", 240), 5)).toBe(false);
    expect(withinSourceDurationBudget(pexelsVideo("short", 15), 5)).toBe(true);
  });

  it("never selects an over-budget source when shorter candidates exist", () => {
    // Index 0 is the longest (highest API relevance) but 4 minutes long; the rest
    // are short. The 4-minute source must never be chosen across many seeds.
    const candidates: StockVideo[] = [
      pexelsVideo("long-240s", 240),
      ...Array.from({ length: 9 }, (_, i) => pexelsVideo(`short-${i}`, 12 + i)),
    ];
    const picks = new Set(
      Array.from(
        { length: 40 },
        (_, i) =>
          selectStockCandidate({
            results: candidates,
            minDurationSec: 5,
            targetWidth: 1920,
            usedIds: [],
            seed: `project-${i}:scene-1`,
          })?.pick.provider_clip_id,
      ),
    );
    expect(picks.has("long-240s")).toBe(false);
    expect(picks.size).toBeGreaterThan(1); // still varies across the short pool
  });

  it("falls back to a long source only when nothing fits the budget", () => {
    const candidates = [pexelsVideo("long-a", 300), pexelsVideo("long-b", 280)];
    const result = selectStockCandidate({
      results: candidates,
      minDurationSec: 5,
      targetWidth: 1920,
      usedIds: [],
      seed: "project-x:scene-1",
    });
    expect(result).not.toBeNull();
    expect(["long-a", "long-b"]).toContain(result?.pick.provider_clip_id);
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
    fallbackUrls: [],
  };
}
