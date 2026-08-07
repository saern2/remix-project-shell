/**
 * The three and a half minutes that looked like a crash.
 *
 * On a real 286-scene project the corpus build ran 17:31:51 -> 17:35:23 with
 * cellsPending falling 80 -> 74 -> 66 -> ... -> 2, and scenesProcessed at 0
 * throughout — correct, because assignment does not begin until the corpus is
 * complete. The UI showed a status pill and "Updated less than a minute ago".
 * The person who built the system read it as stalled.
 *
 * These pin the property that matters: during the corpus phase there is always
 * something to show, and it always moves.
 */
import { describe, expect, it } from "vitest";

import {
  describeMatchingProgress,
  describeRemainingTime,
  PAUSED_AFTER_MS,
  shortMatchingLabel,
} from "../matching-progress";

describe("the corpus build phase", () => {
  it("names the phase and the count rather than showing nothing", () => {
    const view = describeMatchingProgress({
      corpusCellsPending: 74,
      corpusCellsTotal: 80,
      totalScenes: 286,
      scenesRemaining: 286,
    });
    expect(view.phase).toBe("preparing");
    expect(view.headline).toContain("74 searches remaining");
    expect(view.headline).toContain("80");
  });

  it("says an empty timeline is expected, which is the part that alarms people", () => {
    const view = describeMatchingProgress({ corpusCellsPending: 74, corpusCellsTotal: 80 });
    expect(view.detail).toMatch(/timeline stays empty/i);
    expect(view.detail).toMatch(/next step/i);
  });

  it("moves on every one of the observed production readings", () => {
    // The exact sequence from the capture. Each must produce a strictly higher
    // percentage than the last — that is the whole point.
    const readings = [80, 74, 66, 58, 52, 48, 44, 36, 30, 26, 20, 16, 10, 6, 2];
    const percents = readings.map(
      (pending) =>
        describeMatchingProgress({ corpusCellsPending: pending, corpusCellsTotal: 80 }).percent!,
    );
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1]);
    }
    expect(percents[0]).toBe(0);
    expect(percents[percents.length - 1]).toBeGreaterThan(95);
  });

  it("estimates from the observed ~6 cells per invocation", () => {
    // 74 cells ≈ 13 invocations ≈ 3 minutes, which is what the capture showed.
    const view = describeMatchingProgress({ corpusCellsPending: 74, corpusCellsTotal: 80 });
    expect(view.estimate).toMatch(/about \d+ minutes left/);
  });

  it("stays on the corpus phase while any cell is pending", () => {
    // Even one remaining cell means assignment has not begun, so reporting
    // scenes would show 0 of 286 and read as stuck.
    const view = describeMatchingProgress({
      corpusCellsPending: 2,
      corpusCellsTotal: 80,
      totalScenes: 286,
      scenesRemaining: 286,
    });
    expect(view.phase).toBe("preparing");
  });
});

describe("the assignment phase", () => {
  it("counts scenes done, not scenes left", () => {
    // "180 of 286" is progress; "106 remaining" is a chore.
    const view = describeMatchingProgress({
      corpusCellsPending: 0,
      totalScenes: 286,
      scenesRemaining: 106,
    });
    expect(view.phase).toBe("matching");
    expect(view.headline).toBe("Matching footage — 180 of 286 scenes");
    expect(view.percent).toBe(63);
  });

  it("tracks the observed run from 286 remaining down to 106", () => {
    const readings = [286, 281, 271, 256, 241, 106];
    const percents = readings.map(
      (remaining) =>
        describeMatchingProgress({
          corpusCellsPending: 0,
          totalScenes: 286,
          scenesRemaining: remaining,
        }).percent!,
    );
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
    expect(percents[0]).toBe(0);
  });

  it("reaches 100 and says it is finishing", () => {
    const view = describeMatchingProgress({
      corpusCellsPending: 0,
      totalScenes: 286,
      scenesRemaining: 0,
    });
    expect(view.percent).toBe(100);
    expect(view.phase).toBe("finishing");
  });
});

describe("when the counts are not known yet", () => {
  it("shows a phase but no fake zero", () => {
    // A bar pinned at 0% reads as stuck — the exact impression this prevents.
    const view = describeMatchingProgress({});
    expect(view.percent).toBeNull();
    expect(view.headline).toMatch(/preparing/i);
  });

  it("ignores a scene count of zero rather than dividing by it", () => {
    const view = describeMatchingProgress({ totalScenes: 0, scenesRemaining: 0 });
    expect(view.percent).toBeNull();
  });
});

describe("time estimates", () => {
  it("rounds to language a person would use", () => {
    expect(describeRemainingTime(30)).toBe("about a minute left");
    expect(describeRemainingTime(120)).toBe("about 2 minutes left");
    expect(describeRemainingTime(195)).toBe("about 3 minutes left");
  });

  it("returns nothing rather than a nonsense estimate", () => {
    expect(describeRemainingTime(0)).toBeNull();
    expect(describeRemainingTime(-5)).toBeNull();
    expect(describeRemainingTime(NaN)).toBeNull();
  });
});

describe("the dashboard row", () => {
  it("fits the phase and the percentage on one line", () => {
    expect(shortMatchingLabel({ corpusCellsPending: 74, corpusCellsTotal: 80 })).toBe(
      "Preparing footage library — 74 searches remaining of 80 (8%)",
    );
  });

  it("omits the percentage when there is nothing to measure", () => {
    expect(shortMatchingLabel({})).not.toContain("%");
  });
});

/**
 * A paused project must not look like a broken one.
 *
 * Matching only advances while a tab polls. Closing the tab pauses it; opening
 * the tab resumes it exactly where it stopped. That behaviour is correct — the
 * defect was that it was invisible, and a paused project was indistinguishable
 * from a stalled one. It cost two separate investigations, by the person who
 * built the system.
 */
describe("the paused notice", () => {
  it("stays quiet while work is flowing", () => {
    // The slowest observed invocation was 19,022ms. A project mid-work must
    // never trip this.
    for (const idle of [0, 5_000, 19_022, 45_000, PAUSED_AFTER_MS - 1]) {
      const view = describeMatchingProgress({
        corpusCellsPending: 40,
        corpusCellsTotal: 80,
        msSinceProgress: idle,
      });
      expect(view.paused).toBe(false);
      expect(view.pausedNotice).toBeNull();
    }
  });

  it("appears once nothing has moved for the threshold", () => {
    const view = describeMatchingProgress({
      corpusCellsPending: 40,
      corpusCellsTotal: 80,
      msSinceProgress: PAUSED_AFTER_MS,
    });
    expect(view.paused).toBe(true);
    expect(view.pausedNotice).toMatch(/resuming now/i);
  });

  it("says the work is safe and asks for nothing", () => {
    // Someone returning to a tab needs to know the project is fine, not to be
    // given a task.
    const view = describeMatchingProgress({ msSinceProgress: 10 * 60_000 });
    expect(view.pausedNotice).toMatch(/nothing was lost/i);
    expect(view.pausedNotice).toMatch(/polling/i);
    expect(view.pausedNotice).not.toMatch(/error|failed|retry|contact/i);
  });

  it("never claims the viewer's tab caused the pause", () => {
    // The notice is computed from database timestamps, which cannot know whose
    // tab did what. The old wording — "it stopped when the tab was closed" —
    // was read by a second viewer as a statement about a tab they never
    // closed, on a project that was not even paused.
    const view = describeMatchingProgress({ msSinceProgress: 10 * 60_000 });
    expect(view.pausedNotice).not.toMatch(/tab was closed/i);
    expect(view.pausedNotice).not.toMatch(/stopped when/i);
  });

  it("clears the moment progress resumes", () => {
    const paused = describeMatchingProgress({
      totalScenes: 286,
      scenesRemaining: 100,
      msSinceProgress: 120_000,
    });
    const resumed = describeMatchingProgress({
      totalScenes: 286,
      scenesRemaining: 95,
      msSinceProgress: 1_000,
    });
    expect(paused.paused).toBe(true);
    expect(resumed.paused).toBe(false);
    expect(resumed.pausedNotice).toBeNull();
  });

  it("keeps the counts and the bar visible while paused", () => {
    // The notice sits beside the progress; it never replaces it, so it stays
    // obvious how far the work actually got.
    const view = describeMatchingProgress({
      totalScenes: 286,
      scenesRemaining: 106,
      msSinceProgress: 300_000,
    });
    expect(view.paused).toBe(true);
    expect(view.headline).toBe("Matching footage — 180 of 286 scenes");
    expect(view.percent).toBe(63);
    expect(view.phase).toBe("matching");
  });

  it("is not paused when nothing has been written yet", () => {
    // A project that has not started is not a paused one. msSinceProgress is
    // null until the first real write.
    expect(describeMatchingProgress({ msSinceProgress: null }).paused).toBe(false);
    expect(describeMatchingProgress({}).paused).toBe(false);
  });

  it("leads the dashboard row so it reads at a glance", () => {
    const label = shortMatchingLabel({
      totalScenes: 286,
      scenesRemaining: 106,
      msSinceProgress: 300_000,
    });
    expect(label.startsWith("Paused — resuming now")).toBe(true);
    expect(label).toContain("180 of 286");
  });

  it("uses a threshold above the slowest observed invocation", () => {
    expect(PAUSED_AFTER_MS).toBeGreaterThan(19_022);
  });
});
