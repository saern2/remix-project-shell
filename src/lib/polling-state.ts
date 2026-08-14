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

/**
 * A matching invocation that did real work cannot have been quick.
 *
 * MEASURED 2026-08-14, two full runs, 69 matching polls: the FASTEST response
 * that carried working telemetry was 10,040 ms, median ~14s. That is structural
 * rather than lucky — shouldStartAnotherSlice returns true unconditionally when
 * no slice has run yet (matching-budget.ts, the forward-progress guarantee), so
 * an invocation that takes the matching lock always does at least one full unit
 * of work and in practice runs to the 12s budget.
 *
 * So this threshold sits an order of magnitude below every real invocation and
 * above every fast return. It is the guard that does NOT depend on knowing the
 * shape of every early exit: the checks below enumerate the fast paths that
 * exist today, and this one catches the fast path somebody adds tomorrow.
 * Without it, a future early return that reports matching_footage with
 * outstanding work turns the poll loop into a tight loop bounded only by
 * network latency.
 */
export const MIN_ADVANCING_INVOCATION_MS = 2000;

/** The fields of a pollPipeline response this decision reads. */
export type PipelinePollResult = {
  status?: string;
  paused_for_maintenance?: boolean;
  matching?: { lockHeld?: number; remaining?: number };
} | null;

/**
 * Whether the invocation that just returned was one that advanced matching, and
 * therefore whether the next poll should go out immediately.
 *
 * MEASURED: waiting 4s after each of these cost 118.0s of a 474.5s run and
 * 209.6s of an 833.5s run — 25% of matching, spent doing nothing, because the
 * work is server-side and the client's fixed cadence is unrelated to it.
 */
function advancedMatching(result: PipelinePollResult, elapsedMs: number): boolean {
  if (!result || result.status !== "matching_footage") return false;
  // Maintenance returns the project's CURRENT status and no telemetry at all.
  if (result.paused_for_maintenance) return false;
  const matching = result.matching;
  // No telemetry means no invocation ran: the transition INTO matching_footage
  // returns bare, and so would any future early exit that forgets to report.
  if (!matching) return false;
  // A peer holds the single-flight lock; this response did no work and says so
  // with lockHeld: 0 and remaining: -1.
  if (matching.lockHeld === 0) return false;
  // Nothing outstanding — let the status transition arrive on the normal beat.
  if ((matching.remaining ?? 0) <= 0) return false;
  return elapsedMs >= MIN_ADVANCING_INVOCATION_MS;
}

/**
 * Delay before the next pipeline poll, given what the last one returned.
 *
 * Errors keep the exponential backoff untouched — that guard exists because
 * fixed-interval retries stacked invocations on a struggling server function,
 * and an immediate retry is the exact behaviour it was added to remove.
 */
export function nextPipelinePollDelayMs(opts: {
  result: PipelinePollResult;
  elapsedMs: number;
  consecutiveErrors: number;
}): number {
  if (opts.consecutiveErrors > 0) return nextPollDelayMs(opts.consecutiveErrors);
  return advancedMatching(opts.result, opts.elapsedMs) ? 0 : nextPollDelayMs(0);
}
