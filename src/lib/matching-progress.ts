/**
 * What matching is doing, in words a person can act on.
 *
 * WHY THIS EXISTS. On a 286-scene project the corpus build ran from 17:31:51 to
 * 17:35:23 — three and a half minutes during which the UI showed a status pill
 * and "Updated less than a minute ago", and nothing else. `scenesProcessed` is 0
 * for that whole phase by design, so there was no movement to see. The person
 * who built the system read it as broken. A user reads it as broken and closes
 * the tab, which genuinely does stall the project.
 *
 * Every number needed was already in the poll response. This turns those numbers
 * into a phase, a count, a bar and an estimate.
 *
 * The estimate is deliberately rough and labelled as such. Rates vary with
 * provider latency, and a wrong-but-labelled estimate beats a blank screen —
 * what a waiting person needs first is evidence that something is happening.
 */

/** Cells built per invocation, measured across production runs. */
export const OBSERVED_CELLS_PER_INVOCATION = 6;
/** Scenes assigned per invocation, measured across production runs. */
export const OBSERVED_SCENES_PER_INVOCATION = 15;
/** Seconds between polls, near enough for an estimate. */
export const OBSERVED_SECONDS_PER_INVOCATION = 15;

/**
 * How long a project can go without progressing before it is shown as paused.
 *
 * Matching only advances while a tab polls — that is the design, and it is
 * correct: closing the tab pauses the work, and reopening it resumes exactly
 * where it stopped. The problem is that a paused project and a broken one look
 * identical, which cost the operator two separate investigations.
 *
 * 90 seconds is comfortably longer than the slowest observed invocation
 * (19,022ms) plus a poll gap, so a project that is merely working never trips
 * it, and short enough that someone returning to a tab sees the explanation
 * rather than a frozen bar.
 */
export const PAUSED_AFTER_MS = 90_000;

export type MatchingCounts = {
  /** Corpus cells still to search. Null when the corpus phase is over or unknown. */
  corpusCellsPending?: number | null;
  /** Corpus cells searched so far, for the denominator. */
  corpusCellsTotal?: number | null;
  /** Scenes in the project. */
  totalScenes?: number | null;
  /** Scenes still to assign. */
  scenesRemaining?: number | null;
  /**
   * Milliseconds since this project last progressed, or null when unknown.
   * Drives the paused notice only — it never changes the phase or the numbers.
   */
  msSinceProgress?: number | null;
};

export type MatchingPhase = "preparing" | "matching" | "finishing";

export type MatchingProgressView = {
  phase: MatchingPhase;
  /**
   * True when nothing has advanced for a while. The work is not lost and no
   * action is needed — polling resumes it — so this is a note beside the
   * progress, never a replacement for it.
   */
  paused: boolean;
  /** The paused explanation, or null. */
  pausedNotice: string | null;
  /** One line, already written for a person. */
  headline: string;
  /** Second line: why an empty timeline is expected, or what happens next. */
  detail: string;
  /** 0-100, or null when there is genuinely nothing to measure. */
  percent: number | null;
  /** "about 2 minutes left", or null when it cannot be estimated. */
  estimate: string | null;
};

/** "1 search" / "74 searches" — the sibilant endings need -es, not -s. */
function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  const suffix = /(s|x|z|ch|sh)$/.test(word) ? "es" : "s";
  return `${n} ${word}${suffix}`;
}

/**
 * Whether to show the paused note, and what it says.
 *
 * "Resuming now" is literally true: this page is polling, and that poll is what
 * advances the work. The notice exists to say the project is fine, not to ask
 * for anything.
 */
function pausedFields(counts: MatchingCounts): { paused: boolean; pausedNotice: string | null } {
  const idle = counts.msSinceProgress;
  if (idle == null || !Number.isFinite(idle) || idle < PAUSED_AFTER_MS) {
    return { paused: false, pausedNotice: null };
  }
  return {
    paused: true,
    pausedNotice:
      "Paused — resuming now. Matching only runs while this page is open, so it stopped when the tab was closed. It is picking up where it left off; nothing was lost.",
  };
}

/** Rounds an estimate to something a person would say out loud. */
export function describeRemainingTime(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 45) return "about a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return "about a minute left";
  return `about ${minutes} minutes left`;
}

/**
 * Turns raw counts into something to render.
 *
 * The corpus phase is reported whenever cells are still pending, because that is
 * the phase with no other visible signal. Once it is done the view switches to
 * scenes, which is what the timeline will fill with.
 */
export function describeMatchingProgress(counts: MatchingCounts): MatchingProgressView {
  const cellsPending = counts.corpusCellsPending ?? null;
  const cellsTotal = counts.corpusCellsTotal ?? null;

  if (cellsPending != null && cellsPending > 0) {
    const total = cellsTotal != null && cellsTotal > 0 ? cellsTotal : cellsPending;
    const done = Math.max(0, total - cellsPending);
    const invocations = Math.ceil(cellsPending / OBSERVED_CELLS_PER_INVOCATION);
    return {
      ...pausedFields(counts),
      phase: "preparing",
      headline: `Preparing footage library — ${plural(cellsPending, "search")} remaining of ${total}`,
      // Says the quiet part: an empty timeline right now is expected, not broken.
      detail: "Clips are chosen in the next step, so the timeline stays empty until then.",
      percent: total > 0 ? Math.round((done / total) * 100) : null,
      estimate: describeRemainingTime(invocations * OBSERVED_SECONDS_PER_INVOCATION),
    };
  }

  const totalScenes = counts.totalScenes ?? null;
  const remaining = counts.scenesRemaining ?? null;

  if (totalScenes != null && totalScenes > 0 && remaining != null && remaining >= 0) {
    const done = Math.max(0, totalScenes - remaining);
    if (remaining === 0) {
      return {
        ...pausedFields(counts),
        phase: "finishing",
        headline: `Matching footage — ${totalScenes} of ${totalScenes} scenes`,
        detail: "Finishing up.",
        percent: 100,
        estimate: null,
      };
    }
    const invocations = Math.ceil(remaining / OBSERVED_SCENES_PER_INVOCATION);
    return {
      ...pausedFields(counts),
      phase: "matching",
      headline: `Matching footage — ${done} of ${totalScenes} scenes`,
      detail: "Each scene is being paired with a clip.",
      percent: Math.round((done / totalScenes) * 100),
      estimate: describeRemainingTime(invocations * OBSERVED_SECONDS_PER_INVOCATION),
    };
  }

  // Known-unknown rather than a fake zero: a bar sitting at 0% reads as stuck,
  // which is the exact impression this whole module exists to prevent.
  return {
    ...pausedFields(counts),
    phase: "preparing",
    headline: "Preparing footage library",
    detail: "Clips are chosen in the next step, so the timeline stays empty until then.",
    percent: null,
    estimate: null,
  };
}

/** The compact form for a dashboard row. */
export function shortMatchingLabel(counts: MatchingCounts): string {
  const view = describeMatchingProgress(counts);
  const base = view.percent == null ? view.headline : `${view.headline} (${view.percent}%)`;
  return view.paused ? `Paused — resuming now · ${base}` : base;
}
