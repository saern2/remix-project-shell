import { afterEach, describe, expect, it } from "vitest";

import { createMatchingBudget, matchingTimeBudgetMs } from "../matching-budget";

/** Mocked clock — advance time explicitly instead of sleeping. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("matching time budget — slice admission (mocked clock)", () => {
  it("always runs the first slice, guaranteeing forward progress", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });
    expect(budget.shouldStartAnotherSlice(0)).toBe(true);
  });

  it("still runs the first slice when the budget is zero or nonsensical", () => {
    // Without this a misconfigured budget would return matching_footage forever
    // having done no work, and the project would never reach ready.
    const clock = fakeClock();
    for (const budgetMs of [0, -5000]) {
      const budget = createMatchingBudget({ budgetMs, now: clock.now });
      expect(budget.shouldStartAnotherSlice(0)).toBe(true);
    }
  });

  it("starts another slice while the projected finish fits the budget", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });

    clock.advance(4_000); // one slice took 4s; projected next finish 8s <= 12s
    expect(budget.shouldStartAnotherSlice(1)).toBe(true);

    clock.advance(4_000); // two slices, 8s total, avg 4s; projected 12s <= 12s
    expect(budget.shouldStartAnotherSlice(2)).toBe(true);
  });

  it("stops when the projected finish would overshoot the budget", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });

    clock.advance(7_000); // avg 7s; projected 14s > 12s — do not start another
    expect(budget.shouldStartAnotherSlice(1)).toBe(false);
  });

  it("stops once the budget is already spent, regardless of projection", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });

    clock.advance(12_000);
    expect(budget.shouldStartAnotherSlice(3)).toBe(false);

    clock.advance(30_000); // badly over — still false, never negative-loops
    expect(budget.shouldStartAnotherSlice(4)).toBe(false);
  });

  it("never overshoots the budget for evenly-paced slices", () => {
    // The guarantee that matters: with steady slice durations the invocation
    // finishes at or under budget, instead of the measured 38-44s.
    // Production measured ~1.6s/scene, so these span 1-5 scenes per slice.
    for (const sliceMs of [1_600, 3_200, 4_800, 6_400, 8_000]) {
      const clock = fakeClock();
      const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });

      let slices = 0;
      while (budget.shouldStartAnotherSlice(slices) && slices < 100) {
        clock.advance(sliceMs);
        slices += 1;
      }

      expect(slices).toBeGreaterThanOrEqual(1); // always makes progress
      expect(budget.elapsedMs()).toBeLessThanOrEqual(12_000);
    }
  });

  it("absorbs one pathologically slow first slice but refuses to start another", () => {
    // An in-flight slice cannot be preempted, so a single very slow first slice
    // can exceed the budget. The guard's job is to ensure it is the ONLY one.
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });

    clock.advance(30_000); // first slice badly overran
    expect(budget.shouldStartAnotherSlice(1)).toBe(false);
  });

  it("reports elapsed time from the mocked clock", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 12_000, now: clock.now });
    expect(budget.elapsedMs()).toBe(0);
    clock.advance(2_500);
    expect(budget.elapsedMs()).toBe(2_500);
  });
});

describe("matching time budget — configuration", () => {
  afterEach(() => {
    delete process.env.MATCHING_TIME_BUDGET_MS;
  });

  it("defaults to 12 seconds when unset", () => {
    delete process.env.MATCHING_TIME_BUDGET_MS;
    expect(matchingTimeBudgetMs()).toBe(12_000);
  });

  it("honours a configured override", () => {
    process.env.MATCHING_TIME_BUDGET_MS = "8000";
    expect(matchingTimeBudgetMs()).toBe(8_000);
  });

  it("falls back to the default for invalid or non-positive values", () => {
    for (const raw of ["not-a-number", "0", "-1", ""]) {
      process.env.MATCHING_TIME_BUDGET_MS = raw;
      expect(matchingTimeBudgetMs()).toBe(12_000);
    }
  });
});
