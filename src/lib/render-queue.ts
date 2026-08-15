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
    position === 1 ? "Next in line to start rendering" : `Position ${position} in the render queue`;

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
 * case. Four different things happen in that window and the worker now reports
 * which one:
 *
 *   waiting    — every chunk is done but both stitch slots are busy with other
 *                projects. The one thing worth knowing is how many are ahead.
 *   combining  — the concat/mux is actually running. Says how many segments,
 *                because "Combining 30 segments" explains a minute of work the
 *                way "Combining…" does not.
 *   finalizing — ffmpeg's +faststart pass rewrites the whole file so playback
 *                can start before it finishes downloading (~89s on 1.2 GB).
 *                Progress genuinely holds still here; named so it reads as a
 *                step, not a hang.
 *   uploading  — the finished video is leaving the machine. With byte counts
 *                when known: a frozen "Uploading…" over 1.2 GB reads as stuck,
 *                "640 MB of 1.2 GB" reads as what it is.
 */
export function describeStitchPhase(
  state: string | null | undefined,
  stitchesAhead: number | null | undefined,
  detail?: {
    chunksTotal?: number | null;
    uploadSentBytes?: number | null;
    uploadTotalBytes?: number | null;
  },
): string | null {
  switch (state) {
    case "waiting":
      return stitchesAhead != null && stitchesAhead > 0
        ? `Waiting to combine — ${stitchesAhead} ahead in queue.`
        : "Waiting to combine segments…";
    case "combining": {
      const segments = detail?.chunksTotal;
      return segments != null && segments > 0
        ? `Combining ${segments} segment${segments === 1 ? "" : "s"}…`
        : "Combining segments…";
    }
    case "finalizing":
      return "Finalizing for playback…";
    case "uploading": {
      const total = detail?.uploadTotalBytes;
      const sent = detail?.uploadSentBytes;
      if (total != null && total > 0 && sent != null && sent >= 0) {
        return `Uploading the finished video — ${describeBytes(Math.min(sent, total))} of ${describeBytes(total)}…`;
      }
      return "Uploading the finished video…";
    }
    default:
      return null;
  }
}

/**
 * "640 MB", "1.2 GB". Whole megabytes below a gigabyte, one decimal above —
 * the same coarseness rule as describeWait: more precision would invite the
 * user to time it. Decimal units (1 GB = 10⁹ bytes), because that is how the
 * same file is described everywhere else — the 1,207,708,054-byte output that
 * prompted this is "1.2 GB" in every log line and conversation about it.
 */
export function describeBytes(bytes: number): string {
  const GB = 1_000_000_000;
  if (bytes >= GB) return `${(Math.round((bytes / GB) * 10) / 10).toString()} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
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
  queuePosition?: number | null,
): string | null {
  // ── Held at an admission gate ─────────────────────────────────────────────
  // MEASURED on 2026-08-13, project a1a7c67e: 318 seconds — 80% of the
  // render's total wall time — displayed as "waiting" with 0 segments ahead
  // and 0%, because a gated chunk is moved to DELAYED and disappears from
  // every queue the status poll inspects. Zero ahead reads as "nothing is in
  // the way", so the only honest reading of that screen was "stuck". The
  // render then finished in 80 seconds.
  if (chunkState === "waiting-slot") {
    const position = typeof queuePosition === "number" && queuePosition > 0 ? queuePosition : null;
    // describeWait already says "about N minutes"; adding another "about" here
    // produced "about about 40 minutes".
    const wait = describeWait(estimateSeconds);
    const suffix = wait ? ` — ${wait} (estimate)` : "";
    if (position == null) {
      return `Waiting for a render slot — your place is held and rendering starts automatically${suffix}.`;
    }
    return `Waiting for a render slot — ${ordinal(position)} in the queue${suffix}.`;
  }

  if (chunkState === "waiting-memory") {
    // Deliberately no number: the wait depends on other projects releasing
    // memory, and any figure here would be invented.
    return "Waiting for memory on the render machine — your place is held and rendering starts automatically.";
  }

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

/** 1st, 2nd, 3rd… A bare "position 3" reads like an error code. */
function ordinal(value: number): string {
  const rem100 = value % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
