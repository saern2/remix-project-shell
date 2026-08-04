/**
 * Timing instrumentation for the matching_footage stage.
 *
 * Matching costs ~1.6-2.3s per scene and nobody has ever measured what that
 * time consists of. This accumulates wall-clock time into named buckets during
 * an invocation so the stage can log ONE breakdown per invocation (not per
 * scene, which would flood the logs).
 *
 * Measurement only — nothing here changes matching behaviour. The point is to
 * find the real cost before optimising, rather than optimising the assumed one.
 *
 * Buckets are wall-clock and can overlap: provider searches run concurrently
 * (asyncPool), so summing every bucket will exceed the invocation duration.
 * Read each bucket as "total time spent inside this kind of work across all
 * concurrent workers", and use `concurrency`-aware judgement when comparing to
 * elapsed. Counters (requests, cache hits/misses) are exact.
 */

export type MatchingProfileSummary = Record<string, number>;

export type MatchingProfile = {
  /** Adds elapsed milliseconds to a timing bucket. */
  add: (bucket: string, ms: number) => void;
  /** Increments a counter bucket (requests, cache hits, ...). */
  count: (bucket: string, n?: number) => void;
  /** Times an async operation into a bucket and returns its result. */
  time: <T>(bucket: string, fn: () => Promise<T>) => Promise<T>;
  /** Times a synchronous operation into a bucket and returns its result. */
  timeSync: <T>(bucket: string, fn: () => T) => T;
  /** Rounded timings + counters, suitable for a single log line. */
  summary: () => MatchingProfileSummary;
};

export function createMatchingProfile(now: () => number = Date.now): MatchingProfile {
  const timings = new Map<string, number>();
  const counters = new Map<string, number>();

  const add = (bucket: string, ms: number) => {
    timings.set(bucket, (timings.get(bucket) ?? 0) + Math.max(0, ms));
  };

  const count = (bucket: string, n = 1) => {
    counters.set(bucket, (counters.get(bucket) ?? 0) + n);
  };

  return {
    add,
    count,

    async time<T>(bucket: string, fn: () => Promise<T>): Promise<T> {
      const startedAt = now();
      try {
        return await fn();
      } finally {
        // Recorded even when the operation throws — a failing provider call
        // still consumed wall-clock time and must show up in the breakdown.
        add(bucket, now() - startedAt);
      }
    },

    timeSync<T>(bucket: string, fn: () => T): T {
      const startedAt = now();
      try {
        return fn();
      } finally {
        add(bucket, now() - startedAt);
      }
    },

    summary(): MatchingProfileSummary {
      const out: MatchingProfileSummary = {};
      for (const [bucket, ms] of timings) out[`${bucket}Ms`] = Math.round(ms);
      for (const [bucket, n] of counters) out[bucket] = n;
      return out;
    },
  };
}
