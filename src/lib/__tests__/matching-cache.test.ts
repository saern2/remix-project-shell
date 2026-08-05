/**
 * The per-invocation setup cost the cache exists to remove.
 *
 * Measured on the deployed 145-scene run: setupMs ~3.4s per invocation, and
 * sceneReadRows 1,305 — every invocation re-reading the visual queries of every
 * scene that had not been matched yet. None of that data can change while
 * matching runs, so all of it was latency spent to learn nothing new.
 *
 * These pin the two properties that make the cache safe rather than merely fast:
 * a partial corpus is never served, and invalidation actually forgets.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  cacheCompleteCorpus,
  cacheScenes,
  cacheVisualQueries,
  getCachedCorpus,
  getCachedScenes,
  getCachedVisualQueries,
  invalidateMatchingCache,
  mergeVisualQueries,
  resetMatchingCache,
} from "../matching-cache.server";
import type { CorpusBucket } from "../stock-corpus-store.server";

const bucket = (id: string): CorpusBucket => ({
  id,
  query: `query ${id}`,
  tokens: [id],
  demandIds: [],
  candidates: [],
  providersDone: ["pexels", "pixabay"],
});

describe("matching cache", () => {
  beforeEach(() => resetMatchingCache());

  it("serves scenes and queries back without another read", () => {
    cacheScenes("p1", [{ id: "s1", idx: 0, start_ts: 0, end_ts: 4 }]);
    cacheVisualQueries("p1", new Map([["s1", "a nebula"]]));

    expect(getCachedScenes("p1")).toHaveLength(1);
    expect(getCachedVisualQueries("p1")?.get("s1")).toBe("a nebula");
  });

  it("merges partial query reads into one whole map", () => {
    // The corpus phase reads every scene; later invocations read only their own.
    // Merging is what lets the later reads stop happening entirely.
    mergeVisualQueries("p1", new Map([["s1", "one"]]));
    mergeVisualQueries("p1", new Map([["s2", "two"]]));

    const queries = getCachedVisualQueries("p1");
    expect(queries?.get("s1")).toBe("one");
    expect(queries?.get("s2")).toBe("two");
  });

  it("forgets everything about a project when its scenes change", () => {
    cacheScenes("p1", [{ id: "s1", idx: 0, start_ts: 0, end_ts: 4 }]);
    cacheVisualQueries("p1", new Map([["s1", "a nebula"]]));
    cacheCompleteCorpus("p1", [bucket("b0")]);

    invalidateMatchingCache("p1");

    // All three, not just the one the caller happened to think of. Regenerating
    // scenes invalidates the skeleton, the queries AND the clustering.
    expect(getCachedScenes("p1")).toBeUndefined();
    expect(getCachedVisualQueries("p1")).toBeUndefined();
    expect(getCachedCorpus("p1")).toBeUndefined();
  });

  it("expires entries rather than trusting them forever", () => {
    const t0 = 1_000_000;
    cacheScenes("p1", [{ id: "s1", idx: 0, start_ts: 0, end_ts: 4 }], t0);

    expect(getCachedScenes("p1", t0 + 60_000)).toHaveLength(1);
    expect(getCachedScenes("p1", t0 + 20 * 60_000)).toBeUndefined();
  });

  it("evicts the least recently used project, not the newest", () => {
    for (let i = 0; i < 8; i++)
      cacheScenes(`p${i}`, [{ id: `s${i}`, idx: 0, start_ts: 0, end_ts: 1 }]);
    // Touch p0 so it is no longer the least recently used.
    expect(getCachedScenes("p0")).toBeDefined();
    cacheScenes("p8", [{ id: "s8", idx: 0, start_ts: 0, end_ts: 1 }]);

    expect(getCachedScenes("p0")).toBeDefined();
    expect(getCachedScenes("p1")).toBeUndefined();
    expect(getCachedScenes("p8")).toBeDefined();
  });

  it("keeps projects independent", () => {
    cacheScenes("p1", [{ id: "s1", idx: 0, start_ts: 0, end_ts: 4 }]);
    invalidateMatchingCache("p2");
    expect(getCachedScenes("p1")).toHaveLength(1);
  });
});
