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
  | { stage: "generating"; sentence: number; totalSentences: number; secondsGenerated: number }
  | { stage: "assembling" };

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
export async function loadEngine(onProgress: (progress: TtsProgress) => void): Promise<TtsEngine> {
  const { KokoroTTS } = await import("kokoro-js");
  const tts = await KokoroTTS.from_pretrained(TTS_MODEL_ID, {
    device: "webgpu",
    dtype: "fp32",
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
  return {
    async generate(text: string, voice: string) {
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
}): Promise<GeneratedSpeech> {
  const { sentences, voice, engine, onProgress, signal } = opts;
  if (sentences.length === 0)
    throw new Error("The script is empty. Paste or upload some text first.");

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

    onProgress({
      stage: "generating",
      sentence: index + 1,
      totalSentences: sentences.length,
      secondsGenerated: totalSamples / TTS_SAMPLE_RATE,
    });
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
