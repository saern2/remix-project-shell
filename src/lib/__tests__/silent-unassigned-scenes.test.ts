/**
 * A scene that gets no clip must never be silent.
 *
 * 2026-08-14, capture 64: a 356-scene project completed `ready` with six tail
 * scenes holding no selected_clips row. All three fallback counters read zero,
 * the telemetry reported 356 scenes processed and 0 remaining, and the UI
 * offered "Render video" over the gaps.
 *
 * The zeros were the trap. A scene that DESCENDS the ladder increments a
 * fallback counter at every rung below `unique`; a scene the ladder cannot place
 * at all increments nothing and takes `continue`. So "no degradation happened"
 * and "there was no footage" produced identical telemetry, and only one of them
 * is fine.
 *
 * Two properties are pinned here, and they are different claims:
 *
 *   1. An empty own-bucket is NOT a hole. Candidates already span the whole
 *      corpus, so a starved bucket is rescued through the ordinary tiers and
 *      shows up in the ordinary counters. This test passed before the change —
 *      it is a regression pin on behaviour that was already correct, and it
 *      rules the bucket out as the cause.
 *   2. A genuinely unplaceable scene is COUNTED and LOGGED. This is the change:
 *      the same skip now leaves a mark that says a scene got nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { matchStockCorpus, type SourceUsage, type StockDemand } from "../stock-corpus.server";
import { createMatchingProfile } from "../matching-profile";
import type { StockSearchSession, StockVideo } from "../stock.server";

function clip(id: string, opts: { files?: boolean; durationSec?: number } = {}): StockVideo {
  const { files = true, durationSec = 20 } = opts;
  return {
    provider: "pexels",
    provider_clip_id: id,
    duration_sec: durationSec,
    duration_known: true,
    width: 1920,
    height: 1080,
    thumbnail_url: null,
    files: files
      ? [{ url: `https://cdn.test/${id}.mp4`, width: 1920, height: 1080, bytes: 40_000_000 }]
      : [],
    title: "tail topic",
    keywords: ["tail", "topic"],
  };
}

function session(profile = createMatchingProfile()): StockSearchSession {
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
      cursor: 0,
      requestLimit: 1000,
    },
    profile,
  };
}

const SCENES = 356;
const TAIL_START = 350;

function demand(index: number): StockDemand {
  return {
    id: `scene-${index}`,
    query: index >= TAIL_START ? "tail topic" : "body topic",
    minDurationSec: 4,
    seed: `capture64:scene-${index}`,
    sceneIndex: index,
  };
}

/**
 * The production shape: a body bucket holding real footage, and a tail bucket
 * whose own pool is EMPTY — the six scenes that came out clipless.
 */
function corpusWithEmptyTailBucket(tailPool: StockVideo[]) {
  return [
    {
      id: "bucket-body",
      query: "body topic",
      tokens: ["body", "topic"],
      demandIds: Array.from({ length: TAIL_START }, (_, i) => `scene-${i}`),
      candidates: Array.from({ length: 40 }, (_, i) => clip(`body-${i}`)),
    },
    {
      id: "bucket-tail",
      query: "tail topic",
      tokens: ["tail", "topic"],
      demandIds: Array.from({ length: SCENES - TAIL_START }, (_, i) => `scene-${TAIL_START + i}`),
      candidates: tailPool,
    },
  ];
}

/** Assigns in 25-scene slices, exactly as the pipeline does. */
async function runProject(
  corpus: ReturnType<typeof corpusWithEmptyTailBucket>,
  profile = createMatchingProfile(),
) {
  const all = Array.from({ length: SCENES }, (_, i) => demand(i));
  const usedIds = new Set<string>();
  const sourceUsage: SourceUsage = new Map();
  const matched = new Map<string, string>();
  const fallbacks: string[] = [];

  for (let start = 0; start < all.length; start += 25) {
    const slice = all.slice(start, start + 25);
    const result = await matchStockCorpus({
      projectId: "capture64",
      demands: slice,
      orientation: "portrait",
      targetWidth: 1080,
      niche: "general",
      usedIds,
      session: session(profile),
      corpus,
      sourceUsage,
      onFallback: (event) => fallbacks.push(event.tier),
    });
    for (const d of slice) {
      const hit = result.get(d.id);
      if (hit) matched.set(d.id, hit.tier ?? "unique");
    }
  }

  const tail = all.slice(TAIL_START).map((d) => d.id);
  return { all, matched, fallbacks, tail, profile };
}

describe("a tail bucket with an empty pool is not a hole", () => {
  it("matches all 356 scenes through the ladder when only the tail's own bucket is empty", async () => {
    // THE SHAPE FROM CAPTURE 64. Candidates for any demand are its own bucket
    // plus every other bucket, so the tail scenes rank against the body's 40
    // clips and are placed by the ordinary tiers.
    const { matched, tail, profile } = await runProject(corpusWithEmptyTailBucket([]));

    expect(matched.size).toBe(SCENES);
    for (const id of tail) expect(matched.get(id)).toBeDefined();
    // Nothing was left unplaceable, so the new counter stays at its seeded zero.
    expect(profile.summary().assignmentLadderExhausted).toBe(0);
  }, 60000);

  it("reports the rescue in the existing fallback telemetry, not a private path", async () => {
    // The tail scenes are reusing body footage, which is a DEGRADATION and must
    // be visible as one. A rescue that reported nothing would recreate the
    // silent class one layer down.
    const { matched, fallbacks, tail } = await runProject(corpusWithEmptyTailBucket([]));
    const tailTiers = tail.map((id) => matched.get(id));
    expect(tailTiers.every((tier) => tier !== undefined)).toBe(true);
    expect(fallbacks.length).toBeGreaterThan(0);
    // Every non-unique assignment produced an event; none was placed silently.
    const degraded = [...matched.values()].filter((tier) => tier !== "unique").length;
    expect(fallbacks.length).toBe(degraded);
  }, 60000);
});

describe("a scene the ladder truly cannot place is counted and logged", () => {
  it("increments assignmentLadderExhausted instead of skipping in silence", async () => {
    // Every candidate in the project is unrenderable: no files, so last-resort
    // — whose only requirement is a usable rendition — declines too. This is
    // the one state that genuinely yields no clip.
    const profile = createMatchingProfile();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const corpus = [
        {
          id: "bucket-body",
          query: "body topic",
          tokens: ["body", "topic"],
          demandIds: ["scene-0"],
          candidates: [clip("fileless", { files: false })],
        },
      ];
      const result = await matchStockCorpus({
        projectId: "exhausted",
        demands: [demand(0)],
        orientation: "portrait",
        targetWidth: 1080,
        niche: "general",
        usedIds: new Set(),
        session: session(profile),
        corpus,
        sourceUsage: new Map(),
      });

      expect(result.size).toBe(0);
      expect(profile.summary().assignmentLadderExhausted).toBe(1);

      // The log has to say WHICH scene and carry the numbers that separate an
      // empty pool from a pool of unusable sources.
      const entry = warn.mock.calls.find(
        ([message]) => typeof message === "string" && message.includes("no clip for scene"),
      );
      expect(entry).toBeDefined();
      expect(entry?.[1]).toMatchObject({
        sceneId: "scene-0",
        sceneIndex: 0,
        candidatesConsidered: 1,
        renderableCandidates: 0,
      });
    } finally {
      warn.mockRestore();
    }
  }, 60000);

  it("seeds the counter so a healthy run reports zero rather than nothing", async () => {
    // An absent field reads as "not measured"; a zero reads as "measured, none".
    // The whole bug was an absence being read as health.
    const profile = createMatchingProfile();
    await matchStockCorpus({
      projectId: "healthy",
      demands: [demand(0)],
      orientation: "portrait",
      targetWidth: 1080,
      niche: "general",
      usedIds: new Set(),
      session: session(profile),
      corpus: [
        {
          id: "bucket-body",
          query: "body topic",
          tokens: ["body", "topic"],
          demandIds: ["scene-0"],
          candidates: [clip("good")],
        },
      ],
      sourceUsage: new Map(),
    });
    expect(profile.summary().assignmentLadderExhausted).toBe(0);
  }, 60000);
});
