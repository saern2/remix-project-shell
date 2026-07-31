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

function timelineStartForScene(scenes: FixedDurationScene[], index: number): number {
  if (index === 0) return 0;
  return Number(scenes[index].start_ts ?? 0);
}

function timelineEndForScene(
  scenes: FixedDurationScene[],
  index: number,
  audioDuration?: number | null,
): number {
  const scene = scenes[index];
  const sceneEnd = Number(scene.end_ts ?? 0);
  if (index + 1 < scenes.length) {
    const nextSceneStart = Number(scenes[index + 1].start_ts ?? sceneEnd);
    return nextSceneStart > sceneEnd ? nextSceneStart : sceneEnd;
  }

  const exactAudioDuration = Number(audioDuration);
  return Number.isFinite(exactAudioDuration) && exactAudioDuration > sceneEnd
    ? exactAudioDuration
    : sceneEnd;
}

export function buildSceneTimelineSlots(
  scenes: FixedDurationScene[],
  audioDuration?: number | null,
): SceneTimelineSlot[] {
  return scenes.flatMap((scene, index) => {
    const timelineStart = roundTime(timelineStartForScene(scenes, index));
    const timelineEnd = roundTime(timelineEndForScene(scenes, index, audioDuration));
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
  const slots: ExpectedSliceSlot[] = [];
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
    const scene = scenes[sceneIndex];
    const sceneStart = timelineStartForScene(scenes, sceneIndex);
    const sceneEnd = timelineEndForScene(scenes, sceneIndex, audioDuration);
    const total = Math.max(0, sceneEnd - sceneStart);
    const count = total > 0 ? Math.max(1, Math.ceil(total / fixedDuration)) : 0;

    for (let sliceIndex = 0; sliceIndex < count; sliceIndex++) {
      const timelineStart = roundTime(sceneStart + sliceIndex * fixedDuration);
      const timelineEnd = roundTime(Math.min(sceneEnd, timelineStart + fixedDuration));
      const durationSeconds = roundTime(Math.max(0, timelineEnd - timelineStart));
      if (durationSeconds <= 0) continue;
      slots.push({
        sceneId: scene.id,
        sceneIdx: scene.idx,
        sliceIndex,
        timelineStart,
        timelineEnd,
        durationSeconds,
      });
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
