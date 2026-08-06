/**
 * matching_footage must always end.
 *
 * A 524-scene project froze at 503 matched and polled indefinitely: the lock was
 * healthy, the corpus was full, and the 21 unmatched scenes were the contiguous
 * tail — idx 503 to 523 — each with a valid visual_query. Invocations took 78ms,
 * far too little to attempt anything.
 *
 * Three conditions held at once. No work was attempted, the completion check
 * disagreed so it could not reach ready, and 21 unmatched was below the
 * max(2, ceil(524*0.1)) = 53 failure threshold so it could not fail. The
 * threshold was correct; what it removed was the accidental terminal condition a
 * hard failure used to provide.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  describeProgress,
  idleTerminalDecision,
  isIdleInvocation,
  maxIdleMatchingRounds,
  unmatchedSceneFailureThreshold,
} from "../pipeline.functions";

/**
 * Replays a sequence of invocations through the watchdog rule, returning the
 * idle-round count after each. The counter resets on any progress and is
 * compared against the limit — the same two rules the handler applies.
 */
function replay(invocations: Array<Record<string, number> | "lock-held-by-peer">) {
  const limit = maxIdleMatchingRounds();
  let idleRounds = 0;
  const history: Array<{ idleRounds: number; terminated: boolean }> = [];
  for (const invocation of invocations) {
    if (invocation === "lock-held-by-peer") {
      // Returns before the watchdog entirely: no work was attempted because a
      // peer was doing it. The counter must not move.
      history.push({ idleRounds, terminated: false });
      continue;
    }
    idleRounds = isIdleInvocation(invocation) ? idleRounds + 1 : 0;
    history.push({ idleRounds, terminated: idleRounds >= limit });
  }
  return history;
}

afterEach(() => {
  delete process.env.MATCHING_MAX_IDLE_ROUNDS;
  delete process.env.MATCHING_MAX_UNMATCHED_FRACTION;
});

describe("the idle-round watchdog", () => {
  it("gives up after three idle invocations by default", () => {
    expect(maxIdleMatchingRounds()).toBe(3);
  });

  it("is configurable and survives a bad value", () => {
    process.env.MATCHING_MAX_IDLE_ROUNDS = "5";
    expect(maxIdleMatchingRounds()).toBe(5);
    process.env.MATCHING_MAX_IDLE_ROUNDS = "nonsense";
    expect(maxIdleMatchingRounds()).toBe(3);
  });
});

describe("the exact production deadlock now terminates", () => {
  // 524 scenes, 21 unmatched, threshold 53. Previously: cannot proceed, cannot
  // fail, polls forever.
  const PRODUCTION = { totalScenes: 524, unmatchedScenes: 21 };

  it("is the case that could neither complete nor fail", () => {
    expect(unmatchedSceneFailureThreshold(PRODUCTION.totalScenes)).toBe(53);
    expect(PRODUCTION.unmatchedScenes).toBeLessThan(53);
  });

  it("completes rather than spinning, because 21 of 524 is worth shipping", () => {
    const decision = idleTerminalDecision(PRODUCTION);
    expect(decision.action).toBe("complete");
    expect(decision.reason).toContain("21 of 524");
    expect(decision.reason).toContain("53");
  });

  it("fails, with the count named, when too many scenes are unmatched", () => {
    const decision = idleTerminalDecision({ totalScenes: 524, unmatchedScenes: 200 });
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("200 of 524");
    // The user reads this. It must say what happened and what to do.
    expect(decision.reason).toMatch(/retry matching/i);
  });

  it("never leaves a third outcome — every decision is complete or fail", () => {
    for (const unmatched of [0, 1, 20, 52, 53, 100, 524]) {
      const decision = idleTerminalDecision({ totalScenes: 524, unmatchedScenes: unmatched });
      expect(["complete", "fail"]).toContain(decision.action);
    }
  });

  it("terminates for a project where nothing can ever match", () => {
    // The pathological case: no scene matched, ever. It must fail rather than
    // poll, and say so plainly.
    const decision = idleTerminalDecision({ totalScenes: 524, unmatchedScenes: 524 });
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("524 of 524");
  });

  it("completes a tiny project with a single stubborn scene", () => {
    // threshold is max(2, ...) so 1 unmatched is always below it: the round-10
    // promise that one scene never fails a project still holds, and now it
    // terminates instead of looping.
    const decision = idleTerminalDecision({ totalScenes: 5, unmatchedScenes: 1 });
    expect(decision.action).toBe("complete");
  });

  it("honours a widened failure fraction", () => {
    process.env.MATCHING_MAX_UNMATCHED_FRACTION = "0.02";
    // 2% of 524 is 11, so 21 unmatched now fails instead of completing.
    expect(unmatchedSceneFailureThreshold(524)).toBe(11);
    expect(idleTerminalDecision(PRODUCTION).action).toBe("fail");
  });
});

/**
 * The regression this file failed to catch the first time.
 *
 * The watchdog counted only scenes assigned. Assignment does not begin until the
 * corpus is complete — that is the round-8 design — so `scenesMatched` is
 * legitimately 0 for the whole build phase. A real 145-scene run built 6 cells
 * per invocation with cellsPending falling 74 -> 68 -> ... and was failed after
 * three of them, mid-build, with the message "the footage corpus could not
 * supply these scenes" while the corpus was fine and still filling.
 *
 * The old test suite only covered the ASSIGNMENT phase, which is exactly why it
 * passed.
 */
describe("the corpus build phase is not a stall", () => {
  it("does not fail a project whose corpus takes 12+ invocations", () => {
    // 74 cells at ~6 per invocation, then assignment begins.
    const build = Array.from({ length: 13 }, () => ({
      scenesMatched: 0,
      corpusCellsBuilt: 6,
    }));
    const history = replay([...build, { scenesMatched: 5, corpusCellsBuilt: 0 }]);

    expect(history.some((step) => step.terminated)).toBe(false);
    expect(history.every((step) => step.idleRounds === 0)).toBe(true);
  });

  it("treats cells built as progress even with zero scenes matched", () => {
    expect(isIdleInvocation({ scenesMatched: 0, corpusCellsBuilt: 6 })).toBe(false);
    expect(isIdleInvocation({ scenesMatched: 0, corpusCellsBuilt: 1 })).toBe(false);
  });

  it("reports which counter advanced, so a misfire is visible in one log line", () => {
    expect(describeProgress({ scenesMatched: 0, corpusCellsBuilt: 6 })).toEqual([
      "corpusCellsBuilt=6",
    ]);
    expect(describeProgress({ scenesMatched: 5, corpusCellsBuilt: 0 })).toEqual([
      "scenesMatched=5",
    ]);
    expect(describeProgress({ scenesMatched: 0, corpusCellsBuilt: 0 })).toEqual([]);
  });

  it("counts an invocation idle only when EVERY counter is zero", () => {
    expect(isIdleInvocation({ scenesMatched: 0, corpusCellsBuilt: 0 })).toBe(true);
    expect(isIdleInvocation({})).toBe(true);
  });

  it("protects a future phase automatically once it reports a counter", () => {
    // The generalisation that matters: idleness is "all zero", so a phase that
    // assigns no scenes is safe the moment it reports anything at all.
    expect(isIdleInvocation({ scenesMatched: 0, somethingNewEntirely: 3 })).toBe(false);
  });
});

describe("a genuine stall still terminates", () => {
  it("fires after three invocations that advance nothing", () => {
    const history = replay([
      { scenesMatched: 0, corpusCellsBuilt: 0 },
      { scenesMatched: 0, corpusCellsBuilt: 0 },
      { scenesMatched: 0, corpusCellsBuilt: 0 },
    ]);
    expect(history.map((step) => step.idleRounds)).toEqual([1, 2, 3]);
    expect(history[2].terminated).toBe(true);
  });

  it("restarts the count when progress resumes", () => {
    // Two idle rounds then a corpus cell: the project gets its full budget back
    // rather than dying on the next quiet invocation.
    const history = replay([
      { scenesMatched: 0, corpusCellsBuilt: 0 },
      { scenesMatched: 0, corpusCellsBuilt: 0 },
      { scenesMatched: 0, corpusCellsBuilt: 4 },
      { scenesMatched: 0, corpusCellsBuilt: 0 },
    ]);
    expect(history.map((step) => step.idleRounds)).toEqual([1, 2, 0, 1]);
    expect(history.some((step) => step.terminated)).toBe(false);
  });

  it("never increments while a peer holds the lock", () => {
    // lockHeld 0 / remaining -1. The invocation did no work because another one
    // was working — correct behaviour, not a stall.
    const history = replay([
      { scenesMatched: 0, corpusCellsBuilt: 0 },
      "lock-held-by-peer",
      "lock-held-by-peer",
      "lock-held-by-peer",
      "lock-held-by-peer",
    ]);
    expect(history.map((step) => step.idleRounds)).toEqual([1, 1, 1, 1, 1]);
    expect(history.some((step) => step.terminated)).toBe(false);
  });

  it("cannot be starved into failure by interleaved peer polls", () => {
    const history = replay([
      "lock-held-by-peer",
      { scenesMatched: 0, corpusCellsBuilt: 6 },
      "lock-held-by-peer",
      { scenesMatched: 0, corpusCellsBuilt: 6 },
    ]);
    expect(history.every((step) => step.idleRounds === 0)).toBe(true);
  });
});

describe("the terminal message says what actually happened", () => {
  it("does not blame the corpus by default", () => {
    // The old message asserted "the footage corpus could not supply these
    // scenes" in every case. It fired once, during a healthy corpus build, and
    // sent the investigation the wrong way.
    const decision = idleTerminalDecision({ totalScenes: 524, unmatchedScenes: 200 });
    expect(decision.reason).not.toMatch(/corpus could not supply/i);
  });

  it("carries the dominant reason code from the pending breakdown", () => {
    const decision = idleTerminalDecision({
      totalScenes: 524,
      unmatchedScenes: 200,
      dominantReason: "not in any corpus bucket — clustering predates this scene",
    });
    expect(decision.reason).toContain("not in any corpus bucket");
  });

  it("omits the clause entirely when no reason was gathered", () => {
    const decision = idleTerminalDecision({ totalScenes: 524, unmatchedScenes: 200 });
    expect(decision.reason).not.toContain("Most common reason");
  });
});
