import { describe, expect, it } from "vitest";
import {
  asyncPool,
  buildExpectedSliceSlots,
  describeMissingSlots,
  summarizeSliceCoverage,
} from "../clip-slices.server";

const scenes = [
  { id: "scene-a", idx: 0, start_ts: 0, end_ts: 4 },
  { id: "scene-b", idx: 1, start_ts: 4.1, end_ts: 13.1 },
  { id: "scene-c", idx: 2, start_ts: 13.1, end_ts: 13.1 },
];

describe("fixed-duration clip slice helpers", () => {
  it("computes expected slots from scene duration and fixed duration", () => {
    expect(buildExpectedSliceSlots(scenes, 4)).toEqual([
      { sceneId: "scene-a", sceneIdx: 0, sliceIndex: 0 },
      { sceneId: "scene-b", sceneIdx: 1, sliceIndex: 0 },
      { sceneId: "scene-b", sceneIdx: 1, sliceIndex: 1 },
      { sceneId: "scene-b", sceneIdx: 1, sliceIndex: 2 },
    ]);
  });

  it("reports missing cache rows by scene and slice", () => {
    const coverage = summarizeSliceCoverage(scenes, 4, [
      {
        scene_id: "scene-a",
        slice_index: 0,
        clip_url: "https://example.com/a.mp4",
        provider_clip_id: "a",
        duration_seconds: 4,
      },
    ]);

    expect(coverage.expectedCount).toBe(4);
    expect(coverage.actualCount).toBe(1);
    expect(describeMissingSlots(coverage.missingSlots)).toBe(
      "scene 2 slice 1, scene 2 slice 2, scene 2 slice 3",
    );
  });

  it("limits async work to the requested concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    await asyncPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
