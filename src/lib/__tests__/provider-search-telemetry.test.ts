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

const { nasa, pixabay } = vi.hoisted(() => ({
  nasa: {
    /** HTTP the fake NASA search claims to have made. */
    calls: { search: 0, asset: 0, metadata: 0, metadataJson: 0, caption: 0, hits: 0, misses: 0 },
    results: [] as unknown[],
    /** Holds the search open, so a second caller is guaranteed to join it. */
    delayMs: 0,
    /** Live concurrency of the mock search, and the highest it ever reached. */
    active: 0,
    maxActive: 0,
    /** Queries whose search should throw after the delay. */
    failQueries: [] as string[],
  },
  pixabay: { pages: [] as number[], results: [] as unknown[] },
}));

vi.mock("@/lib/nasaStock.server", () => ({
  searchNasaFootage: async (
    query: string,
    opts: { metrics?: Record<string, number> },
  ): Promise<unknown[]> => {
    nasa.active += 1;
    nasa.maxActive = Math.max(nasa.maxActive, nasa.active);
    try {
      if (nasa.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, nasa.delayMs));
      if (nasa.failQueries.includes(query)) throw new Error(`NASA 429 for ${query}`);
    } finally {
      nasa.active -= 1;
    }
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

vi.mock("@/lib/pixabayStock.server", () => ({
  pixabayProvider: {
    name: "pixabay",
    search: async (_q: string, _o: string, page: number) => {
      pixabay.pages.push(page);
      return pixabay.results;
    },
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
  nasa.active = 0;
  nasa.maxActive = 0;
  nasa.failQueries = [];
  pixabay.pages = [];
  pixabay.results = [];
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

/**
 * Page 2 is fetched only when page 1 could have a successor.
 *
 * MEASURED 2026-08-13 over 15,058 cached Pexels rows: 5,296 had a non-empty
 * page 1 and therefore fetched page 2, but only 466 reached a full first page.
 * 4,830 guaranteed-empty round trips — 91% of the page-2 fetches Pexels makes.
 *
 * The provider restriction is load-bearing, not caution. pexelsProvider.search
 * maps the API's `videos` array one-to-one, so a short page IS the end of the
 * results. pixabayProvider.search flatMaps and drops any hit whose renditions
 * are unusable, so a FULL page of 80 hits can return fewer than 80 videos.
 */
describe("Pexels stops asking for a second page that cannot exist", () => {
  const pexelsPage = (count: number, offset = 0) =>
    new Response(
      JSON.stringify({
        videos: Array.from({ length: count }, (_, i) => ({
          id: 1000 + offset + i,
          width: 1920,
          height: 1080,
          duration: 12,
          image: "https://example.test/t.jpg",
          video_files: [{ link: `https://example.test/${i}.mp4`, width: 1920, height: 1080 }],
        })),
      }),
      { status: 200 },
    );

  const searchPexels = async (pageSizes: number[]) => {
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    const fetchMock = vi.fn();
    pageSizes.forEach((size, page) =>
      fetchMock.mockResolvedValueOnce(pexelsPage(size, page * 1000)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchProviderCandidatePool({
      provider: "pexels",
      query: "aurora over the earth",
      orientation: "landscape",
      targetWidth: 1920,
      session: (await makeSession(profile)) as never,
    });
    vi.unstubAllGlobals();
    return { calls: fetchMock.mock.calls.length, results, summary: profile.summary() };
  };

  it("fetches one page when page 1 is short", async () => {
    const { calls, results, summary } = await searchPexels([9]);
    expect(calls).toBe(1);
    expect(results).toHaveLength(9);
    expect(summary.pexelsSecondPageSkipped).toBe(1);
  });

  it("still fetches page 2 when page 1 is full", async () => {
    const { calls, results, summary } = await searchPexels([80, 12]);
    expect(calls).toBe(2);
    expect(results).toHaveLength(92);
    expect(summary.pexelsSecondPageSkipped).toBeUndefined();
  });

  it("fetches nothing more when page 1 is empty", async () => {
    const { calls, results } = await searchPexels([0]);
    expect(calls).toBe(1);
    expect(results).toEqual([]);
  });

  it("does NOT apply the rule to Pixabay, whose short page can still have a successor", async () => {
    // pixabayProvider.search drops hits with no usable rendition, so a FULL page
    // of 80 hits can return far fewer than 80 videos. Treating that as the end
    // of the results would silently lose footage — and Pixabay's own numbers say
    // it matters: 3,327 of its 3,340 page-2 fetches were justified.
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    pixabay.results = [video("px-1")];

    await searchProviderCandidatePool({
      provider: "pixabay",
      query: "aurora over the earth",
      orientation: "landscape",
      targetWidth: 1920,
      session: (await makeSession(profile)) as never,
    });

    expect(pixabay.pages).toEqual([1, 2]);
    expect(profile.summary().pexelsSecondPageSkipped).toBeUndefined();
  });
});

/**
 * NASA searches are capped process-wide, not per invocation.
 *
 * MEASURED 2026-08-14, two concurrent batched projects: the per-batch cap of 2
 * still allowed 2 projects x 2 cells x 3 pages = 12 simultaneous requests on
 * an unkeyed API, and 86% / 82% of NASA cells failed with the rate-limit
 * signature — first invocation clean at 182ms/request, fast ~35ms rejections
 * from the second invocation on. The semaphore in stock.server.ts is the
 * enforcer; the batch sub-cap remains only a scheduler.
 *
 * All starts are STAGGERED, never Promise.all from cold: concurrent dynamic
 * imports of a vi.mock'd module race inside vitest's mocker and one caller
 * can receive the real module (see the overlap test above).
 */
describe("NASA searches are capped process-wide", () => {
  const stagger = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const searchAs = async (query: string) => {
    const { searchProviderCandidatePool } = await import("../stock.server");
    // Each search gets its OWN session — the cross-project shape the
    // per-invocation cap could not cover.
    return searchProviderCandidatePool({
      provider: "nasa",
      query,
      orientation: "landscape",
      targetWidth: 1920,
      session: (await makeSession(createMatchingProfile())) as never,
    });
  };

  it("never runs more than two searches at once, even across sessions", async () => {
    nasa.delayMs = 60;
    const runs: Array<Promise<unknown>> = [];
    for (const query of ["cap query one", "cap query two", "cap query three", "cap query four"]) {
      runs.push(searchAs(query));
      await stagger(10);
    }
    await Promise.all(runs);
    // Four searches wanted to run; the third and fourth had to wait.
    expect(nasa.maxActive).toBe(2);
  });

  it("releases the slot when a search throws, so a failure cannot shrink the cap", async () => {
    // Two failing searches occupy and release both slots; if either leaked,
    // the pool would be down to 1 and the pair after them could not overlap.
    nasa.delayMs = 30;
    nasa.failQueries = ["leak probe one", "leak probe two"];
    const failures = [searchAs("leak probe one")];
    await stagger(10);
    failures.push(searchAs("leak probe two"));
    const settled = await Promise.allSettled(failures);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);

    nasa.maxActive = 0;
    const pair = [searchAs("after failure one")];
    await stagger(10);
    pair.push(searchAs("after failure two"));
    await Promise.all(pair);
    expect(nasa.maxActive).toBe(2);
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

  it("does not let overlapping searches read each other's requests", async () => {
    // The bucket-parallel corpus build (B3) makes overlap the normal case.
    // The old accounting snapshotted the SHARED session object before and
    // after each search, so two concurrent searches each saw the other's
    // requests in their "after" and nasaSearchRequests roughly doubled —
    // 9 or 12 reported for 6 real requests, depending on timing. Isolation
    // means each search counts only its own metrics object.
    const { searchProviderCandidatePool } = await import("../stock.server");
    const profile = createMatchingProfile();
    const session = await makeSession(profile);
    nasa.calls.search = 3;
    nasa.results = [video("n1")];
    // Held open long enough that the second search starts while the first is
    // still in flight. DIFFERENT queries, so the inflight map cannot collapse
    // them into one search.
    nasa.delayMs = 50;

    const search = (query: string) =>
      searchProviderCandidatePool({
        provider: "nasa",
        query,
        orientation: "landscape",
        targetWidth: 1920,
        session: session as never,
      });

    // STAGGERED starts, overlapping searches — deliberately not Promise.all of
    // both from cold. searchProviderCandidatePool begins with a dynamic
    // import of nasaStock.server, and two of those imports resolving
    // CONCURRENTLY race inside vitest's mocker: one receives the mock and the
    // other the REAL module (verified by stack trace — index 1 reached the
    // real fetchNasaSearchPage). That is a test-runner artifact, not a
    // production hazard; Node's module registry has no such race. The 10ms
    // stagger lets the second import resolve alone while the first SEARCH is
    // still held open, which is the overlap this test is about.
    const first = search("aurora over the earth");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = search("solar flare eruption timelapse");
    await Promise.all([first, second]);

    // Two searches, three requests each: exactly six, however they interleaved.
    expect(profile.summary().nasaSearchRequests).toBe(6);
    expect(session.nasaMetrics.searchRequests).toBe(6);
    expect(profile.summary().searchCacheMisses).toBe(2);
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
