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
   * Fixed-duration pipeline: clips placed so far, from render_clip_slices —
   * THE SAME TABLE THE TIMELINE READS. That sameness is the point. The
   * 2026-08-07 HAR showed the panel claiming "0 of 300 scenes" while the
   * timeline on the same screen showed 558 clips, because the panel counted
   * selected_clips, which that pipeline only writes at the very end. Two
   * components disagreeing about one project means one of them is lying;
   * deriving both from one table makes the lie structurally impossible.
   */
  slicesFilled?: number | null;
  /** Fixed-duration pipeline: total clip slots the finished timeline will have. */
  slicesExpected?: number | null;
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
    // Deliberately does NOT say why it paused. The old wording claimed "it
    // stopped when the tab was closed" — but this notice is computed from
    // database timestamps, which cannot know whose tab did what, and a second
    // viewer watching someone else drive the work read it as an accusation
    // about a tab they never closed. Say what is known (no recent progress),
    // what is true (this page's polling resumes it), and nothing more.
    pausedNotice:
      "Paused — resuming now. Matching advances while a project page is polling, and this page is; it is picking up where it left off. Nothing was lost.",
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

  // Fixed-duration projects: progress is clips placed, counted from the table
  // the timeline reads, so the two can never disagree. Checked before the
  // scene branch because scene-level remaining is unknowable mid-run for this
  // pipeline (a scene is "done" only when all its slices are).
  const slicesExpected = counts.slicesExpected ?? null;
  const slicesFilled = counts.slicesFilled ?? null;
  if (slicesExpected != null && slicesExpected > 0 && slicesFilled != null && slicesFilled >= 0) {
    const filled = Math.min(slicesFilled, slicesExpected);
    const left = slicesExpected - filled;
    if (left === 0) {
      return {
        ...pausedFields(counts),
        phase: "finishing",
        headline: `Matching footage — ${slicesExpected} of ${slicesExpected} clips`,
        detail: "Finishing up.",
        percent: 100,
        estimate: null,
      };
    }
    const invocations = Math.ceil(left / OBSERVED_SCENES_PER_INVOCATION);
    return {
      ...pausedFields(counts),
      phase: "matching",
      headline: `Matching footage — ${filled} of ${slicesExpected} clips`,
      detail: "Each moment of the video is being paired with a clip.",
      percent: Math.round((filled / slicesExpected) * 100),
      estimate: describeRemainingTime(invocations * OBSERVED_SECONDS_PER_INVOCATION),
    };
  }

  const totalScenes = counts.totalScenes ?? null;
  const remaining = counts.scenesRemaining ?? null;

  // remaining < 0 is a sentinel for "not known", never a count. It must fall
  // through to the known-unknown branch below — rendering it would show "0 of
  // N scenes" (done = total - remaining clamps to garbage), which reads as "no
  // progress at all" and has now sent the operator investigating a healthy
  // project three separate times.
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

/**
 * How many clip slots a finished fixed-duration timeline will have.
 *
 * Moved here from the project page so the page header, the progress panel and
 * the server all count the same way — the divergence this file now guards
 * against started with two components deriving "how done is it" differently.
 *
 * A scene's visual span runs to the NEXT scene's start (not its own end), so
 * gaps between scenes are covered by the earlier scene's clips.
 *
 * MUST MIRROR clip-slices.server.ts's sceneTimelineSpans: spans are tiled by
 * a single monotonic cursor (each scene begins where the previous ended), so
 * OVERLAPPING scene timings shorten the later scene instead of being counted
 * twice. Counting the old way against the fixed builder made this number
 * disagree with the slices the render actually expects.
 */
export function expectedFixedSlicesForScenes(
  scenes: Array<{ start_ts: number | string; end_ts: number | string }>,
  fixedDuration: number,
): number {
  if (!Number.isFinite(fixedDuration) || fixedDuration <= 0) return 0;
  let cursor = 0;
  return scenes.reduce((count, scene, index) => {
    const sceneEnd = Number(scene.end_ts);
    const nextStart = index + 1 < scenes.length ? Number(scenes[index + 1].start_ts) : sceneEnd;
    const visualEnd = Math.max(cursor, nextStart > sceneEnd ? nextStart : sceneEnd);
    const duration = Math.max(0, visualEnd - cursor);
    cursor = visualEnd;
    return count + (duration > 0 ? Math.max(1, Math.ceil(duration / fixedDuration)) : 0);
  }, 0);
}

/**
 * Raw query results → MatchingCounts. Pure, so the choices that produced the
 * wrong panel are individually testable without a database:
 *
 *   - which table progress comes from (slices when the project is
 *     fixed-duration, selected_clips otherwise),
 *   - which timestamps count as progress,
 *   - and that absent data becomes null, never zero.
 */
export function assembleMatchingCounts(input: {
  now: number;
  totalScenes: number | null;
  matchedScenes: number | null;
  corpusBuckets: number | null;
  corpusBucketsFilled: number | null;
  /** Present only for fixed-duration projects. */
  slicesFilled?: number | null;
  slicesExpected?: number | null;
  /** ISO timestamps of the newest write per source; null when none. */
  lastProgressAt: Array<string | null | undefined>;
}): MatchingCounts {
  const buckets = input.corpusBuckets ?? 0;
  const built = input.corpusBucketsFilled ?? 0;

  const progressAt = input.lastProgressAt
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  const sliceMode = input.slicesExpected != null && input.slicesExpected > 0;

  return {
    // Null rather than a huge number when nothing has been written yet — a
    // project that has not started is not a paused one.
    msSinceProgress: progressAt == null ? null : Math.max(0, input.now - progressAt),
    corpusCellsPending: buckets > 0 ? Math.max(0, buckets - built) : null,
    corpusCellsTotal: buckets > 0 ? buckets : null,
    totalScenes: input.totalScenes ?? null,
    // In slice mode, scene-level remaining is unknowable mid-run: a scene is
    // done only when all its slices are, and this input cannot see per-scene
    // slices. Null (unknown) — NOT totalScenes-minus-zero, which is exactly
    // the "0 of 300" the 2026-08-07 HAR captured.
    scenesRemaining:
      sliceMode || input.totalScenes == null || input.matchedScenes == null
        ? null
        : Math.max(0, input.totalScenes - input.matchedScenes),
    slicesFilled: sliceMode ? Math.max(0, input.slicesFilled ?? 0) : null,
    slicesExpected: sliceMode ? input.slicesExpected ?? null : null,
  };
}

/** The compact form for a dashboard row. */
export function shortMatchingLabel(counts: MatchingCounts): string {
  const view = describeMatchingProgress(counts);
  const base = view.percent == null ? view.headline : `${view.headline} (${view.percent}%)`;
  return view.paused ? `Paused — resuming now · ${base}` : base;
}
