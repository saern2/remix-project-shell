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
