/**
 * Server-side narration: the pure logic, testable without a worker.
 *
 * THE CONTRACT (Round B). The app sends a sanitised sentence array; the
 * worker sends back one WAV in storage plus sampleCounts — one integer per
 * sentence, positionally. Everything timing-shaped is reconstructed HERE,
 * in samples, converted to ms only at each boundary via the same
 * sentenceBoundariesToMs the browser path uses — so rounding stays ≤0.5 ms
 * per boundary and non-accumulating, and persistScriptTranscript's validator
 * proves the reconstruction at persist time.
 */

import {
  sentenceBoundariesToMs,
  TTS_SAMPLE_RATE,
  type SampleSpan,
} from "@/lib/tts/wav";

/**
 * How long a project may sit in generating_narration — the WHOLE state, not
 * just the queued slice of it (operator's C3) — before a viewer's poll fails
 * it honestly. Covers every abandonment shape at once: worker down and the
 * job never started; job finished but no tab ever ran the handoff; Redis
 * lost the job entirely. Job c1c1586e sat at 0% for 19 days because nothing
 * owned this question; here it is owned at birth.
 *
 * 6 hours: the worst legitimate case is a 45-minute script (~35 min at the
 * measured single-thread rate) queued behind a full day's worth of other
 * narrations — call it two hours end to end. Triple it and round up.
 * Enforced at read time (the poll), which is where honesty is owed: a
 * project nobody ever looks at again harms nobody by holding its row.
 */
export const NARRATION_STALE_AFTER_HOURS = 6;

/**
 * The measured single-thread rate on the render VPS (EPYC 9354P, CPU-only,
 * intra_op=1): 0.766 compute-seconds per audio-second. Named per the A5
 * discipline — bigger is slower, and the unit is in the name. Used only for
 * the honest ETA line; the real pace is whatever the worker does.
 */
export const SERVER_COMPUTE_SEC_PER_AUDIO_SEC = 0.766;

/**
 * The voices the server worker bakes. Mirrors TTS_VOICES in generate.ts —
 * duplicated here so server functions never import the browser engine
 * module; a test pins the two lists against each other, so drift fails CI
 * instead of failing a narrator.
 */
export const SERVER_TTS_VOICE_IDS = [
  "af_heart",
  "af_bella",
  "am_michael",
  "am_fenrir",
  "bf_emma",
] as const;

/** The deterministic BullMQ job id: polling needs only the project id. */
export function narrationJobId(projectId: string): string {
  return `tts-${projectId}`;
}

/** The deterministic storage path: the handoff needs no remembered state. */
export function narrationStoragePath(projectId: string): string {
  return `${projectId}/narration.wav`;
}

/**
 * sampleCounts -> SampleSpans, on one integer accumulator. Throws on any
 * count that could not have come from a successful job (the worker fails
 * zero-sample sentences; a zero here means the payload is corrupt).
 */
export function buildSampleSpans(sentences: string[], sampleCounts: number[]): SampleSpan[] {
  if (sentences.length !== sampleCounts.length || sentences.length === 0) {
    throw new Error(
      "The narration result did not match the script. Nothing was saved — please try again. " +
        `(internal: ${sentences.length} sentences, ${sampleCounts.length} sample counts)`,
    );
  }
  const spans: SampleSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    const count = sampleCounts[i];
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        "The narration result did not match the script. Nothing was saved — please try again. " +
          `(internal: sentence ${i} sample count ${count})`,
      );
    }
    spans.push({ text: sentences[i], startSample: cursor, endSample: cursor + count });
    cursor += count;
  }
  return spans;
}

/** The timed sentences persistScriptTranscript expects, from spans. */
export function spansToTimedSentences(
  spans: SampleSpan[],
): Array<{ text: string; start_ms: number; end_ms: number }> {
  return sentenceBoundariesToMs(spans);
}

/**
 * THE ARITHMETIC CHECK, enforced in code before anything persists:
 * the uploaded file's bytes must be exactly 44 + totalSamples × 2 — the same
 * identity that (fileBytes − 44) ÷ 48000 == last end_ms ÷ 1000 verifies from
 * the outside. A mismatch means the WAV in storage is not the audio the
 * sample counts describe, and persisting would bake a drift in.
 */
export function assertNarrationArithmetic(wavBytes: number, spans: SampleSpan[]): void {
  const totalSamples = spans.length ? spans[spans.length - 1].endSample : 0;
  if (wavBytes !== 44 + totalSamples * 2) {
    throw new Error(
      "The narration file does not match its transcript timings. Nothing was saved — please try again. " +
        `(internal: ${wavBytes} bytes vs ${totalSamples} samples)`,
    );
  }
}

/** Audio seconds from spans — the number persistScriptTranscript stores. */
export function spansDurationSec(spans: SampleSpan[]): number {
  const totalSamples = spans.length ? spans[spans.length - 1].endSample : 0;
  return totalSamples / TTS_SAMPLE_RATE;
}

/** True when a generating_narration project has outlived the ceiling. */
export function isNarrationStale(stateEnteredAtIso: string, nowMs: number): boolean {
  const entered = Date.parse(stateEnteredAtIso);
  if (!Number.isFinite(entered)) return true; // an unreadable clock cannot hold a state open
  return nowMs - entered > NARRATION_STALE_AFTER_HOURS * 60 * 60 * 1000;
}

/** The worded failure a stale generating_narration project shows. */
export const NARRATION_STALE_MESSAGE =
  "The narration did not finish in a reasonable time, so this project was stopped. " +
  "Nothing else was saved — please create the project again.";

/** The worded failure when the narration service no longer knows the job. */
export const NARRATION_LOST_MESSAGE =
  "The narration service lost track of this job. Nothing else was saved — " +
  "please create the project again.";

/** What the worker's GET /jobs/:id returns, as far as the app reads it. */
export type NarrationWorkerPayload = {
  status: string;
  queue_position?: number | null;
  progress_pct?: number | null;
  sample_counts?: number[];
  audio_seconds?: number;
  wav_bytes?: number;
  sentences?: string[];
  voice?: string;
  full_text?: string;
  error?: string | null;
};

export type NarrationPollVerdict =
  | { action: "moved-on" }
  | { action: "fail"; message: string }
  | { action: "wait"; payload: NarrationWorkerPayload }
  | { action: "complete"; payload: NarrationWorkerPayload };

/**
 * The whole honesty policy of the poll, as one pure decision (Item 3):
 *
 *  - a project no longer in generating_narration needs nothing from us;
 *  - a job the worker no longer knows (Redis loss) fails honestly, the
 *    render poll's "worker no longer knows this job" lesson applied here;
 *  - a worker-reported failure passes its worded reason through — the worker
 *    authors user-readable messages, describeUserFacingError keeps them;
 *  - a completed job completes EVEN IF the state is old — a ready result
 *    beats a staleness verdict;
 *  - past NARRATION_STALE_AFTER_HOURS (C3: the WHOLE state, every
 *    abandonment shape) the project fails with the worded stale message;
 *  - otherwise: keep waiting.
 *
 * Transport errors never reach this function — the caller treats them as
 * transient and retries, because a network blip must not fail a project.
 */
export function narrationPollVerdict(input: {
  projectStatus: string;
  stateEnteredAtIso: string;
  nowMs: number;
  worker: { kind: "ok"; payload: NarrationWorkerPayload } | { kind: "not-found" };
}): NarrationPollVerdict {
  if (input.projectStatus !== "generating_narration") return { action: "moved-on" };
  if (input.worker.kind === "not-found") {
    return { action: "fail", message: NARRATION_LOST_MESSAGE };
  }
  const payload = input.worker.payload;
  if (payload.status === "failed") {
    return {
      action: "fail",
      message: payload.error?.trim() || "The narration failed. Please try again.",
    };
  }
  if (payload.status === "completed") return { action: "complete", payload };
  if (isNarrationStale(input.stateEnteredAtIso, input.nowMs)) {
    return { action: "fail", message: NARRATION_STALE_MESSAGE };
  }
  return { action: "wait", payload };
}

/**
 * What the progress card says. Plain sentences from the poll payload; the
 * ETA line is labelled an estimate and derives from the measured rate.
 */
export function describeNarrationStage(poll: {
  status: string;
  queue_position?: number | null;
  progress_pct?: number | null;
  estimatedAudioSec?: number | null;
}): string {
  if (poll.status === "queued") {
    const position =
      typeof poll.queue_position === "number" && poll.queue_position > 0
        ? ` — position ${poll.queue_position} in line`
        : "";
    return `Waiting for the narration server${position}…`;
  }
  if (poll.status === "processing") {
    const pct =
      typeof poll.progress_pct === "number" && poll.progress_pct > 0
        ? ` — ${Math.round(poll.progress_pct)}%`
        : "";
    const eta =
      typeof poll.estimatedAudioSec === "number" && poll.estimatedAudioSec > 0
        ? ` (about ${Math.max(1, Math.round((poll.estimatedAudioSec * SERVER_COMPUTE_SEC_PER_AUDIO_SEC) / 60))} min total, estimated)`
        : "";
    return `Generating narration on the server${pct}${eta}`;
  }
  return "Preparing narration…";
}
