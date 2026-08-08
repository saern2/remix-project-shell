/**
 * What a project waiting for a render slot is told.
 *
 * Pure and separate from the poll handler so the wording can be tested without
 * a worker, a database or a network round trip — the same reason
 * matching-progress.ts is its own module.
 *
 * The rule this file exists to hold: an estimate is always labelled as one. The
 * number comes from a median chunk time measured on the machine and a chunk
 * count that stands in for the projects ahead, so it is right in magnitude and
 * wrong in detail. Presenting it as a countdown would be a promise; presenting
 * it as "about 40 minutes" is information.
 */

/** Longest wait we quote precisely. Past this, minutes stop being meaningful. */
const HOUR_SECONDS = 3600;

/**
 * "about 40 minutes", "about 2 hours", "under a minute".
 *
 * Rounded coarsely on purpose: "about 37 minutes" implies a precision the
 * estimate does not have, and invites the user to time it.
 */
export function describeWait(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return "under a minute";

  if (seconds < HOUR_SECONDS) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    // Round to 5 minutes past a quarter hour; below that, single minutes still
    // read as informative rather than falsely precise.
    const rounded = minutes > 15 ? Math.round(minutes / 5) * 5 : minutes;
    return `about ${rounded} minute${rounded === 1 ? "" : "s"}`;
  }

  const hours = seconds / HOUR_SECONDS;
  const halves = Math.round(hours * 2) / 2;
  return `about ${halves} hour${halves === 1 ? "" : "s"}`;
}

/**
 * The line shown to a project that is waiting for a slot.
 *
 * Returns null when the project is not waiting, so the caller can treat "no
 * notice" and "not queued" as the same thing.
 */
export function describeQueuePosition(
  position: number | null | undefined,
  estimateSeconds: number | null | undefined,
): string | null {
  if (position == null || !Number.isFinite(position) || position < 1) return null;

  const place =
    position === 1
      ? "Next in line to start rendering"
      : `Position ${position} in the render queue`;

  const wait = describeWait(estimateSeconds);
  // No measurement yet on a fresh worker. Saying where they are without
  // guessing when beats inventing a number.
  if (!wait) return `${place}. Other projects are rendering ahead of this one.`;

  return `${place} — ${wait} (estimate).`;
}

/**
 * Why a project that has finished every chunk still has no video.
 *
 * The window between the last chunk and the delivered file used to show
 * "51 of 51 segments rendered" and nothing else — 15m10s in the worst observed
 * case. Three different things happen in that window and the worker now reports
 * which one:
 *
 *   waiting   — every chunk is done but both stitch slots are busy with other
 *               projects. The one thing worth knowing is how many are ahead.
 *   combining — the concat/mux is actually running.
 *   uploading — the finished video is leaving the machine.
 */
export function describeStitchPhase(
  state: string | null | undefined,
  stitchesAhead: number | null | undefined,
): string | null {
  switch (state) {
    case "waiting":
      return stitchesAhead != null && stitchesAhead > 0
        ? `Waiting to combine — ${stitchesAhead} ahead in queue.`
        : "Waiting to combine segments…";
    case "combining":
      return "Combining segments…";
    case "uploading":
      return "Uploading the finished video…";
    default:
      return null;
  }
}

/**
 * Why a project that is "rendering" has produced nothing yet.
 *
 * MEASURED: a 49-chunk project showed "Rendering, 0 of 49 segments" for 36.5
 * minutes because all four chunk workers were busy with older projects. It had
 * an admission slot; it had no worker. The operator read it as a stall and
 * closed the tab, and the project went on to render all 49 chunks in 24
 * minutes.
 *
 * "Admitted" and "encoding" are different states and only one of them means
 * work is happening. This is the third queue in this system to look like a
 * hang, so the rule is now explicit: every waiting state says it is waiting.
 *
 * Returns null once anything has completed — from then on the segment counter
 * is moving and speaks for itself.
 */
export function describeChunkPhase(
  chunkState: string | null | undefined,
  chunksAhead: number | null | undefined,
  estimateSeconds?: number | null,
): string | null {
  if (chunkState !== "waiting") return null;

  const ahead = typeof chunksAhead === "number" && chunksAhead > 0 ? chunksAhead : null;
  if (ahead == null) {
    // Between states, or the queue view was unavailable. Still says the true
    // thing — it is waiting, not stuck.
    return "Waiting for a render slot — starting shortly.";
  }

  const wait = describeWait(estimateSeconds);
  const suffix = wait ? ` — ${wait} (estimate)` : "";
  return `Waiting for a render slot — ${ahead} segment${ahead === 1 ? "" : "s"} ahead of you${suffix}.`;
}
