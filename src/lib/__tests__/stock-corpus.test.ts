import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchProviderCandidatePool, prefetchStockProviderCache } = vi.hoisted(() => ({
  searchProviderCandidatePool: vi.fn(),
  prefetchStockProviderCache: vi.fn(async () => undefined),
}));

vi.mock("../stock.server", () => ({
  buildNasaSourceWindows: () => [0],
  expandNasaQueries: (query: string) => [query],
  prefetchStockProviderCache,
  searchProviderCandidatePool,
  stockQueryTokens: (query: string) =>
    query
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  stockReservationKey: (provider: string, id: string, inPoint = 0) =>
    provider === "nasa" ? `${provider}:${id}:${inPoint}` : `${provider}:${id}`,
}));

import { clusterStockQueries, matchStockCorpus } from "../stock-corpus.server";

function video(id: string) {
  return {
    provider: "pexels" as const,
    provider_clip_id: id,
    duration_sec: 20,
    duration_known: true,
    width: 1920,
    height: 1080,
    thumbnail_url: null,
    files: [{ url: `https://example.test/${id}.mp4`, width: 1920, height: 1080 }],
  };
}

describe("stock corpus clustering and assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchProviderCandidatePool.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => video(`clip-${index + 1}`)),
    );
  });

  it("clusters a 145-scene corpus into the intended request-saving range", () => {
    const demands = Array.from({ length: 145 }, (_, index) => ({
      id: `scene-${index}`,
      query: `topic ${index % 12} event ${index % 7}`,
      minDurationSec: 4,
      seed: `project:scene-${index}`,
    }));

    const first = clusterStockQueries(demands);
    const second = clusterStockQueries(demands);

    expect(first).toHaveLength(37);
    expect(first).toEqual(second);
    expect(first.flatMap((bucket) => bucket.demandIds)).toHaveLength(145);
  });

  it("assigns unique clips from the shared project pool deterministically", async () => {
    const demands = Array.from({ length: 6 }, (_, index) => ({
      id: `scene-${index}`,
      query: `planet orbit ${index % 2}`,
      minDurationSec: 4,
      seed: `project-a:scene-${index}`,
    }));
    const session = {
      cache: new Map(),
      inflight: new Map(),
      pendingCache: new Map(),
      usage: new Map(),
      pexelsPool: {
        configured: true,
        keys: [],
        initialCount: 0,
        rejectedIds: new Set<string>(),
        unavailableIds: new Set<string>(),
        deactivationPromises: new Map(),
        requestCount: 0,
        requestLimit: 120,
      },
    };

    const result = await matchStockCorpus({
      projectId: "project-a",
      demands,
      orientation: "landscape",
      targetWidth: 1920,
      niche: "general",
      usedIds: new Set(),
      session,
    });

    expect(result.size).toBe(6);
    expect(new Set([...result.values()].map((item) => item.reservationKey)).size).toBe(6);
    expect(prefetchStockProviderCache).toHaveBeenCalled();
    expect(searchProviderCandidatePool).toHaveBeenCalledTimes(6);
  });

  it("prefers a scene's own query bucket before adjacent fallback buckets", async () => {
    searchProviderCandidatePool.mockImplementation(async ({ query }: { query: string }) => [
      video(query.includes("ocean") ? "ocean-clip" : "desert-clip"),
    ]);
    const session = {
      cache: new Map(),
      inflight: new Map(),
      pendingCache: new Map(),
      usage: new Map(),
      pexelsPool: {
        configured: true,
        keys: [],
        initialCount: 0,
        rejectedIds: new Set<string>(),
        unavailableIds: new Set<string>(),
        deactivationPromises: new Map(),
        requestCount: 0,
        requestLimit: 120,
      },
    };

    const result = await matchStockCorpus({
      projectId: "project-b",
      demands: [
        { id: "ocean", query: "deep ocean coral", minDurationSec: 4, seed: "b:ocean" },
        { id: "desert", query: "dry desert dunes", minDurationSec: 4, seed: "b:desert" },
      ],
      orientation: "landscape",
      targetWidth: 1920,
      niche: "general",
      usedIds: new Set(),
      session,
    });

    expect(result.get("ocean")?.pick.provider_clip_id).toBe("ocean-clip");
    expect(result.get("desert")?.pick.provider_clip_id).toBe("desert-clip");
  });
});
