/**
 * The submission ceiling — the guard the 22 August outage showed was missing.
 *
 * 42 projects were submitted in 40 minutes into a platform whose render box
 * runs 3 projects at a time. Nothing anywhere refused: submitRenderJob accepted
 * every one, the worker's POST /jobs has no load-based rejection, and the
 * admission gate queues but never says no. The pile-up drove chunk medians from
 * 93s to 238s, past the 300s watchdog, and the retry ladder turned the overload
 * into ~350-390 watchdog kills burning roughly two-thirds of all chunk capacity
 * for 12 hours. This module is the refusal that was missing: past the ceiling a
 * submission fails immediately, with the real queue depth in the message,
 * instead of joining a pile that can only end in kills.
 *
 * Pure decision logic lives here so the rule is testable without a database;
 * submitRenderJob supplies the count.
 */

/**
 * How many projects may be queued or rendering platform-wide before new
 * submissions are refused. Overridable via MAX_INFLIGHT_PROJECTS.
 *
 * 12, by the operator's decision (2026-08-23): the binding constraint is
 * sustained CPU duty, not queue wait — the team submits large batches by design
 * and tolerates hours. At the baseline ~15-20 minutes of chunk+stitch time per
 * project across 3 admission slots, 12 in flight is roughly a 1.9-hour wave:
 * bounded, and the batch workflow survives by submitting in waves.
 */
export const DEFAULT_MAX_INFLIGHT_PROJECTS = 12;

/**
 * A render_jobs row older than this no longer counts against the ceiling.
 *
 * Required, not defensive: job c1c1586e sat at 0% for 19 days with a
 * non-terminal status. A naive count of non-terminal rows would have let that
 * one zombie hold a ceiling slot forever — and with enough of them, wedge
 * submissions shut permanently with nothing visibly wrong. No legitimate render
 * approaches this age: the longest healthy renders finish in a few hours.
 */
export const INFLIGHT_STALE_AFTER_HOURS = 24;

/**
 * The render_jobs statuses that mean "this render is still consuming or about
 * to consume capacity". Mirrors the poll path's vocabulary: everything the
 * worker reports that is not in TERMINAL_RENDER_STATUSES
 * (completed/failed/cancelled).
 */
export const INFLIGHT_RENDER_STATUSES = ["queued", "downloading", "rendering"] as const;

/**
 * The ceiling, read from the environment so the operator can tune it without a
 * deploy of code. An unset, empty, or unparsable value falls back to the
 * default — a misconfigured guard must not become a platform-wide outage of
 * its own.
 */
export function maxInflightProjects(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_INFLIGHT_PROJECTS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_INFLIGHT_PROJECTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_INFLIGHT_PROJECTS;
  return parsed;
}

/** True when a new submission would push the platform past the ceiling. */
export function shouldRefuseSubmission(inflightCount: number, limit: number): boolean {
  return inflightCount >= limit;
}

/**
 * The refusal a user sees. Honest about the depth: it names how much work is
 * actually in front of them, because "try again later" with no number is the
 * kind of vagueness that gets a batch resubmitted immediately.
 */
export function inflightRefusalMessage(inflightCount: number, limit: number): string {
  return (
    `The render queue is full: ${inflightCount} project${inflightCount === 1 ? " is" : "s are"} ` +
    `already rendering or waiting (the platform runs at most ${limit} at once). ` +
    `Nothing was submitted — please try again once some of them finish.`
  );
}
