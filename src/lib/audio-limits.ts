/**
 * The largest project the pipeline is known to handle.
 *
 * WHY A CEILING EXISTS. Everything measured in this system was measured at 145
 * scenes. A 524-scene project found the first thing that breaks; it will not be
 * the last. The honest position is a limit users are told about at upload rather
 * than one they discover after paying for a transcription.
 *
 * WHERE 45 MINUTES COMES FROM. Scenes run about 6 seconds each, so 45 minutes is
 * roughly 450 scenes — comfortably inside the two hard walls below and about
 * three times the largest run with clean production evidence.
 *
 *   - PostgREST returns at most 1,000 rows per request. Several matching reads
 *     are unbounded selects over scenes and slices; the slice table is the first
 *     to cross it, at roughly 500-700 scenes with short fixed-duration clips.
 *     Past that a read silently returns a first page.
 *   - The corpus is read WHOLE on every invocation that builds it. Buckets are
 *     capped at 40 and candidates at 120 per bucket, so the corpus itself does
 *     not grow with scene count — but the assignment pass over it does.
 *
 * Raising this is a measurement exercise, not a config change: run a project at
 * the new size and check the slice count against the 1,000-row page before
 * moving the number.
 */

/** Maximum narration length accepted at upload, in seconds. */
export const MAX_AUDIO_DURATION_SECONDS = 45 * 60;

/** Roughly how many scenes an audio of this length produces, at ~6s per scene. */
export const APPROXIMATE_SECONDS_PER_SCENE = 6;

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest}s`;
}

export type AudioLengthVerdict = { ok: true } | { ok: false; message: string };

/**
 * Checks a measured duration against the ceiling.
 *
 * An unknown duration passes. Browsers cannot always decode metadata for every
 * container, and refusing an upload because we failed to measure it would block
 * work we can very likely do — the pipeline's own limits still apply later.
 */
export function checkAudioLength(durationSeconds: number | null | undefined): AudioLengthVerdict {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ok: true };
  }
  if (durationSeconds <= MAX_AUDIO_DURATION_SECONDS) return { ok: true };

  // Says the limit, what they gave us, and what to do — a bare "too long" would
  // leave someone guessing how much to cut.
  return {
    ok: false,
    message: `This audio is ${formatDuration(durationSeconds)}. The longest we can process is ${formatDuration(
      MAX_AUDIO_DURATION_SECONDS,
    )} — about ${Math.round(MAX_AUDIO_DURATION_SECONDS / APPROXIMATE_SECONDS_PER_SCENE)} scenes. Split it into shorter parts and create a project for each.`,
  };
}

/** Reads a duration from an audio file in the browser, or null if it cannot. */
export function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.addEventListener("loadedmetadata", () =>
      done(Number.isFinite(audio.duration) ? audio.duration : null),
    );
    audio.addEventListener("error", () => done(null));
    // Never block the upload on a container the browser will not decode.
    setTimeout(() => done(null), 5000);
    audio.src = url;
  });
}
