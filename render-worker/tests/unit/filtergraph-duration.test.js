'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { buildFilterGraph, computeClipFrameCounts } = require('../../src/ffmpegBuilder');

/**
 * These pin the CUMULATIVE timeline, not per-clip rounding.
 *
 * The defect: each clip was trimmed with `trim=duration=D`, and the `fps` filter
 * resolves a D-second input to round(D x fps) frames. The sub-frame remainder was
 * dropped per clip instead of carried, so a render's total length was a random
 * walk around the audio duration — and when it landed short, `-shortest` quietly
 * truncated the narration. Any assertion about a single clip's frame count in
 * isolation would have passed against the broken code, so don't write one.
 */
describe('filter graph frame-count contract', () => {
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const clipsOf = (...durations) => durations.map((d) => ({ start: 0, end: d }));

  test('total frames equal round(totalDuration x fps) regardless of how it splits', () => {
    const fps = 30;
    // Durations chosen so every one has a sub-frame remainder: 3.45*30 = 103.5,
    // 2.5167*30 = 75.501, 3.9833*30 = 119.499 — rounding half up, half down.
    const durations = [3.45, 2.5167, 3.9833, 1.0166, 4.7334, 0.6833];
    const frames = computeClipFrameCounts(clipsOf(...durations), fps);

    expect(sum(frames)).toBe(Math.round(sum(durations) * fps));
    // And no clip is empty, which would hand concat a zero-frame stream.
    expect(frames.every((n) => n >= 1)).toBe(true);
  });

  test('carries the remainder forward instead of rounding each clip alone', () => {
    // Three clips of 3.45s. Rounded independently each is round(103.5) = 104,
    // giving 312. On a cumulative timeline the boundaries fall at 103.5, 207,
    // 310.5 -> 104, 103, 104 = 311 = round(10.35 * 30). The middle clip being
    // SHORTER than its neighbours is the carry working.
    const frames = computeClipFrameCounts(clipsOf(3.45, 3.45, 3.45), 30);
    expect(frames).toEqual([104, 103, 104]);
    expect(sum(frames)).toBe(Math.round(10.35 * 30));
  });

  test('stays continuous across chunk boundaries via timelineOffsetSeconds', () => {
    const fps = 30;
    const durations = Array.from({ length: 48 }, (_, i) => 1 + ((i * 7919) % 1000) / 1000);
    const chunkSize = 12;

    let offset = 0;
    let withOffset = 0;
    let withoutOffset = 0;
    for (let i = 0; i < durations.length; i += chunkSize) {
      const chunk = clipsOf(...durations.slice(i, i + chunkSize));
      withOffset += sum(computeClipFrameCounts(chunk, fps, offset));
      withoutOffset += sum(computeClipFrameCounts(chunk, fps, 0));
      offset += sum(durations.slice(i, i + chunkSize));
    }

    const expected = Math.round(sum(durations) * fps);
    expect(withOffset).toBe(expected);
    // Without the offset each chunk restarts the timeline and re-introduces
    // error — this is what makes timeline_offset_seconds load-bearing, not decorative.
    expect(withoutOffset).not.toBe(expected);
  });

  test('an exactly-frame-aligned timeline is unchanged by the carry', () => {
    const frames = computeClipFrameCounts(clipsOf(5, 5, 5, 2.8), 30);
    expect(frames).toEqual([150, 150, 150, 84]);
  });

  test('never emits a zero-frame clip, and absorbs the forced frame afterwards', () => {
    // 0.01s at 30fps rounds to 0 frames. It must still produce one, and the
    // clip after it gives that frame back so the total stays exact.
    const frames = computeClipFrameCounts(clipsOf(0.01, 2.0), 30);
    expect(frames[0]).toBe(1);
    expect(frames[1]).toBe(59);
    expect(sum(frames)).toBe(60);
  });

  test('emits an exact frame count per clip and pads short sources', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filtergraph-duration-'));
    try {
      const { scriptPath } = buildFilterGraph({
        clips: clipsOf(2.8, 3.45),
        width: 1280,
        height: 720,
        fps: 30,
        transition: 'hard-cut',
        transitionDuration: 0.5,
        tempDir,
      });
      const graph = await fs.readFile(scriptPath, 'utf8');

      // 2.8 * 30 = 84 exactly; the cumulative boundary for the second clip is
      // 6.25 * 30 = 187.5 -> 188, so it gets 104.
      expect(graph).toContain('trim=end_frame=84');
      expect(graph).toContain('trim=end_frame=104');
      // tpad still covers sources shorter than the slot (the freeze-frame path).
      expect(graph).toContain('tpad=stop_mode=clone:stop_duration=');
      expect(graph).toContain('concat=n=2:v=1:a=0');
      expect(graph).not.toContain('xfade=');
      // The old per-clip formulation must not come back.
      expect(graph).not.toContain('trim=duration=');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
