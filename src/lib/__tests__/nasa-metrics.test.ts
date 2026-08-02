import { beforeEach, describe, expect, it, vi } from "vitest";

import { searchNasaFootage } from "../nasaStock.server";
import type { NasaRequestMetrics } from "../stock.server";

const { state } = vi.hoisted(() => ({
  state: { cached: false },
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
                  cached_at: new Date().toISOString(),
                },
              ]
            : [],
          error: null,
        }),
      }),
      upsert: async () => ({ error: null }),
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

  it("reports an asset-cache hit while retaining the caption probe", async () => {
    state.cached = true;
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
  });
});
