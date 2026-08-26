import { describe, expect, it } from "vitest";
import {
  assertNarrationArithmetic,
  buildSampleSpans,
  describeNarrationStage,
  isNarrationStale,
  narrationJobId,
  NARRATION_LOST_MESSAGE,
  NARRATION_STALE_AFTER_HOURS,
  NARRATION_STALE_MESSAGE,
  narrationPollVerdict,
  narrationStoragePath,
  SERVER_COMPUTE_SEC_PER_AUDIO_SEC,
  SERVER_TTS_VOICE_IDS,
  spansDurationSec,
  spansToTimedSentences,
} from "@/lib/tts/narration";
import { TTS_VOICES } from "@/lib/tts/generate";
import { validateScriptSentences } from "@/lib/pipeline.functions";

const HOUR_MS = 60 * 60 * 1000;

describe("reconstruction from sample counts — the timing contract", () => {
  it("builds contiguous spans on one integer accumulator", () => {
    const spans = buildSampleSpans(["A.", "B.", "C."], [24_000, 12_001, 35_999]);
    expect(spans).toEqual([
      { text: "A.", startSample: 0, endSample: 24_000 },
      { text: "B.", startSample: 24_000, endSample: 36_001 },
      { text: "C.", startSample: 36_001, endSample: 72_000 },
    ]);
    expect(spansDurationSec(spans)).toBe(3);
  });

  it("the reconstruction passes the persist-time validator — the same proof the browser path gets", () => {
    // Awkward counts on purpose: none divisible by 24, so every boundary
    // rounds. Contiguity must survive because consecutive sentences share
    // the same boundary sample and therefore round identically.
    const counts = [24_001, 11_999, 36_007, 1_003];
    const spans = buildSampleSpans(["One.", "Two.", "Three.", "Four."], counts);
    const timed = spansToTimedSentences(spans);
    const durationSec = spansDurationSec(spans);
    expect(validateScriptSentences(timed, durationSec)).toBeNull();
  });

  it("boundary rounding is from the accumulator: at most 0.5 ms, never accumulating", () => {
    const counts = Array.from({ length: 500 }, () => 24_001); // 1000.041ms each
    const spans = buildSampleSpans(counts.map((_, i) => `S${i}.`), counts);
    const timed = spansToTimedSentences(spans);
    const last = timed[timed.length - 1];
    const exactMs = (500 * 24_001) / 24;
    // Summing per-sentence roundings would drift ~21ms over 500 sentences;
    // rounding from the accumulator keeps the final boundary within 0.5ms.
    expect(Math.abs(last.end_ms - exactMs)).toBeLessThanOrEqual(0.5);
  });

  it("refuses mismatched or corrupt counts loudly", () => {
    expect(() => buildSampleSpans(["A."], [100, 200])).toThrow(/did not match/);
    expect(() => buildSampleSpans(["A.", "B."], [100, 0])).toThrow(/sample count 0/);
    expect(() => buildSampleSpans(["A."], [100.5])).toThrow(/sample count/);
    expect(() => buildSampleSpans([], [])).toThrow(/did not match/);
  });
});

describe("the arithmetic gate — (bytes − 44) ÷ 48000 == last end_ms ÷ 1000", () => {
  it("passes exactly when the file is the audio the counts describe", () => {
    const spans = buildSampleSpans(["A.", "B."], [24_000, 24_000]);
    expect(() => assertNarrationArithmetic(44 + 48_000 * 2, spans)).not.toThrow();
  });

  it("refuses a file that is even one byte off", () => {
    const spans = buildSampleSpans(["A."], [24_000]);
    expect(() => assertNarrationArithmetic(44 + 48_000 + 1, spans)).toThrow(
      /does not match its transcript timings/,
    );
    expect(() => assertNarrationArithmetic(44 + 48_000 - 1, spans)).toThrow();
  });
});

describe("the staleness ceiling (C3: the whole state, not just queued)", () => {
  it("pins the named constant", () => {
    expect(NARRATION_STALE_AFTER_HOURS).toBe(6);
  });

  it("is fresh inside the ceiling, stale past it, stale on an unreadable clock", () => {
    const entered = new Date("2026-08-25T12:00:00Z").toISOString();
    const enteredMs = Date.parse(entered);
    expect(isNarrationStale(entered, enteredMs + 5 * HOUR_MS)).toBe(false);
    expect(isNarrationStale(entered, enteredMs + 6 * HOUR_MS + 1)).toBe(true);
    expect(isNarrationStale("not a date", enteredMs)).toBe(true);
  });
});

describe("narrationPollVerdict — the whole honesty policy as one decision (Item 3)", () => {
  const entered = new Date("2026-08-25T12:00:00Z").toISOString();
  const fresh = Date.parse(entered) + HOUR_MS;
  const stale = Date.parse(entered) + 7 * HOUR_MS;

  it("a project no longer in generating_narration needs nothing", () => {
    expect(
      narrationPollVerdict({
        projectStatus: "generating_scenes",
        stateEnteredAtIso: entered,
        nowMs: fresh,
        worker: { kind: "not-found" },
      }),
    ).toEqual({ action: "moved-on" });
  });

  it("worker death / Redis loss: a job the worker no longer knows fails honestly", () => {
    const verdict = narrationPollVerdict({
      projectStatus: "generating_narration",
      stateEnteredAtIso: entered,
      nowMs: fresh,
      worker: { kind: "not-found" },
    });
    expect(verdict).toEqual({ action: "fail", message: NARRATION_LOST_MESSAGE });
    expect(NARRATION_LOST_MESSAGE).toContain("lost track");
  });

  it("a worker-reported failure passes its worded reason through", () => {
    const verdict = narrationPollVerdict({
      projectStatus: "generating_narration",
      stateEnteredAtIso: entered,
      nowMs: fresh,
      worker: {
        kind: "ok",
        payload: {
          status: "failed",
          error: 'Sentence 7 is too long to narrate in one breath ("…"). Please split it…',
        },
      },
    });
    expect(verdict.action).toBe("fail");
    if (verdict.action === "fail") expect(verdict.message).toContain("Sentence 7");
  });

  it("model-load failure shape: stuck queued past the ceiling fails with the stale message", () => {
    // A worker whose model will not load exits and restarts forever; jobs sit
    // queued. The ceiling is how that becomes a failed project.
    const verdict = narrationPollVerdict({
      projectStatus: "generating_narration",
      stateEnteredAtIso: entered,
      nowMs: stale,
      worker: { kind: "ok", payload: { status: "queued", queue_position: 1 } },
    });
    expect(verdict).toEqual({ action: "fail", message: NARRATION_STALE_MESSAGE });
  });

  it("abandoned-after-completion shape: a ready result COMPLETES even past the ceiling", () => {
    // The C3 gap this closes ran the other way too: a finished narration
    // whose tab never returned must hand off on the next visit, not be
    // declared stale with the WAV sitting ready in storage.
    const verdict = narrationPollVerdict({
      projectStatus: "generating_narration",
      stateEnteredAtIso: entered,
      nowMs: stale,
      worker: { kind: "ok", payload: { status: "completed", sample_counts: [1] } },
    });
    expect(verdict.action).toBe("complete");
  });

  it("otherwise: wait, carrying the worker payload for the stage line", () => {
    const verdict = narrationPollVerdict({
      projectStatus: "generating_narration",
      stateEnteredAtIso: entered,
      nowMs: fresh,
      worker: { kind: "ok", payload: { status: "processing", progress_pct: 40 } },
    });
    expect(verdict.action).toBe("wait");
  });
});

describe("stage descriptions — plain sentences, estimate labelled", () => {
  it("queued names the position", () => {
    expect(describeNarrationStage({ status: "queued", queue_position: 3 })).toContain(
      "position 3 in line",
    );
  });

  it("processing names percent and a minutes estimate from the measured rate", () => {
    const line = describeNarrationStage({
      status: "processing",
      progress_pct: 40,
      estimatedAudioSec: 2700,
    });
    expect(line).toContain("40%");
    expect(line).toContain("estimated");
    // 2700s of audio at the measured 0.766 -> ~34.5 min, rounded
    expect(line).toContain(`${Math.round((2700 * SERVER_COMPUTE_SEC_PER_AUDIO_SEC) / 60)} min`);
  });
});

describe("contract constants", () => {
  it("job id and storage path are deterministic from the project id alone", () => {
    // Tab-close survival depends on this: resuming needs NOTHING the closed
    // tab knew.
    expect(narrationJobId("p-1")).toBe("tts-p-1");
    expect(narrationStoragePath("p-1")).toBe("p-1/narration.wav");
  });

  it("the server voice list mirrors TTS_VOICES exactly — drift fails CI, not a narrator", () => {
    expect([...SERVER_TTS_VOICE_IDS]).toEqual(TTS_VOICES.map((v) => v.id));
  });

  it("the measured server rate is named in compute-per-audio units (A5: never bare rtf)", () => {
    expect(SERVER_COMPUTE_SEC_PER_AUDIO_SEC).toBe(0.766);
  });
});
