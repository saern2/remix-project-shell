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
