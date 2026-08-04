export type PollStatus = { status?: string } | null | undefined;

export function isMissingPollResult(result: PollStatus): boolean {
  return result?.status === "not_found";
}

export function pollIntervalWhileActive(
  subject: PollStatus,
  activeStatuses: ReadonlySet<string>,
  intervalMs: number,
): number | false {
  return subject?.status && activeStatuses.has(subject.status) ? intervalMs : false;
}

/**
 * Delay before the next pipeline poll. On success the loop stays at baseMs; on
 * consecutive errors it backs off exponentially up to maxMs. This stops the
 * client from hammering a struggling server-function with fixed-interval retries
 * that stack concurrent invocations on top of one another (round 6, Issue 6 —
 * "client backoff on 5xx rather than immediate retry").
 */
export function nextPollDelayMs(
  consecutiveErrors: number,
  baseMs = 4000,
  maxMs = 30000,
): number {
  if (consecutiveErrors <= 0) return baseMs;
  const exponent = Math.min(consecutiveErrors, 4); // cap growth at 2^4 = 16×
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
