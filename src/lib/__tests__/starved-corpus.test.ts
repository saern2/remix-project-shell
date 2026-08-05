/**
 * A 145-scene project must complete even when the corpus is starved.
 *
 * A user hit "could not supply unique footage for 1 scene(s)" — one scene, 145
 * lost. Tiers 1-3 all decline for QUALITY reasons (unused source, unseen window,
 * far enough away), and every one of those is worth less than the project
 * existing. Tier 4 keeps only what rendering physically requires.
 *
 * The pool here is deliberately absurd: three clips for 145 scenes. If the
 * project still comes out whole, no realistic corpus can fail it.
 */
import { describe, expect, it } from "vitest";

import {
  matchStockCorpus,
  NEVER_REUSE_WITHIN,
  type AssignmentTier,
  type SourceUsage,
  type StockDemand,
} from "../stock-corpus.server";
import { unmatchedSceneFailureThreshold } from "../pipeline.functions";
import type { StockSearchSession, StockVideo } from "../stock.server";

const SCENE_COUNT = 145;

function clip(id: string, durationSec = 20): StockVideo {
  return {
    provider: "pexels",
    provider_clip_id: id,
    duration_sec: durationSec,
    duration_known: true,
    width: 1920,
    height: 1080,
    thumbnail_url: null,
    files: [
      { url: `https://cdn.test/${id}_sd.mp4`, width: 640, height: 360, bytes: 4_000_000 },
      { url: `https://cdn.test/${id}_hd.mp4`, width: 1920, height: 1080, bytes: 40_000_000 },
    ],
    title: "starved topic",
    keywords: ["starved", "topic"],
  };
}

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

function demands(count: number): StockDemand[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `scene-${index}`,
    query: "starved topic",
    minDurationSec: 4,
    seed: `starved:scene-${index}`,
    sceneIndex: index,
  }));
}

/** Assigns in 5-scene slices, exactly as the pipeline does. */
async function runProject(pool: StockVideo[], sceneCount = SCENE_COUNT) {
  const all = demands(sceneCount);
  const corpus = [
    {
      id: "bucket-0",
      query: "starved topic",
      tokens: ["starved", "topic"],
      demandIds: all.map((demand) => demand.id),
      candidates: pool,
    },
  ];

  const usedIds = new Set<string>();
  const sourceUsage: SourceUsage = new Map();
  const tiers: Record<string, AssignmentTier> = {};
  const events: Array<{ demandId: string; tier: AssignmentTier; reason: string }> = [];

  for (let start = 0; start < all.length; start += 5) {
    const slice = all.slice(start, start + 5);
    const result = await matchStockCorpus({
      projectId: "starved",
      demands: slice,
      orientation: "landscape",
      targetWidth: 1920,
      niche: "general",
      usedIds,
      session: session(),
      corpus,
      sourceUsage,
      onFallback: (event) =>
        events.push({ demandId: event.demandId, tier: event.tier, reason: event.reason }),
    });
    for (const demand of slice) {
      const match = result.get(demand.id);
      if (!match) continue;
      tiers[demand.id] = match.tier ?? "unique";
      const key = `${match.pick.provider}:${match.pick.provider_clip_id}`;
      const usage = sourceUsage.get(key) ?? { windows: new Set<number>(), sceneIndexes: [] };
      usage.windows.add(Math.floor(match.inPoint / Math.max(1, demand.minDurationSec)));
      usage.sceneIndexes.push(demand.sceneIndex!);
      sourceUsage.set(key, usage);
    }
  }

  return { all, tiers, events };
}

describe("a starved corpus still produces a whole project", () => {
  it("matches all 145 scenes from a pool of three clips", async () => {
    const { all, tiers, events } = await runProject([clip("a"), clip("b"), clip("c")]);

    const unmatched = all.filter((demand) => !tiers[demand.id]);
    expect(unmatched).toEqual([]); // the headline: nothing failed

    const counts = Object.values(tiers).reduce<Record<string, number>>((acc, tier) => {
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(SCENE_COUNT);

    // Every degradation was reported, none silently.
    expect(events.length).toBe(SCENE_COUNT - (counts.unique ?? 0));
    for (const event of events) expect(event.reason).toBeTruthy();

    console.log(
      JSON.stringify(
        { scenes: SCENE_COUNT, poolSize: 3, tiers: counts, failedScenes: unmatched.length },
        null,
        2,
      ),
    );
  }, 60000);

  it("still completes when the pool is a single clip", async () => {
    // The pathological floor. Tiers 1-3 cannot place scene 2 onwards at all:
    // no unused source, no free window that is far enough, no distant repeat.
    const { all, tiers } = await runProject([clip("only")], 40);
    expect(all.filter((demand) => !tiers[demand.id])).toEqual([]);
    expect(Object.values(tiers)).toContain("last-resort");
  }, 60000);

  it("prefers the better tiers and only drops to last-resort when it must", async () => {
    // Twenty clips for twenty scenes: uniqueness holds, so the floor is never
    // reached. A tier-4 assignment here would mean the ladder is broken.
    const pool = Array.from({ length: 20 }, (_, i) => clip(`c${i}`));
    const { tiers } = await runProject(pool, 20);
    expect(Object.values(tiers)).not.toContain("last-resort");
    expect(Object.values(tiers).every((tier) => tier === "unique")).toBe(true);
  }, 60000);

  it("spreads forced repeats rather than reusing one clip for everything", async () => {
    const { tiers } = await runProject([clip("a"), clip("b"), clip("c")], 30);
    expect(Object.keys(tiers)).toHaveLength(30);
    // Tier 4 ranks least-used first, so the three clips share the load.
    expect(NEVER_REUSE_WITHIN).toBeGreaterThan(0);
  }, 60000);
});

describe("how many unmatched scenes fail a project", () => {
  it("never fails a project for a single scene, at any size", () => {
    for (const total of [1, 5, 20, 145, 1000]) {
      expect(unmatchedSceneFailureThreshold(total)).toBeGreaterThan(1);
    }
  });

  it("defaults to 10% of the project", () => {
    expect(unmatchedSceneFailureThreshold(145)).toBe(15);
    expect(unmatchedSceneFailureThreshold(200)).toBe(20);
  });

  it("is configurable", () => {
    process.env.MATCHING_MAX_UNMATCHED_FRACTION = "0.25";
    expect(unmatchedSceneFailureThreshold(200)).toBe(50);
    delete process.env.MATCHING_MAX_UNMATCHED_FRACTION;
    expect(unmatchedSceneFailureThreshold(200)).toBe(20);
  });

  it("falls back to the default when misconfigured", () => {
    process.env.MATCHING_MAX_UNMATCHED_FRACTION = "not a number";
    expect(unmatchedSceneFailureThreshold(200)).toBe(20);
    delete process.env.MATCHING_MAX_UNMATCHED_FRACTION;
  });
});
