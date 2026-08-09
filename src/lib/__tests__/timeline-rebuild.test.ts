import { describe, expect, it } from "vitest";
import { buildExpectedSliceSlots, buildSceneTimelineSlots } from "../clip-slices.server";
import { expectedFixedSlicesForScenes } from "../matching-progress";

/**
 * The frame-exact invariant: visual time telescopes EXACTLY to audio time.
 *
 * MEASURED, 2026-08-09 (retry-run HARs): two retry-rebuilt timelines failed
 * render submission —
 *   "visual 2142.26s vs audio 2141.94s"  (0.32s over, 482 scenes)
 *   "visual 1526.31s vs audio 1526.20s"  (0.11s over)
 * The visual total exceeded max(measured audio, last scene end), which is
 * only arithmetically possible if some region of the timeline was counted
 * TWICE: rebuilt scene timings can OVERLAP (next.start_ts < prev.end_ts),
 * and the old builder gave the overlap to both scenes. These tests
 * reconstruct that shape and pin the telescoping invariant that forbids it.
 */

/** Sums slot durations the same way submitRenderJob totals its clips. */
const visualTotal = (slots: Array<{ durationSeconds: number }>) =>
  slots.reduce((sum, slot) => sum + slot.durationSeconds, 0);

// Rebuilt timings with overlaps totalling 0.32s — the deployed drift, in
// miniature. Audio runs slightly past the last scene, as measured audio does.
const overlappingScenes = [
  { id: "s0", idx: 0, start_ts: 0, end_ts: 10.12 },
  { id: "s1", idx: 1, start_ts: 10.0, end_ts: 20.06 }, // starts 0.12s inside s0
  { id: "s2", idx: 2, start_ts: 20.0, end_ts: 30.08 }, // starts 0.06s inside s1
  { id: "s3", idx: 3, start_ts: 30.0, end_ts: 40.02 }, // starts 0.08s inside s2
  { id: "s4", idx: 4, start_ts: 40.0, end_ts: 50.0 }, // starts 0.02s inside s3
];
const AUDIO = 50.34;

describe("rebuilt timelines with overlapping scene timings", () => {
  it("the visual total telescopes exactly to the audio duration", () => {
    // Old behavior: 50.34 + 0.28 of double-counted overlap → duration
    // mismatch on the render button. Now each scene begins where the previous
    // ended, so overlap cannot be counted twice.
    const total = visualTotal(buildExpectedSliceSlots(overlappingScenes, 4, AUDIO));
    expect(total).toBeCloseTo(AUDIO, 3);
  });

  it("whole-scene slots obey the same invariant", () => {
    const total = visualTotal(buildSceneTimelineSlots(overlappingScenes, AUDIO));
    expect(total).toBeCloseTo(AUDIO, 3);
  });

  it("slots tile the timeline with no gaps and no overlaps", () => {
    const slots = buildExpectedSliceSlots(overlappingScenes, 4, AUDIO);
    let cursor = 0;
    for (const slot of slots) {
      expect(slot.timelineStart).toBeCloseTo(cursor, 9);
      expect(slot.timelineEnd).toBeGreaterThan(slot.timelineStart);
      cursor = slot.timelineEnd;
    }
    expect(cursor).toBeCloseTo(AUDIO, 3);
  });

  it("an overlapping scene is shortened, never double-covered", () => {
    const slots = buildSceneTimelineSlots(overlappingScenes, AUDIO);
    // s1 nominally spans 10.0→20.06 but s0 already covered up to 10.12.
    const s1 = slots.find((slot) => slot.sceneId === "s1");
    expect(s1?.timelineStart).toBe(10.12);
    expect(s1?.timelineEnd).toBe(20.06);
  });

  it("survives the deployed scale: hundreds of ragged scenes, sub-frame exact", () => {
    // 482 scenes with pseudo-random overlaps and gaps, ms-precision
    // timestamps — the "Time Is Not Permanent" shape. The invariant must hold
    // by construction, not by luck, so the tolerance here is 1ms, well inside
    // the one-frame (33ms) render gate.
    const scenes: Array<{ id: string; idx: number; start_ts: number; end_ts: number }> = [];
    let t = 0;
    for (let i = 0; i < 482; i++) {
      const duration = 3 + ((i * 137) % 200) / 100; // 3.00–4.99s
      const jitter = (((i * 89) % 21) - 10) / 100; // -0.10…+0.10s overlap/gap
      const start = Math.max(0, Math.round((t + Math.min(0, jitter)) * 1000) / 1000);
      const end = Math.round((t + duration) * 1000) / 1000;
      scenes.push({ id: `scene-${i}`, idx: i, start_ts: start, end_ts: end });
      t = end + Math.max(0, jitter);
    }
    const audioDuration = t + 0.26; // audio runs on past the last scene

    const slotTotal = visualTotal(buildExpectedSliceSlots(scenes, 5, audioDuration));
    expect(Math.abs(slotTotal - audioDuration)).toBeLessThan(0.001);

    const sceneTotal = visualTotal(buildSceneTimelineSlots(scenes, audioDuration));
    expect(Math.abs(sceneTotal - audioDuration)).toBeLessThan(0.001);
  });

  it("the progress panel counts exactly the slices the render will expect", () => {
    // expectedFixedSlicesForScenes drives fixedSlicesComplete, which now also
    // gates the render-only Retry path — a count that disagrees with the
    // builder would either block render-only retry or approve a broken
    // timeline for it.
    for (const fixed of [2, 4, 5]) {
      expect(expectedFixedSlicesForScenes(overlappingScenes, fixed)).toBe(
        buildExpectedSliceSlots(overlappingScenes, fixed).length,
      );
    }
  });
});
