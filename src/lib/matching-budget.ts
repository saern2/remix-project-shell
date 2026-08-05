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

// Round 6 follow-up: with 8s/2 scenes, 145 scenes took 56 invocations because
// ~4.9s of every ~9.1s invocation was per-invocation setup that scaled with the
// PROJECT (all scenes re-read, the whole stock_search_cache prefetched, the key
// pool reloaded) rather than with the slice. That setup is now O(slice), which
// frees the budget for actual matching: a bigger slice and a longer budget now
// buy scenes instead of buying repeated setup.
//
// Note the cap this implies. An in-flight slice cannot be preempted, so the true
// worst case per invocation is `budget + one slice`, not `budget`. The larger
// slice is deliberately paired with the tighter setup: the first slice now
// starts at ~0.3s elapsed instead of ~4.9s, so the projection guard has the
// budget's full width to work with and lands invocations near it rather than
// past it.
const DEFAULT_MATCHING_TIME_BUDGET_MS = 12_000;
const DEFAULT_MATCHING_SLICE_SIZE = 5;

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
  /** Milliseconds elapsed since the budget was created (invocation start). */
  elapsedMs: () => number;
  /** Records how long a completed slice took, feeding the projection guard. */
  recordSlice: (durationMs: number) => void;
  /** Whether another slice of work should be started. */
  shouldStartAnotherSlice: () => boolean;
  /** Slice accounting for logging: how many ran and how long they took in total. */
  stats: () => { slices: number; sliceMs: number; setupMs: number };
};

/**
 * Creates a wall-clock budget covering the WHOLE invocation.
 *
 * Create this at the top of the handler, before any setup work. The first
 * deployed version started the clock at the slice loop, so per-invocation setup
 * (session creation, stock_search_cache prefetch, project/scene/selection reads)
 * fell outside the budget entirely — a 12s budget produced 15-19s invocations.
 * Covering setup is what makes "budget + one slice" a true worst-case bound.
 *
 * Setup time is deliberately excluded from the slice average: elapsed time is
 * used for the deadline, but the projection uses only measured slice durations,
 * so a slow setup does not make slices look more expensive than they are.
 *
 * `now` is injectable so the decision logic can be unit-tested with a mocked
 * clock rather than real sleeps.
 */
export function createMatchingBudget({
  budgetMs,
  now = Date.now,
}: {
  budgetMs: number;
  now?: () => number;
}): MatchingBudget {
  const startedAt = now();
  let slices = 0;
  let sliceMs = 0;
  let firstSliceStartedAt: number | null = null;

  return {
    elapsedMs: () => now() - startedAt,

    recordSlice(durationMs: number) {
      if (firstSliceStartedAt === null) firstSliceStartedAt = now() - durationMs;
      slices += 1;
      sliceMs += Math.max(0, durationMs);
    },

    stats: () => ({
      slices,
      sliceMs,
      // Everything before the first slice began: session creation, cache
      // prefetch and the project/scene/selection reads.
      setupMs: firstSliceStartedAt === null ? now() - startedAt : firstSliceStartedAt - startedAt,
    }),

    shouldStartAnotherSlice(): boolean {
      // Forward-progress guarantee: always do at least one slice per invocation,
      // even if setup alone already consumed the budget. Without this a slow
      // setup would return matching_footage forever having done no work.
      if (slices <= 0) return true;

      const elapsed = now() - startedAt;
      if (elapsed >= budgetMs) return false;

      // Projection guard: only start a slice we expect to finish in budget.
      // Uses measured slice cost, not elapsed/slices, so setup is not blamed
      // on the slices.
      const averageSliceMs = sliceMs / slices;
      return elapsed + averageSliceMs <= budgetMs;
    },
  };
}
