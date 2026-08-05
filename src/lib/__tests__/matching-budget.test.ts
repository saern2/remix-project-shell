import { afterEach, describe, expect, it } from "vitest";

import { createMatchingBudget, matchingSliceSize, matchingTimeBudgetMs } from "../matching-budget";

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
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });
    expect(budget.shouldStartAnotherSlice()).toBe(true);
  });

  it("still runs the first slice when the budget is zero or nonsensical", () => {
    // Without this a misconfigured budget would return matching_footage forever
    // having done no work, and the project would never reach ready.
    const clock = fakeClock();
    for (const budgetMs of [0, -5000]) {
      const budget = createMatchingBudget({ budgetMs, now: clock.now });
      expect(budget.shouldStartAnotherSlice()).toBe(true);
    }
  });

  it("starts another slice while the projected finish fits the budget", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

    clock.advance(3_200); // slice of 2 scenes at ~1.6s/scene
    budget.recordSlice(3_200);
    expect(budget.shouldStartAnotherSlice()).toBe(true); // 3.2 + 3.2 = 6.4 <= 8

    clock.advance(3_200);
    budget.recordSlice(3_200);
    expect(budget.shouldStartAnotherSlice()).toBe(false); // 6.4 + 3.2 = 9.6 > 8
  });

  it("stops when the projected finish would overshoot the budget", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

    clock.advance(5_000);
    budget.recordSlice(5_000); // projected 10s > 8s — do not start another
    expect(budget.shouldStartAnotherSlice()).toBe(false);
  });

  it("stops once the budget is already spent, regardless of projection", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

    clock.advance(8_000);
    budget.recordSlice(8_000);
    expect(budget.shouldStartAnotherSlice()).toBe(false);

    clock.advance(30_000); // badly over — still false, never negative-loops
    budget.recordSlice(30_000);
    expect(budget.shouldStartAnotherSlice()).toBe(false);
  });

  it("never overshoots the budget for evenly-paced slices", () => {
    // The guarantee that matters: with steady slice durations the invocation
    // finishes at or under budget.
    for (const sliceMs of [800, 1_600, 3_200, 4_800]) {
      const clock = fakeClock();
      const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

      let slices = 0;
      while (budget.shouldStartAnotherSlice() && slices < 100) {
        clock.advance(sliceMs);
        budget.recordSlice(sliceMs);
        slices += 1;
      }

      expect(slices).toBeGreaterThanOrEqual(1); // always makes progress
      expect(budget.elapsedMs()).toBeLessThanOrEqual(8_000);
    }
  });

  it("counts SETUP time against the budget but not against slice cost", () => {
    // The deployed miss: a 12s budget produced 15-19s invocations because setup
    // (session creation, cache prefetch, DB reads) ran before the clock started.
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

    clock.advance(5_000); // expensive setup, inside the budget now
    expect(budget.shouldStartAnotherSlice()).toBe(true); // first slice still runs

    clock.advance(3_200);
    budget.recordSlice(3_200);

    const stats = budget.stats();
    expect(stats.setupMs).toBe(5_000); // setup attributed correctly
    expect(stats.sliceMs).toBe(3_200); // and NOT blamed on the slice
    expect(stats.slices).toBe(1);
    // elapsed 8.2s; a second slice would reach 11.4s — refused.
    expect(budget.shouldStartAnotherSlice()).toBe(false);
  });

  it("worst case is bounded by setup + one slice when setup eats the budget", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

    clock.advance(8_000); // setup alone consumed the whole budget
    expect(budget.shouldStartAnotherSlice()).toBe(true); // forward progress
    clock.advance(3_200);
    budget.recordSlice(3_200);

    expect(budget.elapsedMs()).toBe(11_200); // 8s + one 2-scene slice
    expect(budget.shouldStartAnotherSlice()).toBe(false);
  });

  it("absorbs one pathologically slow first slice but refuses to start another", () => {
    // An in-flight slice cannot be preempted, so a single very slow first slice
    // can exceed the budget. The guard's job is to ensure it is the ONLY one.
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });

    clock.advance(30_000); // first slice badly overran
    budget.recordSlice(30_000);
    expect(budget.shouldStartAnotherSlice()).toBe(false);
  });

  it("reports elapsed time from the mocked clock", () => {
    const clock = fakeClock();
    const budget = createMatchingBudget({ budgetMs: 8_000, now: clock.now });
    expect(budget.elapsedMs()).toBe(0);
    clock.advance(2_500);
    expect(budget.elapsedMs()).toBe(2_500);
  });
});

describe("matching time budget — configuration", () => {
  afterEach(() => {
    delete process.env.MATCHING_TIME_BUDGET_MS;
    delete process.env.MATCHING_SLICE_SIZE;
  });

  it("defaults to 12 seconds when unset", () => {
    delete process.env.MATCHING_TIME_BUDGET_MS;
    expect(matchingTimeBudgetMs()).toBe(12_000);
  });

  it("honours a configured override", () => {
    process.env.MATCHING_TIME_BUDGET_MS = "5000";
    expect(matchingTimeBudgetMs()).toBe(5_000);
  });

  it("defaults the slice size to 5 and honours overrides", () => {
    delete process.env.MATCHING_SLICE_SIZE;
    expect(matchingSliceSize()).toBe(5);
    process.env.MATCHING_SLICE_SIZE = "4";
    expect(matchingSliceSize()).toBe(4);
    for (const raw of ["0", "-3", "nope", ""]) {
      process.env.MATCHING_SLICE_SIZE = raw;
      expect(matchingSliceSize()).toBe(5);
    }
  });

  it("falls back to the default for invalid or non-positive values", () => {
    for (const raw of ["not-a-number", "0", "-1", ""]) {
      process.env.MATCHING_TIME_BUDGET_MS = raw;
      expect(matchingTimeBudgetMs()).toBe(12_000);
    }
  });
});
