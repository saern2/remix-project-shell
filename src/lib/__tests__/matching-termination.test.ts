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
  idleTerminalDecision,
  maxIdleMatchingRounds,
  unmatchedSceneFailureThreshold,
} from "../pipeline.functions";

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
