/**
 * Wall-clock budget for the matching_footage stage.
 *
 * Round 6 follow-up: a fixed 25-scene batch was measured at 38-44s per
 * invocation in production (17 invocations, max 44,094ms, 8 over 20s), which
 * blocked unrelated requests — isAdmin peaked at 17,235ms. The per-project
 * advisory lock was working (peer polls returned in 1-2s); the problem was that
 * a single batch was simply too large a unit of work.
 *
 * matchStockCorpus is a single non-preemptible call, so a time budget can only
 * be enforced *between* units of work. The stage therefore processes small
 * slices in a loop and asks this budget whether another slice should start.
 *
 * The budget is deliberately a "stop starting work" guard, not a hard deadline:
 * an in-flight slice always runs to completion. Two rules keep invocations close
 * to the target anyway:
 *
 *  1. Forward-progress guarantee — the first slice ALWAYS runs, even with a tiny
 *     or zero budget. Without this a misconfigured budget would return
 *     matching_footage forever having done no work, and the project would never
 *     reach ready.
 *  2. Projection guard — after the first slice, another only starts if the
 *     measured average slice duration is projected to fit inside the remaining
 *     budget. This is what prevents overshooting by a whole slice.
 *
 * The projection uses the average across completed slices rather than the last
 * one. Early slices are slower (cold provider cache) and later slices faster
 * (warm session cache), so the average is biased slightly conservative — it
 * stops a little early rather than a little late, which is the safer direction
 * when the whole point is not to block other users.
 */

const DEFAULT_MATCHING_TIME_BUDGET_MS = 12_000;
const DEFAULT_MATCHING_SLICE_SIZE = 3;

/**
 * Wall-clock budget per matching_footage invocation, from MATCHING_TIME_BUDGET_MS.
 * Falls back to the default when unset or not a positive finite number.
 */
export function matchingTimeBudgetMs(): number {
  const configured = Number(process.env.MATCHING_TIME_BUDGET_MS ?? DEFAULT_MATCHING_TIME_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MATCHING_TIME_BUDGET_MS;
}

/**
 * Scenes/slots matched per slice — the granularity at which the budget can stop.
 * Smaller slices track the budget more closely but cluster into fewer shared
 * provider buckets, so they cost slightly more provider requests. From
 * MATCHING_SLICE_SIZE; falls back to the default when unset or invalid.
 */
export function matchingSliceSize(): number {
  const configured = Number(process.env.MATCHING_SLICE_SIZE ?? DEFAULT_MATCHING_SLICE_SIZE);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_MATCHING_SLICE_SIZE;
}

export type MatchingBudget = {
  /** Milliseconds elapsed since the budget was created. */
  elapsedMs: () => number;
  /**
   * Whether another slice of work should be started.
   *
   * @param slicesCompleted how many slices have finished so far in this invocation
   */
  shouldStartAnotherSlice: (slicesCompleted: number) => boolean;
};

/**
 * Creates a wall-clock budget. `now` is injectable so the decision logic can be
 * unit-tested with a mocked clock rather than real sleeps.
 */
export function createMatchingBudget({
  budgetMs,
  now = Date.now,
}: {
  budgetMs: number;
  now?: () => number;
}): MatchingBudget {
  const startedAt = now();

  return {
    elapsedMs: () => now() - startedAt,

    shouldStartAnotherSlice(slicesCompleted: number): boolean {
      // Forward-progress guarantee: always do at least one slice per invocation.
      if (slicesCompleted <= 0) return true;

      const elapsed = now() - startedAt;
      if (elapsed >= budgetMs) return false;

      // Projection guard: only start a slice we expect to finish in budget.
      const averageSliceMs = elapsed / slicesCompleted;
      return elapsed + averageSliceMs <= budgetMs;
    },
  };
}
