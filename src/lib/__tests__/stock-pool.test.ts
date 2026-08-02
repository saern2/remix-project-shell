import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PexelsPoolDegradedError,
  StockRequestBudgetExceededError,
  buildNasaSourceWindows,
  createPexelsStagePool,
  expandNasaQueries,
  requestWithPexelsPool,
  type PoolKey,
  type StockVideo,
} from "../stock.server";

function keys(count: number): PoolKey[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `key-${index + 1}`,
    api_key: `secret-${index + 1}`,
    rate_limit_remaining: null,
    rate_limit_reset_at: null,
  }));
}

describe("stage-scoped Pexels pool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues past a rejected key without failing the logical search", async () => {
    const pool = createPexelsStagePool(keys(8), true, 20);
    const onDead = vi.fn(async () => undefined);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rejected", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await requestWithPexelsPool(pool, "https://example.test/search", {
      onDead,
    });

    expect(response?.status).toBe(200);
    expect(pool.requestCount).toBe(2);
    expect(pool.rejectedIds).toEqual(new Set(["key-1"]));
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("opens the circuit only after more than 25 percent of the snapshot is rejected", async () => {
    const pool = createPexelsStagePool(keys(4), true, 20);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rejected", { status: 401 }));

    await expect(requestWithPexelsPool(pool, "https://example.test/search")).rejects.toEqual(
      expect.objectContaining({
        name: "PexelsPoolDegradedError",
        rejected: 2,
        initial: 4,
      }),
    );
    expect(pool.requestCount).toBe(2);
    expect(PexelsPoolDegradedError).toBeDefined();
  });

  it("deduplicates deactivation when concurrent requests hit the same rejected key", async () => {
    const pool = createPexelsStagePool(keys(8), true, 30);
    const onDead = vi.fn(async () => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "secret-1"
        ? new Response("rejected", { status: 403 })
        : new Response("ok", { status: 200 });
    });

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        requestWithPexelsPool(pool, "https://example.test/search", { onDead }),
      ),
    );

    expect(responses.every((response) => response?.ok)).toBe(true);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(pool.rejectedIds).toEqual(new Set(["key-1"]));
  });

  it("enforces the configured physical-request ceiling", async () => {
    const pool = createPexelsStagePool(keys(1), true, 1);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await expect(requestWithPexelsPool(pool, "https://example.test/one")).resolves.toBeTruthy();
    await expect(requestWithPexelsPool(pool, "https://example.test/two")).rejects.toBeInstanceOf(
      StockRequestBudgetExceededError,
    );
  });
});

describe("NASA query and window expansion", () => {
  it("preserves scene-specific terms instead of collapsing to a generic theme", () => {
    const variants = expandNasaQueries("icy moon underground ocean geothermal core");

    expect(variants[0]).toBe("icy moon underground ocean geothermal core");
    expect(variants.some((query) => query.includes("icy"))).toBe(true);
    expect(variants.some((query) => query.includes("geothermal"))).toBe(true);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("builds seeded non-overlapping windows inside ten-percent edge margins", () => {
    const video: StockVideo = {
      provider: "nasa",
      provider_clip_id: "long-asset",
      duration_sec: 100,
      duration_known: true,
      width: 1920,
      height: 1080,
      thumbnail_url: null,
      files: [{ url: "https://example.test/asset.mp4", width: 1920, height: 1080 }],
    };

    const windows = buildNasaSourceWindows(video, 5, "project:scene", 6);

    expect(windows).toHaveLength(6);
    expect(windows.every((start) => start >= 10 && start <= 85)).toBe(true);
    expect(new Set(windows).size).toBe(windows.length);
    expect(buildNasaSourceWindows(video, 5, "project:scene", 6)).toEqual(windows);
  });
});
