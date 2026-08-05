/**
 * Round 6: matching setup must cost O(work done), not O(project size).
 *
 * The deployed build spent ~4.9s of every ~9.1s matching invocation on setup
 * that scaled with the project — the whole stock_search_cache prefetched and the
 * Pexels key pool reloaded — before processing two or three scenes. Across 56
 * invocations that was ~4.5 minutes of pure repetition. These tests pin the
 * three properties that keep it O(work).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbCalls } = vi.hoisted(() => ({
  dbCalls: [] as Array<{ table: string; queries: string[] }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const rowsFor = (table: string) =>
    table === "pexels_api_keys"
      ? [{ id: "key-1", api_key: "secret", rate_limit_remaining: null, rate_limit_reset_at: null }]
      : [];

  const builderFor = (table: string) => {
    const record = { table, queries: [] as string[] };
    dbCalls.push(record);
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: (_column: string, values: string[]) => {
        record.queries.push(...values);
        return builder;
      },
      // Thenable so `await builder` resolves like a PostgREST query.
      then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rowsFor(table), error: null }),
    };
    return builder;
  };

  return { supabaseAdmin: { from: (table: string) => builderFor(table) } };
});

const callsTo = (table: string) => dbCalls.filter((call) => call.table === table);

describe("matching setup cost", () => {
  beforeEach(async () => {
    dbCalls.length = 0;
    const { invalidatePexelsPoolSnapshot } = await import("../stock.server");
    invalidatePexelsPoolSnapshot();
  });

  afterEach(async () => {
    const { invalidatePexelsPoolSnapshot } = await import("../stock.server");
    invalidatePexelsPoolSnapshot();
  });

  it("creates a session without reading the search cache at all", async () => {
    const { createStockSearchSession } = await import("../stock.server");
    await createStockSearchSession();
    // The cache prefetch belongs to matchStockCorpus, which scopes it to the
    // slice it is about to search. Session creation must not front-run it with
    // a whole-project read.
    expect(callsTo("stock_search_cache")).toHaveLength(0);
  });

  it("reuses the key pool snapshot across invocations instead of reloading it", async () => {
    const { createStockSearchSession } = await import("../stock.server");
    for (let invocation = 0; invocation < 5; invocation++) {
      await createStockSearchSession();
    }
    expect(callsTo("pexels_api_keys")).toHaveLength(1);
  });

  it("still hands every session its own mutable pool over the shared snapshot", async () => {
    const { createStockSearchSession } = await import("../stock.server");
    const first = await createStockSearchSession();
    const second = await createStockSearchSession();

    first.pexelsPool.requestCount += 3;
    first.pexelsPool.unavailableIds.add("key-1");

    // Per-stage state (request budget, rejected keys) must not leak between
    // invocations just because the key list behind them is cached.
    expect(second.pexelsPool.requestCount).toBe(0);
    expect(second.pexelsPool.unavailableIds.has("key-1")).toBe(false);
    expect(second.pexelsPool.keys).not.toBe(first.pexelsPool.keys);
  });

  it("reloads the pool after a key is invalidated", async () => {
    const { createStockSearchSession, invalidatePexelsPoolSnapshot } = await import(
      "../stock.server"
    );
    await createStockSearchSession();
    invalidatePexelsPoolSnapshot(); // what markKeyDead / markKeyRateLimited do
    await createStockSearchSession();
    expect(callsTo("pexels_api_keys")).toHaveLength(2);
  });

  it("reads each search-cache key at most once per session", async () => {
    const { createStockSearchSession, prefetchStockProviderCache } = await import("../stock.server");
    const session = await createStockSearchSession();

    // Consecutive slices cluster into overlapping query buckets.
    await prefetchStockProviderCache(session, "pexels", "landscape", ["ocean waves", "city night"]);
    await prefetchStockProviderCache(session, "pexels", "landscape", ["city night", "forest path"]);

    const queried = callsTo("stock_search_cache").flatMap((call) => call.queries);
    expect(queried).toEqual(["ocean waves", "city night", "forest path"]);
  });

  it("keeps orientation and provider distinct when deduping prefetches", async () => {
    const { createStockSearchSession, prefetchStockProviderCache } = await import("../stock.server");
    const session = await createStockSearchSession();

    await prefetchStockProviderCache(session, "pexels", "landscape", ["ocean waves"]);
    await prefetchStockProviderCache(session, "pexels", "portrait", ["ocean waves"]);
    await prefetchStockProviderCache(session, "pixabay", "landscape", ["ocean waves"]);

    // Same text, three different cache rows — deduping must not collapse them.
    expect(callsTo("stock_search_cache")).toHaveLength(3);
  });
});
