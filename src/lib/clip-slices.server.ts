export type FixedDurationScene = {
  id: string;
  idx: number;
  start_ts: number | string | null;
  end_ts: number | string | null;
};

export type RenderClipSlice = {
  scene_id: string;
  slice_index: number;
  clip_url: string;
  provider_clip_id: string | null;
  duration_seconds: number | string;
  timeline_start_seconds?: number | string | null;
  timeline_end_seconds?: number | string | null;
  thumbnail_url?: string | null;
};

export type ExpectedSliceSlot = {
  sceneId: string;
  sceneIdx: number;
  sliceIndex: number;
  timelineStart: number;
  timelineEnd: number;
  durationSeconds: number;
};

export type SceneTimelineSlot = {
  sceneId: string;
  sceneIdx: number;
  timelineStart: number;
  timelineEnd: number;
  durationSeconds: number;
};

const TIME_PRECISION = 1000;
const TIME_TOLERANCE = 0.002;

function roundTime(value: number): number {
  return Math.round(value * TIME_PRECISION) / TIME_PRECISION;
}

export function fixedSceneDuration(scene: FixedDurationScene): number {
  return Math.max(0, Number(scene.end_ts ?? 0) - Number(scene.start_ts ?? 0));
}

export function expectedSlotCount(scene: FixedDurationScene, fixedDuration: number): number {
  const total = fixedSceneDuration(scene);
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil(total / fixedDuration));
}

/**
 * Per-scene visual spans, tiled by a SINGLE monotonic cursor.
 *
 * THE INVARIANT: the spans tile [0, max(lastSceneEnd, audioDuration)] with no
 * gaps and no overlaps, so the sum of their durations telescopes exactly to
 * the timeline length — which is what the render validates against the audio.
 *
 * MEASURED, 2026-08-09: two retry-rebuilt timelines failed submission with
 * "visual 2142.26s vs audio 2141.94s" (0.32s) and "visual 1526.31s vs audio
 * 1526.20s" (0.11s). The old code derived each scene's START from its own
 * start_ts but the PREVIOUS scene's end from max(next start, previous end) —
 * so when scene boundaries OVERLAP (next.start_ts < previous.end_ts, which
 * re-generated scene timings can produce), the overlap region was counted in
 * BOTH scenes and the visual total drifted past the audio by the sum of the
 * overlaps. The cursor makes double-counting structurally impossible: each
 * scene begins exactly where the previous one ended, and an overlapping
 * scene is shortened rather than re-covering ground.
 *
 * Every boundary is ms-quantized ONCE and shared by both neighbours, so
 * durations sum exactly instead of accumulating per-scene rounding.
 */
function sceneTimelineSpans(
  scenes: FixedDurationScene[],
  audioDuration?: number | null,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (let index = 0; index < scenes.length; index++) {
    const sceneEnd = Number(scenes[index].end_ts ?? 0);
    let rawEnd: number;
    if (index + 1 < scenes.length) {
      // A scene's visual span runs to the NEXT scene's start when there is a
      // gap (the earlier scene's footage covers it), and to its own end when
      // the next scene starts early.
      const nextSceneStart = Number(scenes[index + 1].start_ts ?? sceneEnd);
      rawEnd = nextSceneStart > sceneEnd ? nextSceneStart : sceneEnd;
    } else {
      // The last scene stretches to the end of the narration.
      const exactAudioDuration = Number(audioDuration);
      rawEnd =
        Number.isFinite(exactAudioDuration) && exactAudioDuration > sceneEnd
          ? exactAudioDuration
          : sceneEnd;
    }
    const end = roundTime(Math.max(cursor, rawEnd));
    spans.push({ start: cursor, end });
    cursor = end;
  }
  return spans;
}

export function buildSceneTimelineSlots(
  scenes: FixedDurationScene[],
  audioDuration?: number | null,
): SceneTimelineSlot[] {
  const spans = sceneTimelineSpans(scenes, audioDuration);
  return scenes.flatMap((scene, index) => {
    const { start: timelineStart, end: timelineEnd } = spans[index];
    const durationSeconds = roundTime(Math.max(0, timelineEnd - timelineStart));
    return durationSeconds > 0
      ? [{ sceneId: scene.id, sceneIdx: scene.idx, timelineStart, timelineEnd, durationSeconds }]
      : [];
  });
}

export function buildExpectedSliceSlots(
  scenes: FixedDurationScene[],
  fixedDuration: number,
  audioDuration?: number | null,
): ExpectedSliceSlot[] {
  const spans = sceneTimelineSpans(scenes, audioDuration);
  const slots: ExpectedSliceSlot[] = [];
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
    const scene = scenes[sceneIndex];
    const { start: sceneStart, end: sceneEnd } = spans[sceneIndex];
    const total = Math.max(0, sceneEnd - sceneStart);
    const count = total > 0 ? Math.max(1, Math.ceil(total / fixedDuration)) : 0;

    // Slices chain off the same cursor discipline as scenes: each begins
    // exactly where the previous ended, and the last lands exactly on the
    // scene boundary, so intra-scene rounding cannot accumulate either.
    let sliceStart = sceneStart;
    for (let sliceIndex = 0; sliceIndex < count; sliceIndex++) {
      const sliceEnd =
        sliceIndex === count - 1
          ? sceneEnd
          : roundTime(Math.min(sceneEnd, sliceStart + fixedDuration));
      const durationSeconds = roundTime(Math.max(0, sliceEnd - sliceStart));
      if (durationSeconds > 0) {
        slots.push({
          sceneId: scene.id,
          sceneIdx: scene.idx,
          sliceIndex,
          timelineStart: sliceStart,
          timelineEnd: sliceEnd,
          durationSeconds,
        });
      }
      sliceStart = sliceEnd;
    }
  }
  return slots;
}

export function sliceKey(sceneId: string, sliceIndex: number): string {
  return `${sceneId}:${sliceIndex}`;
}

export function summarizeSliceCoverage(
  scenes: FixedDurationScene[],
  fixedDuration: number,
  slices: RenderClipSlice[],
  audioDuration?: number | null,
) {
  const expectedSlots = buildExpectedSliceSlots(scenes, fixedDuration, audioDuration);
  const sliceMap = new Map(
    slices.map((slice) => [sliceKey(slice.scene_id, slice.slice_index), slice]),
  );
  const missingSlots = expectedSlots.filter((slot) => {
    const slice = sliceMap.get(sliceKey(slot.sceneId, slot.sliceIndex));
    if (!slice || Number(slice.duration_seconds) <= 0) return true;
    if (Math.abs(Number(slice.duration_seconds) - slot.durationSeconds) > TIME_TOLERANCE)
      return true;

    const storedStart = slice.timeline_start_seconds;
    const storedEnd = slice.timeline_end_seconds;
    if (
      storedStart != null &&
      Math.abs(Number(storedStart) - slot.timelineStart) > TIME_TOLERANCE
    ) {
      return true;
    }
    return storedEnd != null && Math.abs(Number(storedEnd) - slot.timelineEnd) > TIME_TOLERANCE;
  });

  return {
    expectedCount: expectedSlots.length,
    actualCount: expectedSlots.length - missingSlots.length,
    missingSlots,
  };
}

export function describeMissingSlots(missingSlots: ExpectedSliceSlot[], maxItems = 5): string {
  return missingSlots
    .slice(0, maxItems)
    .map((slot) => `scene ${slot.sceneIdx + 1} slice ${slot.sliceIndex + 1}`)
    .join(", ");
}

export async function asyncPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
}
