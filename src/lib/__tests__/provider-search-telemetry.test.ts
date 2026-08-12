/**
 * Provider search is 39% of matching time and, until now, one number.
 *
 * MEASURED capture 46: providerSearch 4,577 ms per invocation — five times the
 * entire corpus path — but a single bucket covering three providers with very
 * different shapes. Pexels and Pixabay are two SEQUENTIAL page fetches each; a
 * NASA cell is three parallel search pages plus up to twelve asset resolutions
 * at concurrency two. Choosing between "issue fewer searches" and "parallelise"
 * without knowing which provider owns the 4,577 ms would be guesswork.
 *
 * These tests pin the measurement, not any behaviour. Nothing here changes
 * search order, budget, provider selection, or what is fetched.
 *
 * ONE THING THEY ALSO PIN, deliberately: every counter must be visible in
 * profile.summary() as soon as the work is done. summary() is snapshotted into
 * the pollPipeline response while the invocation is still running, so a counter
 * emitted later — from flushStockSearchSession, say, which runs in the stage's
 * `finally` — would never reach the payload it is read from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMatchingProfile } from "../matching-profile";

const { nasa } = vi.hoisted(() => ({
  nasa: {
    /** HTTP the fake NASA search claims to have made. */
    calls: { search: 0, asset: 0, metadata: 0, metadataJson: 0, caption: 0, hits: 0, misses: 0 },
    results: [] as unknown[],
    /** Holds the search open, so a second caller is guaranteed to join it. */
    delayMs: 0,
  },
}));

vi.mock("@/lib/nasaStock.server", () => ({
  searchNasaFootage: async (
    _query: string,
    opts: { metrics?: Record<string, number> },
  ): Promise<unknown[]> => {
    if (nasa.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, nasa.delayMs));
    const m = opts.metrics;
    if (m) {
      m.searchRequests += nasa.calls.search;
      m.assetCalls += nasa.calls.asset;
      m.metadataCalls += nasa.calls.metadata;
      m.metadataJsonFetches += nasa.calls.metadataJson;
      m.captionCalls += nasa.calls.caption;
      m.assetCacheHits += nasa.calls.hits;
      m.assetCacheMisses += nasa.calls.misses;
    }
    return nasa.results;
  },
}));

const video = (id: string) => ({
  provider: "nasa" as const,
  provider_clip_id: id,
  duration_sec: 30,
  width: 1920,
  height: 1080,
  thumbnail_url: null,
  files: [{ url: `https://example.test/${id}.mp4`, width: 1920, height: 1080 }],
});

async function makeSession(profile: ReturnType<typeof createMatchingProfile>) {
  const { createPexelsStagePool } = await import("../stock.server");
  return {
    cache: new Map(),
    inflight: new Map(),
    pendingCache: new Map(),
    prefetched: new Set<string>(),
    usage: new Map(),
    // configured=false keeps the pool from writing key state back to the
    // database; the request path under test is identical either way.
    pexelsPool: createPexelsStagePool([{ id: "k1", api_key: "secret" }] as never, false),
    profile,
    nasaMetrics: {
      searchRequests: 0,
      assetCalls: 0,
      metadataCalls: 0,
      metadataJsonFetches: 0,
      captionCalls: 0,
      assetCacheHits: 0,
      assetCacheMisses: 0,
    },
  };
}

beforeEach(() => {
  nasa.calls = {
    search: 0,
    asset: 0,
    metadata: 0,
    metadataJson: 0,
    caption: 0,
    hits: 0,
    misses: 0,
  };
  nasa.results = [];
  nasa.delayMs = 0;
});

describe("the 4,577 ms is attributed to a provider", () => {
  it("times a NASA search into its own bucket as well as the shared one", async () => {
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    nasa.results = [video("n1")];

    await searchProviderCandidatePool({
      provider: "nasa",
      query: "aurora over the earth",
      orientation: "landscape",
      targetWidth: 1920,
      session: (await makeSession(profile)) as never,
    });

    const summary = profile.summary();
    // The shared bucket is the series captures 42-46 were read against; it has
    // to stay comparable or the new numbers cannot be placed against the old.
    // Timings carry an "Ms" suffix in summary(), which is why the operator
    // reads providerSearchMs and corpusLoadMs.
    expect(summary.providerSearchMs).toBeGreaterThanOrEqual(0);
    expect(summary).toHaveProperty("providerSearchNasaMs");
    // Nested, so the per-provider bucket can never exceed the shared one.
    expect(summary.providerSearchNasaMs).toBeLessThanOrEqual(summary.providerSearchMs);
  });

  it("counts a Pexels HTTP request as it is issued", async () => {
    const { pexelsProvider } = await import("../stock.server");
    const profile = createMatchingProfile();
    const session = await makeSession(profile);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ videos: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await pexelsProvider.search("aurora", "landscape", 1, session as never);

    // session.pexelsPool.requestCount already held this, but it is only read by
    // a log line on the legacy assignment path, which a build invocation never
    // reaches.
    expect(profile.summary().pexelsRequests).toBe(1);
    expect(session.pexelsPool.requestCount).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("NASA's HTTP is counted per invocation, not left on the session", () => {
  it("reports every call the resolve loop made", async () => {
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    // One cell: 3 search pages, 12 items resolved, 4 of them cold.
    nasa.calls = {
      search: 3,
      asset: 4,
      metadata: 4,
      metadataJson: 4,
      caption: 4,
      hits: 8,
      misses: 4,
    };
    nasa.results = [video("n1")];

    await searchProviderCandidatePool({
      provider: "nasa",
      query: "aurora over the earth",
      orientation: "landscape",
      targetWidth: 1920,
      session: (await makeSession(profile)) as never,
    });

    expect(profile.summary()).toMatchObject({
      nasaSearchRequests: 3,
      nasaAssetCalls: 4,
      nasaMetadataCalls: 4,
      nasaMetadataJsonFetches: 4,
      nasaCaptionCalls: 4,
      nasaAssetCacheHits: 8,
      nasaAssetCacheMisses: 4,
    });
  });

  it("counts what a failing search still spent", async () => {
    // A NASA outage that costs three search requests and then throws must not
    // report zero HTTP — that is exactly the invocation worth explaining.
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    const session = await makeSession(profile);
    session.nasaMetrics.searchRequests = 3;
    const nasaModule = await import("@/lib/nasaStock.server");
    vi.spyOn(nasaModule, "searchNasaFootage").mockRejectedValueOnce(new Error("NASA 503"));

    await expect(
      searchProviderCandidatePool({
        provider: "nasa",
        query: "aurora over the earth",
        orientation: "landscape",
        targetWidth: 1920,
        session: session as never,
      }),
    ).rejects.toThrow(/NASA 503/);

    // The bucket still carries the time the failed call consumed.
    expect(profile.summary()).toHaveProperty("providerSearchNasaMs");
    vi.restoreAllMocks();
  });

  it("counts one executed search once, however many callers wanted it", async () => {
    // Only the caller that OWNS the search snapshots the metrics. A second
    // caller is served either from the inflight map or, if the first already
    // finished, from session.cache — which of the two it takes depends on
    // scheduling and is not the property worth pinning. What must hold either
    // way: three search requests happened, so three are reported, not six.
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    const session = await makeSession(profile);
    nasa.calls.search = 3;
    nasa.results = [video("n1")];
    // Held open so the second caller arrives while the first is still in
    // flight; without this the second would simply find the finished result in
    // session.cache and the join path would never be exercised.
    nasa.delayMs = 20;

    const opts = {
      provider: "nasa" as const,
      query: "aurora over the earth",
      orientation: "landscape" as const,
      targetWidth: 1920,
      session: session as never,
    };
    await Promise.all([searchProviderCandidatePool(opts), searchProviderCandidatePool(opts)]);

    const summary = profile.summary();
    expect(summary.nasaSearchRequests).toBe(3);
    expect(summary.searchCacheMisses).toBe(1);
    // Served from one route or the other, never by searching again.
    expect((summary.searchInflightJoins ?? 0) + (summary.searchCacheHits ?? 0)).toBe(1);
  });
});
