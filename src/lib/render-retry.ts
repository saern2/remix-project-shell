/**
 * What "Retry" should actually retry.
 *
 * MEASURED, 2026-08-09: a project failed at 34/36 rendered segments. Its
 * failure message said "Nothing was lost from your project" — and then Retry
 * threw the ready state away anyway: failed → draft → generating_scenes →
 * matching_footage (5-6 minutes) → ready → rendering. The timeline it
 * rebuilt was the one it already had.
 *
 * A RENDER failure leaves a complete timeline behind; the render is the only
 * thing that needs to run again. A MATCHING (or scene-generation) failure has
 * no timeline to reuse, so only that class re-runs the pipeline.
 */

export type RetryMode = "render-only" | "full-pipeline";

/** Render-job statuses whose failure is the RENDER's, not the timeline's. */
const RENDER_FAILURE_STATUSES = new Set(["failed", "cancelled"]);

/**
 * Decides what pressing Retry re-runs.
 *
 * Render-only requires BOTH signals:
 *  - the latest render job failed (or was cancelled): the pipeline had
 *    finished and handed a complete timeline to the renderer;
 *  - the timeline still looks complete from the client: a project whose
 *    matching failed AFTER an old render failure has a stale render job and
 *    must take the full pipeline, not resubmit a half-built timeline.
 *
 * Everything else — no render job at all, a completed one, an unknown state —
 * re-runs the pipeline, exactly as Retry always did.
 */
export function retryModeForProject({
  latestRenderJobStatus,
  timelineComplete,
}: {
  latestRenderJobStatus: string | null | undefined;
  timelineComplete: boolean;
}): RetryMode {
  if (!timelineComplete) return "full-pipeline";
  if (latestRenderJobStatus && RENDER_FAILURE_STATUSES.has(latestRenderJobStatus)) {
    return "render-only";
  }
  return "full-pipeline";
}
