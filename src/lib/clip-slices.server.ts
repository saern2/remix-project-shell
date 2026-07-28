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

const TIME_PRECISION = 1000;

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

export function buildExpectedSliceSlots(
  scenes: FixedDurationScene[],
  fixedDuration: number,
): ExpectedSliceSlot[] {
  const slots: ExpectedSliceSlot[] = [];
  for (const scene of scenes) {
    const count = expectedSlotCount(scene, fixedDuration);
    const sceneStart = Number(scene.start_ts ?? 0);
    const sceneEnd = Number(scene.end_ts ?? 0);
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
) {
  const expectedSlots = buildExpectedSliceSlots(scenes, fixedDuration);
  const sliceKeys = new Set(
    slices
      .filter((s) => Number(s.duration_seconds) > 0)
      .map((s) => sliceKey(s.scene_id, s.slice_index)),
  );
  const missingSlots = expectedSlots.filter(
    (slot) => !sliceKeys.has(sliceKey(slot.sceneId, slot.sliceIndex)),
  );

  return {
    expectedCount: expectedSlots.length,
    actualCount: sliceKeys.size,
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
