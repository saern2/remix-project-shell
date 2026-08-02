import { describe, expect, it } from "vitest";

import { nasaRelevanceScore, rankNasaSearchItems, scoreNasaCandidate } from "../nasaStock.server";
import type { StockVideo } from "../stock.server";

function nasaVideo(overrides: Partial<StockVideo>): StockVideo {
  return {
    provider: "nasa",
    provider_clip_id: "asset",
    duration_sec: 120,
    duration_known: true,
    width: 1920,
    height: 1080,
    thumbnail_url: null,
    files: [{ url: "https://example.test/asset.mp4", width: 1920, height: 1080 }],
    ...overrides,
  };
}

describe("NASA relevance and quality ranking", () => {
  it("keeps relevance independent from talking-head and caption penalties", () => {
    const visual = nasaVideo({
      provider_clip_id: "GSFC_2024_m12345_black-hole",
      title: "Black hole accretion disk visualization",
      keywords: ["black hole", "accretion disk", "simulation"],
    });
    const briefing = nasaVideo({
      provider_clip_id: "briefing",
      title: "Black hole accretion disk science briefing",
      keywords: ["black hole", "accretion disk"],
      has_captions: true,
    });

    expect(nasaRelevanceScore("black hole accretion disk", briefing)).toBeGreaterThanOrEqual(
      nasaRelevanceScore("black hole accretion disk", visual) - 0.01,
    );
    expect(scoreNasaCandidate("black hole accretion disk", visual)).toBeGreaterThan(
      scoreNasaCandidate("black hole accretion disk", briefing),
    );
  });

  it("rejects unique but irrelevant footage at the relevance layer", () => {
    const unrelated = nasaVideo({
      title: "Astronaut interview from mission control",
      keywords: ["astronaut", "interview"],
    });

    expect(nasaRelevanceScore("icy moon underground ocean", unrelated)).toBe(0);
  });

  it("uses the project seed to vary equally relevant NASA search results deterministically", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      data: [
        {
          nasa_id: `asset-${index}`,
          title: "Milky Way galaxy visualization",
          keywords: ["milky way", "galaxy"],
        },
      ],
    }));

    const first = rankNasaSearchItems("milky way galaxy", items, "project-a");
    const retry = rankNasaSearchItems("milky way galaxy", items, "project-a");
    const other = rankNasaSearchItems("milky way galaxy", items, "project-b");

    expect(retry).toEqual(first);
    expect(other.map((item) => item.data?.[0]?.nasa_id)).not.toEqual(
      first.map((item) => item.data?.[0]?.nasa_id),
    );
  });
});
