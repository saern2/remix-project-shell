/**
 * A full 145-scene project, end to end through the real corpus + assignment.
 *
 * This is the run that failed in production: "Pexels and Pixabay could not
 * supply unique footage for 5 scene(s)" — 140 scenes matched, 5 could not be
 * unique, and the whole project failed. Two defects combined:
 *
 *   - clustering was sliced along with matching, so each 5-scene slice built its
 *     own buckets and searched its own queries (244 cache misses vs 33 hits) and
 *     assignment only ever saw its own slice's pools
 *   - exhausting unique candidates failed the project outright
 *
 * The provider here is a simulator, not a mock of the code under test: it returns
 * a realistic, finite catalogue and counts every distinct search. That is what
 * makes the cache-miss number meaningful — it is the number of provider queries
 * the real system would have issued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  matchStockCorpus,
  clusterStockQueries,
  MIN_REUSE_SCENE_DISTANCE,
  NEVER_REUSE_WITHIN,
  type StockDemand,
} from "../stock-corpus.server";
import type { StockSearchSession, StockVideo } from "../stock.server";

const SCENE_COUNT = 145;
/**
 * Distinct sources the simulated catalogue can offer per bucket query. Kept
 * deliberately tight so uniqueness is genuinely contended — a generous
 * catalogue would pass without exercising the fallback tiers at all.
 */
const CATALOGUE_PER_QUERY = 14;

const searchedQueries: string[] = [];

/** Deterministic catalogue: a query maps to a stable set of sources. */
function catalogueFor(query: string, provider: "pexels" | "pixabay"): StockVideo[] {
  searchedQueries.push(`${provider}:${query}`);
  const topic = query.split(" ")[0] ?? "x";
  return Array.from({ length: CATALOGUE_PER_QUERY }, (_, i) => {
    const id = `${provider}-${topic}-${i}`;
    return {
      provider,
      provider_clip_id: id,
      duration_sec: 20 + (i % 5) * 10,
      duration_known: true,
      width: 1920,
      height: 1080,
      thumbnail_url: null,
      files: [
        { url: `https://cdn.test/${id}_small.mp4`, width: 640, height: 360, bytes: 4_000_000 },
        { url: `https://cdn.test/${id}_large.mp4`, width: 1920, height: 1080, bytes: 40_000_000 },
      ],
      title: query,
      keywords: query.split(" "),
    };
  });
}

vi.mock("../stock.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stock.server")>();
  return {
    ...actual,
    prefetchStockProviderCache: vi.fn(async () => undefined),
    searchProviderCandidatePool: vi.fn(
      async ({ provider, query }: { provider: "pexels" | "pixabay" | "nasa"; query: string }) =>
        provider === "nasa" ? [] : catalogueFor(query, provider),
    ),
  };
});

function session(): StockSearchSession {
  return {
    cache: new Map(),
    inflight: new Map(),
    pendingCache: new Map(),
    prefetched: new Set(),
    usage: new Map(),
    pexelsPool: {
      configured: true,
      keys: [],
      initialCount: 0,
      rejectedIds: new Set(),
      unavailableIds: new Set(),
      deactivationPromises: new Map(),
      requestCount: 0,
      requestLimit: 1000,
    },
  };
}

/** 145 scenes over a modest topic vocabulary — the shape that starved. */
function buildDemands(): StockDemand[] {
  const topics = [
    "nebula clouds",
    "galaxy spiral",
    "planet surface",
    "rocket launch",
    "astronaut spacewalk",
    "star field",
    "solar flare",
    "moon crater",
    "comet tail",
    "space station",
  ];
  return Array.from({ length: SCENE_COUNT }, (_, index) => ({
    id: `scene-${index}`,
    query: `${topics[index % topics.length]} ${Math.floor(index / topics.length)}`,
    minDurationSec: 5,
    seed: `project:scene-${index}`,
    sceneIndex: index,
  }));
}

describe("145-scene project through the project-wide corpus", () => {
  beforeEach(() => {
    searchedQueries.length = 0;
  });

  it("matches every scene, never fails, and degrades visibly when it must", async () => {
    const demands = buildDemands();

    // ── Corpus phase: cluster ONCE over all 145 scenes ──────────────────────
    const buckets = clusterStockQueries(demands);
    const { searchProviderCandidatePool } = await import("../stock.server");
    const corpus = [];
    for (const bucket of buckets) {
      const candidates: StockVideo[] = [];
      for (const provider of ["pexels", "pixabay"] as const) {
        candidates.push(
          ...(await searchProviderCandidatePool({
            provider,
            query: bucket.query,
            orientation: "landscape",
            targetWidth: 1920,
            session: session(),
          })),
        );
      }
      corpus.push({ ...bucket, candidates });
    }

    // The headline number: distinct provider queries for the whole project.
    const searchCacheMisses = new Set(searchedQueries).size;

    // ── Assignment phase: slices, but against the WHOLE corpus ──────────────
    const usedIds = new Set<string>();
    const sourceUsage = new Map<string, { windows: Set<number>; sceneIndexes: number[] }>();
    const fallbacks: Array<{ demandId: string; tier: string; sceneDistance: number | null }> = [];
    const assigned = new Map<string, { sourceKey: string; sceneIndex: number; tier: string }>();

    const SLICE = 5;
    for (let start = 0; start < demands.length; start += SLICE) {
      const slice = demands.slice(start, start + SLICE);
      const result = await matchStockCorpus({
        projectId: "project-145",
        demands: slice,
        orientation: "landscape",
        targetWidth: 1920,
        niche: "general",
        usedIds,
        session: session(),
        corpus,
        sourceUsage,
        onFallback: (event) =>
          fallbacks.push({
            demandId: event.demandId,
            tier: event.tier,
            sceneDistance: event.sceneDistance,
          }),
      });
      for (const demand of slice) {
        const match = result.get(demand.id);
        if (!match) continue;
        assigned.set(demand.id, {
          sourceKey: `${match.pick.provider}:${match.pick.provider_clip_id}`,
          sceneIndex: demand.sceneIndex!,
          tier: match.tier ?? "unique",
        });
      }
    }

    // ── Assertions ─────────────────────────────────────────────────────────
    const failedScenes = demands.filter((d) => !assigned.has(d.id));
    expect(failedScenes).toEqual([]); // the whole point: zero failed scenes

    expect(searchCacheMisses).toBeLessThan(80); // the stated target

    const tierCounts = { unique: 0, "alternate-window": 0, "distant-reuse": 0 } as Record<
      string,
      number
    >;
    for (const value of assigned.values()) tierCounts[value.tier] += 1;
    expect(tierCounts.unique + tierCounts["alternate-window"] + tierCounts["distant-reuse"]).toBe(
      SCENE_COUNT,
    );

    // Scene-adjacent repeats must not occur, at any tier.
    const usesBySource = new Map<string, number[]>();
    for (const value of assigned.values()) {
      usesBySource.set(value.sourceKey, [
        ...(usesBySource.get(value.sourceKey) ?? []),
        value.sceneIndex,
      ]);
    }
    let minDistance = Infinity;
    for (const indexes of usesBySource.values()) {
      const sorted = [...indexes].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        minDistance = Math.min(minDistance, sorted[i] - sorted[i - 1]);
      }
    }
    if (Number.isFinite(minDistance)) {
      expect(minDistance).toBeGreaterThanOrEqual(NEVER_REUSE_WITHIN);
    }

    // Every degradation was reported — none of it silent.
    expect(fallbacks.length).toBe(tierCounts["alternate-window"] + tierCounts["distant-reuse"]);

    console.log(
      JSON.stringify(
        {
          scenes: SCENE_COUNT,
          buckets: buckets.length,
          searchCacheMisses,
          corpusCandidates: corpus.reduce((n, b) => n + b.candidates.length, 0),
          distinctProviderClipIds: usesBySource.size,
          tiers: tierCounts,
          minSceneDistanceBetweenRepeats: Number.isFinite(minDistance) ? minDistance : null,
          failedScenes: failedScenes.length,
        },
        null,
        2,
      ),
    );
  }, 120000);

  it("prefers a distant repeat over failing when the catalogue is tiny", async () => {
    // One bucket, three sources, twenty scenes: uniqueness cannot hold. The old
    // behaviour failed the project here.
    const demands: StockDemand[] = Array.from({ length: 20 }, (_, index) => ({
      id: `s${index}`,
      query: "identical topic",
      minDurationSec: 5,
      seed: `tiny:s${index}`,
      sceneIndex: index,
    }));
    const corpus = [
      {
        id: "bucket-0",
        query: "identical topic",
        tokens: ["identical", "topic"],
        demandIds: demands.map((d) => d.id),
        candidates: catalogueFor("identical topic", "pexels").slice(0, 3),
      },
    ];

    const usedIds = new Set<string>();
    const sourceUsage = new Map<string, { windows: Set<number>; sceneIndexes: number[] }>();
    const result = await matchStockCorpus({
      projectId: "tiny",
      demands,
      orientation: "landscape",
      targetWidth: 1920,
      niche: "general",
      usedIds,
      session: session(),
      corpus,
      sourceUsage,
    });

    expect(result.size).toBe(20); // nothing failed
    const uses = new Map<string, number[]>();
    for (const demand of demands) {
      const match = result.get(demand.id)!;
      const key = `${match.pick.provider}:${match.pick.provider_clip_id}`;
      uses.set(key, [...(uses.get(key) ?? []), demand.sceneIndex!]);
    }
    for (const indexes of uses.values()) {
      const sorted = [...indexes].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        // Never adjacent, no matter how thin the catalogue gets.
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(NEVER_REUSE_WITHIN);
      }
    }
  }, 60000);

  it("keeps the preferred reuse distance meaningful", () => {
    expect(MIN_REUSE_SCENE_DISTANCE).toBeGreaterThan(NEVER_REUSE_WITHIN);
  });
});
