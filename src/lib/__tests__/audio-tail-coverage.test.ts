/**
 * Where the tail after the narration comes from.
 *
 * Reported symptom: a 14:00 video whose narration stops noticeably before the
 * end, the last scene being 1.3s of "Why do you want any more?". Two
 * explanations were possible — the scenes failing to tile the audio (a defect),
 * or the audio file continuing past the last spoken word and the pipeline
 * faithfully covering it (working as instructed).
 *
 * These pin the second: the timeline ALWAYS reaches the measured audio duration,
 * because the last scene is extended to it. So a tail can only mean the audio
 * file is longer than the narration — never that coverage was lost.
 */
import { describe, expect, it } from "vitest";

import { buildExpectedSliceSlots, buildSceneTimelineSlots } from "../clip-slices.server";

/** A short final scene followed by silence — the shape that produced the report. */
const scenes = [
  { id: "s1", idx: 0, start_ts: 0, end_ts: 100 },
  { id: "s2", idx: 1, start_ts: 100, end_ts: 200 },
  { id: "s3", idx: 2, start_ts: 200, end_ts: 201.3 },
];
/** Narration ends at 201.3s; the file runs to 240s. */
const AUDIO_DURATION = 240;

describe("the timeline covers the whole audio file", () => {
  it("tiles [0, audioDuration] contiguously with fixed-duration slices", () => {
    const slots = buildExpectedSliceSlots(scenes, 4, AUDIO_DURATION);

    expect(slots[0].timelineStart).toBe(0);
    expect(Math.max(...slots.map((s) => s.timelineEnd))).toBeCloseTo(AUDIO_DURATION, 3);

    // No gaps and no overlaps anywhere along the way.
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].timelineStart).toBeCloseTo(slots[i - 1].timelineEnd, 3);
    }
  });

  it("tiles [0, audioDuration] contiguously with one clip per scene", () => {
    const slots = buildSceneTimelineSlots(scenes, AUDIO_DURATION);
    expect(slots[0].timelineStart).toBe(0);
    expect(slots[slots.length - 1].timelineEnd).toBeCloseTo(AUDIO_DURATION, 3);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].timelineStart).toBeCloseTo(slots[i - 1].timelineEnd, 3);
    }
  });

  it("puts the whole tail inside the LAST scene, extended to the audio duration", () => {
    const slots = buildExpectedSliceSlots(scenes, 4, AUDIO_DURATION);
    const lastScene = slots.filter((slot) => slot.sceneId === "s3");

    // The last scene's slot spans [200, 240] — its own start, extended to the
    // audio duration — tiled at 4s: ten slices, of which the first straddles the
    // final word at 201.3 and the other nine are pure silence.
    expect(lastScene.length).toBe(Math.ceil((AUDIO_DURATION - 200) / 4));
    expect(lastScene[0].timelineStart).toBeCloseTo(200, 3);
    expect(lastScene[lastScene.length - 1].timelineEnd).toBeCloseTo(AUDIO_DURATION, 3);

    // Slicing starts at the SCENE boundary, not at the last word, so no slice
    // is aligned to where the speech actually stops.
    const afterLastWord = slots.filter((slot) => slot.timelineStart >= 201.3 - 0.001);
    expect(afterLastWord.length).toBe(9);
    expect(afterLastWord.every((slot) => slot.sceneId === "s3")).toBe(true);
  });

  it("does not extend anything when the audio matches the narration", () => {
    // The control: no trailing silence in the file means no tail in the video.
    const slots = buildExpectedSliceSlots(scenes, 4, 201.3);
    expect(Math.max(...slots.map((s) => s.timelineEnd))).toBeCloseTo(201.3, 3);
  });

  it("never shortens the timeline below the narration", () => {
    // A measured duration shorter than the last word (bad metadata) must not
    // truncate speech — the narration always wins.
    const slots = buildExpectedSliceSlots(scenes, 4, 150);
    expect(Math.max(...slots.map((s) => s.timelineEnd))).toBeCloseTo(201.3, 3);
  });

  it("gives the tail its own slices rather than one stretched clip", () => {
    // Fixed-duration mode matches each tail slice separately, so the tail is a
    // sequence of distinct clips. One-clip-per-scene mode has a single slot for
    // the whole extended scene, which is what renders as a freeze frame when the
    // source is shorter — the difference that decides what a viewer sees.
    const sliced = buildExpectedSliceSlots(scenes, 4, AUDIO_DURATION).filter(
      (slot) => slot.sceneId === "s3",
    );
    const whole = buildSceneTimelineSlots(scenes, AUDIO_DURATION).filter(
      (slot) => slot.sceneId === "s3",
    );

    expect(sliced.length).toBeGreaterThan(1);
    expect(whole.length).toBe(1);
    expect(whole[0].durationSeconds).toBeCloseTo(AUDIO_DURATION - 200, 3);
  });
});
