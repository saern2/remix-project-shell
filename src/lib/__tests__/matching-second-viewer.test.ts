/**
 * The second viewer's screen, 2026-08-07.
 *
 * MEASURED from the HAR: getMatchingProgress returned
 *
 *   { msSinceProgress: 1_837_346, corpusCellsPending: 0, corpusCellsTotal: 40,
 *     totalScenes: 300, scenesRemaining: 300 }
 *
 * while the timeline on the same screen read render_clip_slices directly and
 * showed 558 of 616 clips. The panel showed "Matching footage — 0 of 300
 * scenes" and "Paused — resuming now ... it stopped when the tab was closed",
 * on a project that was ~90% done and actively progressing.
 *
 * The root cause was not the poll's remaining: -1 (diagnostic-only; nothing
 * renders it). It was the progress reader counting selected_clips — a table
 * the fixed-duration pipeline only writes at its final flush — while matching
 * wrote render_clip_slices the whole time. selected_clips was genuinely empty
 * (its REST reads in the same HAR return []), so matched = 0 was "correct"
 * from the wrong table, and msSinceProgress grew because neither of its two
 * timestamp sources is touched by slice writes.
 *
 * These tests pin the fixed data flow end to end at the pure layer, plus
 * source-level pins for the wiring that cannot run without a database.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assembleMatchingCounts,
  describeMatchingProgress,
  expectedFixedSlicesForScenes,
  shortMatchingLabel,
} from "../matching-progress";

const NOW = 1_754_500_000_000;

/** The measured project, reconstructed: counts as the fixed reader sees them. */
function harProjectCounts(overrides: Partial<Parameters<typeof assembleMatchingCounts>[0]> = {}) {
  return assembleMatchingCounts({
    now: NOW,
    totalScenes: 300,
    matchedScenes: 0, // selected_clips is genuinely empty mid-run for this pipeline
    corpusBuckets: 40,
    corpusBucketsFilled: 40,
    slicesFilled: 558,
    slicesExpected: 616,
    lastProgressAt: [
      null, // selected_clips: nothing yet
      new Date(NOW - 1_837_346).toISOString(), // corpus: finished half an hour ago
      new Date(NOW - 4_000).toISOString(), // newest slice: seconds ago
    ],
    ...overrides,
  });
}

describe("the measured second-viewer scenario, after the fix", () => {
  it("shows the timeline's own numbers, not 0 of 300", () => {
    const view = describeMatchingProgress(harProjectCounts());
    expect(view.headline).toBe("Matching footage — 558 of 616 clips");
    expect(view.percent).toBe(91);
    expect(view.headline).not.toContain("0 of 300");
  });

  it("does not show the paused notice while slices are being written", () => {
    // The corpus timestamps are half an hour old — that used to be the whole
    // signal. Slice writes now count as progress, so an actively-progressing
    // project can never read as paused again.
    const view = describeMatchingProgress(harProjectCounts());
    expect(view.paused).toBe(false);
    expect(view.pausedNotice).toBeNull();
  });

  it("still pauses honestly when slice writes genuinely stop", () => {
    const counts = harProjectCounts({
      lastProgressAt: [null, new Date(NOW - 1_837_346).toISOString(), new Date(NOW - 240_000).toISOString()],
    });
    const view = describeMatchingProgress(counts);
    expect(view.paused).toBe(true);
    // ...without the counts disappearing, and without blaming anyone's tab.
    expect(view.headline).toBe("Matching footage — 558 of 616 clips");
    expect(view.pausedNotice).not.toMatch(/tab was closed/i);
  });

  it("agrees with the dashboard label too", () => {
    expect(shortMatchingLabel(harProjectCounts())).toContain("558 of 616");
  });
});

describe("sentinels never render as zero", () => {
  it("scenesRemaining: -1 falls through to known-unknown, not to 0 of N", () => {
    const view = describeMatchingProgress({
      totalScenes: 300,
      scenesRemaining: -1,
    });
    expect(view.percent).toBeNull();
    expect(view.headline).not.toMatch(/0 of 300/);
    expect(view.headline).not.toMatch(/\b30[01] of 300/);
  });

  it("slice mode reports scene-remaining as unknown, never as all-of-them", () => {
    // This is the exact lie from the HAR: scenesRemaining 300 built from a
    // matched count of 0 read out of the wrong table.
    const counts = harProjectCounts();
    expect(counts.scenesRemaining).toBeNull();
    expect(counts.slicesFilled).toBe(558);
    expect(counts.slicesExpected).toBe(616);
  });

  it("a project with no writes at all is not-yet-started, never paused", () => {
    // A genuine zero is allowed — a project that has matched nothing shows 0,
    // truthfully. What must NOT happen is the pause notice, because "no
    // timestamp yet" is unknown, not "idle for infinity".
    const counts = assembleMatchingCounts({
      now: NOW,
      totalScenes: 300,
      matchedScenes: 0,
      corpusBuckets: 0,
      corpusBucketsFilled: 0,
      lastProgressAt: [null, null, null],
    });
    expect(counts.msSinceProgress).toBeNull();
    const view = describeMatchingProgress(counts);
    expect(view.paused).toBe(false);
    expect(view.pausedNotice).toBeNull();
  });

  it("progress freshness is the NEWEST source, not the first one found", () => {
    const counts = harProjectCounts();
    // The corpus is 30 minutes stale but the newest slice is 4 seconds old.
    expect(counts.msSinceProgress).toBe(4_000);
  });
});

describe("both components count clip slots the same way", () => {
  it("one scene shorter than the clip duration still gets one slot", () => {
    expect(expectedFixedSlicesForScenes([{ start_ts: 0, end_ts: 2 }], 4)).toBe(1);
  });

  it("a scene's visual span runs to the next scene's start", () => {
    // Scene 1 nominally ends at 3 but the next starts at 8: its clips cover
    // the gap, so it needs ceil(8/4) = 2 slots, not ceil(3/4) = 1.
    const scenes = [
      { start_ts: 0, end_ts: 3 },
      { start_ts: 8, end_ts: 12 },
    ];
    expect(expectedFixedSlicesForScenes(scenes, 4)).toBe(3);
  });

  it("is defensive about a nonsense duration", () => {
    expect(expectedFixedSlicesForScenes([{ start_ts: 0, end_ts: 10 }], 0)).toBe(0);
    expect(expectedFixedSlicesForScenes([{ start_ts: 0, end_ts: 10 }], NaN)).toBe(0);
  });
});

describe("the wiring that needs a database is pinned at the source", () => {
  const pipeline = readFileSync(resolve(process.cwd(), "src/lib/pipeline.functions.ts"), "utf8");
  const lockNotHeld = pipeline.slice(
    pipeline.indexOf("if (!lockHeld) {"),
    pipeline.indexOf("const {\n      cacheScenes,"),
  );

  it("a lock-not-held poll reads real progress before returning", () => {
    // A peer doing the work is not a reason to know nothing about it.
    expect(lockNotHeld).toMatch(/readProjectMatchingCounts\(supabaseAdmin, \{ id: projectId \}\)/);
    // Format-insensitive: prettier may keep `lockHeld: 0, progress }` on one
    // line or wrap each property onto its own.
    expect(lockNotHeld).toMatch(/lockHeld: 0,\s+progress,?\s*\}/);
  });

  it("a failed progress read degrades to null, never breaks the guard", () => {
    expect(lockNotHeld).toMatch(/catch/);
    expect(lockNotHeld).toMatch(/let progress = null/);
  });

  it("the panel and the pipeline share one reader", () => {
    const progressFn = readFileSync(
      resolve(process.cwd(), "src/lib/matching-progress.functions.ts"),
      "utf8",
    );
    expect(progressFn).toMatch(/matching-counts\.server/);
    expect(lockNotHeld).toMatch(/matching-counts\.server/);
  });

  it("the shared reader takes slice progress from the timeline's table", () => {
    const reader = readFileSync(resolve(process.cwd(), "src/lib/matching-counts.server.ts"), "utf8");
    expect(reader).toMatch(/render_clip_slices/);
    // And the page no longer keeps a private copy of the slot arithmetic.
    const page = readFileSync(
      resolve(process.cwd(), "src/routes/_authenticated/projects.$projectId.tsx"),
      "utf8",
    );
    expect(page).not.toMatch(/function expectedFixedSlicesForScenes/);
    expect(page).toMatch(/expectedFixedSlicesForScenes/);
  });
});
