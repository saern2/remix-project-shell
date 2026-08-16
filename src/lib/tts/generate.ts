/**
 * The generation loop: script in, sample-exact WAV + sentence timings out.
 *
 * Everything here runs in the user's browser and touches NOTHING remote
 * except the Hugging Face CDN (the model, cached by the browser after the
 * first load). No project row exists while this runs: an interrupted tab
 * leaves nothing anywhere — not storage, not the database, not even an
 * orphaned 'uploading' project for the cleanup to own. Persistence begins
 * only after the duration gate has passed.
 *
 * kokoro-js (and through it ~1 MB of transformers.js) is imported lazily
 * inside loadEngine, so the ordinary app bundle is byte-identical with this
 * feature in the tree.
 */

import { MAX_AUDIO_DURATION_SECONDS } from "@/lib/audio-limits";
import { ORT_WASM_BASE_URL, configureModelHost, seedVoiceCache } from "@/lib/tts/model-host";
import {
  TTS_SAMPLE_RATE,
  assertSampleExact,
  buildWavBlob,
  floatToInt16,
  sentenceBoundariesToMs,
  type SampleSpan,
} from "@/lib/tts/wav";

/** The model everything was decided around. */
export const TTS_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * Preset voices — English only, no cloning. Ids are Kokoro voice names;
 * labels are what the picker shows.
 */
export const TTS_VOICES: Array<{ id: string; label: string }> = [
  { id: "af_heart", label: "Heart — American female, warm" },
  { id: "af_bella", label: "Bella — American female, bright" },
  { id: "am_michael", label: "Michael — American male, steady" },
  { id: "am_fenrir", label: "Fenrir — American male, deep" },
  { id: "bf_emma", label: "Emma — British female, calm" },
];

export type TtsProgress =
  | { stage: "model"; file: string; loadedBytes: number; totalBytes: number }
  | {
      stage: "generating";
      sentence: number;
      totalSentences: number;
      secondsGenerated: number;
      /**
       * Live per-machine estimate, revised at every sentence boundary once
       * calibration has happened; null before that. A frozen two-sentence
       * sample would mislead wherever early sentences are atypical.
       */
      estimatedRemainingComputeSec: number | null;
    }
  | { stage: "assembling" };

/**
 * NAMING IS LOAD-BEARING HERE. Every measurement this project holds — 3.38
 * and ~10 (browsers, 2026-08-16), 0.766 and 0.265 (VPS) — is COMPUTE seconds
 * per AUDIO second: bigger is slower. The Preview line displays the inverse
 * (bigger is faster). One codebase using one name for both meanings is the
 * error class that has cost this project days, so the bare "realtime factor"
 * abbreviation is banned by test; both directions are spelled out everywhere.
 */
export type SpeechEstimate = {
  /** The held-measurement direction: 3.38 means an hour of audio costs 3.38 hours. */
  computeSecPerAudioSec: number;
  /** The display direction (the Preview ratio): 0.3 means 0.3× realtime. */
  audioSecPerComputeSec: number;
  estimatedTotalAudioSec: number;
  estimatedTotalComputeSec: number;
  estimatedRemainingComputeSec: number;
  calibratedOnSentences: number;
};

/**
 * When the estimate is presented for a decision. Sentence boundaries only —
 * an in-flight engine.generate() cannot be interrupted, so on a very slow
 * machine one long sentence can overshoot the wall-clock target: the window
 * is a FLOOR, not a ceiling. Two sentences or 25 s of wall clock, whichever
 * comes first: a fast machine reaches the verdict in seconds, a 0.1×-realtime
 * machine within roughly half a minute.
 */
export const CALIBRATION_WINDOW = { minSentences: 2, maxWallMs: 25_000 };

/**
 * Above this estimated total compute, the dialog leads with "shorten the
 * script or use Upload narration" rather than a neutral continue prompt.
 * 45 minutes of real-time compute — the same number as the platform's audio
 * ceiling, on the reasoning that nobody should wait longer for speech than
 * the longest video the platform will make of it.
 */
export const ESTIMATE_SANITY_COMPUTE_SEC = 45 * 60;

/** The pure arithmetic, shared by the calibration verdict and every revision. */
export function estimateFromProgress(sample: {
  charsDone: number;
  charsTotal: number;
  audioSecDone: number;
  computeSecDone: number;
  sentencesDone: number;
}): SpeechEstimate {
  const audioSecPerChar = sample.charsDone > 0 ? sample.audioSecDone / sample.charsDone : 0;
  const computeSecPerAudioSec =
    sample.audioSecDone > 0 ? sample.computeSecDone / sample.audioSecDone : 0;
  const estimatedTotalAudioSec = sample.charsTotal * audioSecPerChar;
  const estimatedTotalComputeSec = estimatedTotalAudioSec * computeSecPerAudioSec;
  return {
    computeSecPerAudioSec,
    audioSecPerComputeSec: computeSecPerAudioSec > 0 ? 1 / computeSecPerAudioSec : 0,
    estimatedTotalAudioSec,
    estimatedTotalComputeSec,
    estimatedRemainingComputeSec: Math.max(0, estimatedTotalComputeSec - sample.computeSecDone),
    calibratedOnSentences: sample.sentencesDone,
  };
}

/**
 * The dtypes under evaluation. fp32 is the shipped default; fp16 and q8 exist
 * so the operator can HEAR them before one is chosen — fp16 on WebGPU has a
 * history of correctness bugs with this model (garbled output, not subtle
 * quality loss), which makes listening a requirement, not a preference.
 */
export type TtsDtype = "fp32" | "fp16" | "q8";

const DTYPE_VALUES: TtsDtype[] = ["fp32", "fp16", "q8"];

/**
 * The dtype comparison harness's only entry point: `?dtype=fp16` on the
 * new-project page. Anything unrecognised is fp32 — the shipped decision —
 * so a mistyped param can never silently ship a quantised model.
 */
export function parseDtypeParam(search: string): TtsDtype {
  const value = new URLSearchParams(search).get("dtype");
  return DTYPE_VALUES.includes(value as TtsDtype) ? (value as TtsDtype) : "fp32";
}

/**
 * What the Preview voice button speaks: fixed, so every dtype and voice is
 * compared on identical input. Written to exercise what narration actually
 * contains — numbers, a proper noun, a question, sibilants and plosives —
 * in ~15 seconds of speech.
 */
export const PREVIEW_TEXT =
  "In 1969, three astronauts crossed two hundred and forty thousand miles of empty space. " +
  "What were they thinking, strapped above six million pounds of fuel? " +
  "Stephanie says the answer is simple: they trusted the process, checked the systems twice, and kept talking.";

export type GeneratedSpeech = {
  wavBlob: Blob;
  sentences: Array<{ text: string; start_ms: number; end_ms: number }>;
  durationSec: number;
  totalSamples: number;
};

/** Thrown when the measured audio crosses the platform ceiling mid-generation. */
export class ScriptTooLongError extends Error {
  constructor(secondsSoFar: number, sentencesDone: number, totalSentences: number) {
    const ceilingMin = Math.round(MAX_AUDIO_DURATION_SECONDS / 60);
    super(
      `The narration passed ${ceilingMin} minutes of audio at sentence ${sentencesDone} of ${totalSentences} — ` +
        `the longest we can process is ${ceilingMin} minutes. Nothing was saved. ` +
        `Shorten the script, or split it and create a project for each part.`,
    );
    this.name = "ScriptTooLongError";
    this.secondsSoFar = secondsSoFar;
  }
  secondsSoFar: number;
}

/**
 * What generateSpeech needs from a TTS engine: one call per sentence,
 * Float32 samples back. Injected so every line of the loop is unit-testable
 * without a 326 MB model; loadEngine builds the real one.
 */
export type TtsEngine = {
  generate(text: string, voice: string): Promise<{ samples: Float32Array; sampleRate: number }>;
};

/**
 * Loads Kokoro on WebGPU. First call on a machine downloads the model from
 * the Hugging Face CDN (~326 MB fp32) with per-file progress; the browser's
 * Cache Storage keeps it, so later sessions load from disk.
 *
 * fp32 is a decision, not a default: fp16 WebGPU output for this model is a
 * known quality risk, and the reported ~10s-of-speech-per-1s-of-compute
 * figure is the fp32 WebGPU number.
 */
export async function loadEngine(
  onProgress: (progress: TtsProgress) => void,
  opts: { dtype?: TtsDtype } = {},
): Promise<TtsEngine> {
  const [{ KokoroTTS }, { env }] = await Promise.all([
    import("kokoro-js"),
    import("@huggingface/transformers"),
  ]);
  // BEFORE from_pretrained: every file the loader resolves — config,
  // tokenizer, the model itself — must come from our bucket, never the
  // Hugging Face bridge (measured at 0.96 MB/s, capture 69).
  configureModelHost(env);
  // And the ONNX runtime's own wasm files likewise: wasmPaths is the only
  // source ORT consults (backends/onnx.js sets the jsDelivr default only
  // when unset), so this assignment removes jsDelivr from the critical path
  // with the same no-silent-fallback property as the model host.
  (env as { backends: { onnx: { wasm: { wasmPaths: string } } } }).backends.onnx.wasm.wasmPaths =
    ORT_WASM_BASE_URL;
  let tts: Awaited<ReturnType<typeof KokoroTTS.from_pretrained>>;
  try {
    tts = await KokoroTTS.from_pretrained(TTS_MODEL_ID, {
      device: "webgpu",
      dtype: opts.dtype ?? "fp32",
      progress_callback: (event: {
        status?: string;
        file?: string;
        loaded?: number;
        total?: number;
      }) => {
        if (event.status === "progress" && event.file) {
          onProgress({
            stage: "model",
            file: event.file,
            loadedBytes: event.loaded ?? 0,
            totalBytes: event.total ?? 0,
          });
        }
      },
    });
  } catch (err) {
    // A failed bucket fetch (model or runtime files) lands here as a raw
    // loader error; the user gets a sentence, the console keeps the detail.
    // No retry against any other host exists — that is the design.
    throw new Error(
      "The voice engine could not be downloaded. Please check your connection and try again. " +
        `(internal: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return {
    async generate(text: string, voice: string) {
      // Seeding comes FIRST, and it throws. kokoro-js hardcodes a Hugging
      // Face URL for voices with a silent fetch fallback on cache miss;
      // awaiting the seed here — inside the only path that reaches
      // tts.generate — is what makes that fallback structurally unreachable.
      // A seeding failure is a worded failure before any speech exists.
      await seedVoiceCache(voice);
      const audio = await tts.generate(text, { voice: voice as never });
      return { samples: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
    },
  };
}

/**
 * Speaks every sentence, strictly serially, accumulating exact sample counts.
 *
 * Sequencing is deliberate: chunk by chunk, no overlap with anything —
 * matching starts only after scenes exist, which is only after this whole
 * function has returned and its output has been uploaded.
 */
export async function generateSpeech(opts: {
  sentences: string[];
  voice: string;
  engine: TtsEngine;
  onProgress: (progress: TtsProgress) => void;
  signal?: AbortSignal;
  /**
   * Presented ONCE, at the first sentence boundary past CALIBRATION_WINDOW,
   * with the measured per-machine estimate. Returning "cancel" aborts with
   * nothing persisted anywhere — the zero-persistence property is what makes
   * cancelling free. Omitted by the Preview instrument, whose three fixed
   * sentences must run uninterrupted.
   */
  onCalibration?: (estimate: SpeechEstimate) => Promise<"continue" | "cancel">;
  /** Test seams. Defaults are the shipped behaviour. */
  calibrationWindow?: { minSentences: number; maxWallMs: number };
  nowMs?: () => number;
}): Promise<GeneratedSpeech> {
  const { sentences, voice, engine, onProgress, signal, onCalibration } = opts;
  if (sentences.length === 0)
    throw new Error("The script is empty. Paste or upload some text first.");

  const window = opts.calibrationWindow ?? CALIBRATION_WINDOW;
  const nowMs = opts.nowMs ?? (() => performance.now());
  const charsTotal = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
  const startedAtMs = nowMs();
  let charsDone = 0;
  let calibrated = false;

  const ceilingSamples = MAX_AUDIO_DURATION_SECONDS * TTS_SAMPLE_RATE;
  const parts: Array<Int16Array<ArrayBuffer>> = [];
  const spans: SampleSpan[] = [];
  let totalSamples = 0;

  for (let index = 0; index < sentences.length; index += 1) {
    if (signal?.aborted) throw new Error("Generation was cancelled.");

    const { samples, sampleRate } = await engine.generate(sentences[index], voice);
    // The whole timing model rides on 24 kHz. A different rate would make
    // every boundary silently wrong — the one thing this pipeline never
    // tolerates silently.
    if (sampleRate !== TTS_SAMPLE_RATE) {
      throw new Error(
        "Something went wrong assembling the audio — nothing was saved. Please try again. " +
          `(internal: engine produced ${sampleRate} Hz, expected ${TTS_SAMPLE_RATE})`,
      );
    }

    // Int16 on arrival; the Float32 chunk is garbage from here. Measured:
    // this is the difference between a 130 MB tab and a 620 MB one.
    parts.push(floatToInt16(samples));
    const startSample = totalSamples;
    totalSamples += samples.length;
    spans.push({ text: sentences[index], startSample, endSample: totalSamples });

    // THE CEILING, enforced on measured audio — the word-count check at
    // submission was only ever an estimate. Stops before the next sentence,
    // with nothing uploaded and nothing written anywhere.
    if (totalSamples > ceilingSamples) {
      throw new ScriptTooLongError(totalSamples / TTS_SAMPLE_RATE, index + 1, sentences.length);
    }

    charsDone += sentences[index].length;
    const computeSecDone = (nowMs() - startedAtMs) / 1000;
    const audioSecDone = totalSamples / TTS_SAMPLE_RATE;
    // Revised at EVERY boundary once any audio exists — the estimate stays
    // live for the whole run rather than freezing at the calibration sample.
    const estimate = estimateFromProgress({
      charsDone,
      charsTotal,
      audioSecDone,
      computeSecDone,
      sentencesDone: index + 1,
    });

    onProgress({
      stage: "generating",
      sentence: index + 1,
      totalSentences: sentences.length,
      secondsGenerated: audioSecDone,
      estimatedRemainingComputeSec:
        index + 1 < sentences.length ? estimate.estimatedRemainingComputeSec : 0,
    });

    // The decision point: first boundary past the window (floor, not ceiling
    // — see CALIBRATION_WINDOW), and only when there is another sentence to
    // spend time on. Cancelling here costs the seconds already spent and
    // nothing else: no row, no byte, no cache entry of ours exists yet.
    if (
      !calibrated &&
      onCalibration &&
      index + 1 < sentences.length &&
      (index + 1 >= window.minSentences || computeSecDone * 1000 >= window.maxWallMs)
    ) {
      calibrated = true;
      const verdict = await onCalibration(estimate);
      if (verdict === "cancel") throw new Error("Generation was cancelled.");
    }
  }

  onProgress({ stage: "assembling" });

  // The duration gate — zero tolerance, before any byte leaves the machine.
  const partSamples = parts.reduce((sum, part) => sum + part.length, 0);
  assertSampleExact(spans, totalSamples, partSamples);

  return {
    wavBlob: buildWavBlob(parts, totalSamples),
    sentences: sentenceBoundariesToMs(spans),
    durationSec: totalSamples / TTS_SAMPLE_RATE,
    totalSamples,
  };
}
