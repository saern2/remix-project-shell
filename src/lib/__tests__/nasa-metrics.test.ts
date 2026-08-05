import { beforeEach, describe, expect, it, vi } from "vitest";

import { searchNasaFootage } from "../nasaStock.server";
import type { NasaRequestMetrics } from "../stock.server";

const { state } = vi.hoisted(() => ({
  state: {
    cached: false,
    /** null models a row written before nasa_asset_cache.has_captions existed. */
    hasCaptions: null as boolean | null,
    captionBackfills: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: async () => ({
          data: state.cached
            ? [
                {
                  nasa_id: "rogue-planet",
                  files: [
                    {
                      url: "https://images-assets.nasa.gov/video/rogue-planet~medium.mp4",
                      width: 1280,
                      height: 720,
                    },
                  ],
                  duration_seconds: 20,
                  duration_known: true,
                  thumbnail_url: "https://example.test/thumb.jpg",
                  has_captions: state.hasCaptions,
                  cached_at: new Date().toISOString(),
                },
              ]
            : [],
          error: null,
        }),
      }),
      upsert: async () => ({ error: null }),
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          state.captionBackfills.push(values);
          return { error: null };
        },
      }),
    }),
  },
}));

function metrics(): NasaRequestMetrics {
  return {
    searchRequests: 0,
    assetCalls: 0,
    metadataCalls: 0,
    metadataJsonFetches: 0,
    captionCalls: 0,
    assetCacheHits: 0,
    assetCacheMisses: 0,
  };
}

function nasaSearchResponse() {
  return {
    collection: {
      items: [
        {
          data: [
            {
              nasa_id: "rogue-planet",
              title: "Rogue planet visualization",
              description: "A rogue planet drifting through deep space",
              keywords: ["rogue planet", "deep space", "visualization"],
            },
          ],
          links: [
            {
              href: "https://example.test/thumb.jpg",
              rel: "preview",
              render: "image",
            },
          ],
        },
      ],
    },
  };
}

describe("NASA request metrics", () => {
  beforeEach(() => {
    state.cached = false;
    state.hasCaptions = null;
    state.captionBackfills = [];
    vi.restoreAllMocks();
  });

  it("counts every cold-cache NASA endpoint request", async () => {
    const counts = metrics();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json(nasaSearchResponse());
      if (url.includes("/captions/")) return new Response(null, { status: 404 });
      if (url.includes("/asset/")) {
        return Response.json({
          collection: {
            items: [{ href: "https://images-assets.nasa.gov/video/rogue-planet~medium.mp4" }],
          },
        });
      }
      if (url.includes("/metadata/")) {
        return Response.json({ location: "https://images-assets.nasa.gov/meta/rogue.json" });
      }
      if (url.endsWith("/meta/rogue.json")) {
        return Response.json({ "QuickTime:Duration": "0:00:20" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const results = await searchNasaFootage("rogue planet", {
      targetWidth: 1280,
      metrics: counts,
    });

    expect(results).toHaveLength(1);
    expect(counts).toEqual({
      searchRequests: 3,
      assetCalls: 1,
      metadataCalls: 1,
      metadataJsonFetches: 1,
      captionCalls: 1,
      assetCacheHits: 0,
      assetCacheMisses: 1,
    });
  });

  it("probes captions once for a legacy cached row, then backfills it", async () => {
    // Rows cached before nasa_asset_cache.has_captions existed read back as
    // null. They must probe exactly once and persist the answer, rather than
    // re-probing on every future search.
    state.cached = true;
    state.hasCaptions = null;
    const counts = metrics();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json(nasaSearchResponse());
      if (url.includes("/captions/")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected request on warm asset cache: ${url}`);
    });

    const results = await searchNasaFootage("rogue planet", {
      targetWidth: 1280,
      metrics: counts,
    });

    expect(results).toHaveLength(1);
    expect(counts).toEqual({
      searchRequests: 3,
      assetCalls: 0,
      metadataCalls: 0,
      metadataJsonFetches: 0,
      captionCalls: 1,
      assetCacheHits: 1,
      assetCacheMisses: 0,
    });
    expect(state.captionBackfills).toEqual([{ has_captions: false }]);
  });

  it("makes no caption request at all once the answer is cached", async () => {
    // The waste this removes: the caption probe used to run before the cache was
    // consulted, so a fully warm asset still cost one HTTPS round trip per ranked
    // item — inside the matching_footage time budget.
    state.cached = true;
    state.hasCaptions = false;
    const counts = metrics();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json(nasaSearchResponse());
      throw new Error(`Unexpected request on warm asset cache: ${url}`);
    });

    const results = await searchNasaFootage("rogue planet", {
      targetWidth: 1280,
      metrics: counts,
    });

    expect(results).toHaveLength(1);
    expect(counts.captionCalls).toBe(0);
    expect(counts.assetCacheHits).toBe(1);
    expect(state.captionBackfills).toEqual([]);
  });
});
