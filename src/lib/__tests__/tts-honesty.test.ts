/**
 * TTS honesty round: calibrated estimates, real gates, markdown-free scenes,
 * no third parties on the critical path.
 *
 * Context that shapes every pin here: two machines measured on 2026-08-16
 * passed the WebGPU gate and then ran at 3.38 and ~10 COMPUTE seconds per
 * AUDIO second — a 45-minute script meaning 2.5 to 7.5 hours nobody warned
 * them about. The items pinned: the per-machine estimate and its decision
 * point, the conformance floor, the honest download label, markdown
 * sanitisation that is IDENTITY on plain prose, and the wasm path pin.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CALIBRATION_WINDOW,
  ESTIMATE_SANITY_COMPUTE_SEC,
  estimateFromProgress,
  generateSpeech,
  type SpeechEstimate,
  type TtsEngine,
  type TtsProgress,
} from "../tts/generate";
import { TTS_SAMPLE_RATE } from "../tts/wav";
import { sanitizeScript, splitScriptIntoSentences } from "../tts/script-input";
import { MIN_STORAGE_BUFFER_BINDING_BYTES, checkWebGpu } from "../tts/webgpu";
import { ORT_WASM_BASE_URL, TTS_MODEL_BASE_URL, isModelCached } from "../tts/model-host";

/**
 * An engine whose per-sentence compute cost is a controlled clock: each
 * generate() emits one second of audio and advances the injected clock by
 * computeMsPerSentence. Wall time never enters the tests.
 */
function timedHarness(computeMsPerSentence: number) {
  let clock = 0;
  const engine: TtsEngine = {
    async generate() {
      clock += computeMsPerSentence;
      return { samples: new Float32Array(TTS_SAMPLE_RATE), sampleRate: TTS_SAMPLE_RATE };
    },
  };
  return { engine, nowMs: () => clock };
}

const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i}.`);

describe("Item 1 — the calibrated estimate", () => {
  it("presents the verdict once, at the configured sentence boundary, with named-direction rates", async () => {
    // 3 compute-seconds per 1 audio-second: the operator's desktop, roughly.
    const { engine, nowMs } = timedHarness(3000);
    const seen: SpeechEstimate[] = [];
    await generateSpeech({
      sentences: sentences(6),
      voice: "af_heart",
      engine,
      onProgress: () => {},
      onCalibration: async (estimate) => {
        seen.push(estimate);
        return "continue";
      },
      calibrationWindow: { minSentences: 2, maxWallMs: 60_000 },
      nowMs,
    });

    expect(seen).toHaveLength(1);
    const estimate = seen[0];
    expect(estimate.calibratedOnSentences).toBe(2);
    // The held-measurement direction: compute per audio, bigger is slower.
    expect(estimate.computeSecPerAudioSec).toBeCloseTo(3, 5);
    // The display direction is its exact inverse.
    expect(estimate.audioSecPerComputeSec).toBeCloseTo(1 / 3, 5);
    // 6 equal-length sentences, 1s of audio each, at 3 compute-sec per
    // audio-sec: the whole job is ~18 compute-seconds.
    expect(estimate.estimatedTotalComputeSec).toBeCloseTo(18, 5);
  });

  it("the wall-clock window is a floor: one long sentence overshoots it and the verdict follows the boundary", async () => {
    // A 0.03x machine: one sentence costs 30s of compute. The 5s window
    // expires mid-sentence, where nothing can be interrupted — the verdict
    // lands at the FIRST boundary after it.
    const { engine, nowMs } = timedHarness(30_000);
    const seen: SpeechEstimate[] = [];
    await generateSpeech({
      sentences: sentences(3),
      voice: "af_heart",
      engine,
      onProgress: () => {},
      onCalibration: async (estimate) => {
        seen.push(estimate);
        return "continue";
      },
      calibrationWindow: { minSentences: 99, maxWallMs: 5_000 },
      nowMs,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].calibratedOnSentences).toBe(1);
    expect(seen[0].computeSecPerAudioSec).toBeCloseTo(30, 5);
  });

  it("cancel aborts with the cancelled error and generates nothing further", async () => {
    let generated = 0;
    const engine: TtsEngine = {
      async generate() {
        generated += 1;
        return { samples: new Float32Array(TTS_SAMPLE_RATE), sampleRate: TTS_SAMPLE_RATE };
      },
    };
    await expect(
      generateSpeech({
        sentences: sentences(10),
        voice: "af_heart",
        engine,
        onProgress: () => {},
        onCalibration: async () => "cancel",
        calibrationWindow: { minSentences: 2, maxWallMs: 60_000 },
        nowMs: () => 0,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(generated).toBe(2); // the calibration sample, and nothing after
  });

  it("never pauses when no onCalibration is given — the Preview instrument's path", async () => {
    const { engine, nowMs } = timedHarness(1000);
    const result = await generateSpeech({
      sentences: sentences(3),
      voice: "af_heart",
      engine,
      onProgress: () => {},
      nowMs,
    });
    expect(result.sentences).toHaveLength(3);
  });

  it("does not interrupt a script with nothing left to decide", async () => {
    const { engine, nowMs } = timedHarness(1000);
    const onCalibration = vi.fn(async () => "continue" as const);
    await generateSpeech({
      sentences: sentences(2),
      voice: "af_heart",
      engine,
      onProgress: () => {},
      onCalibration,
      calibrationWindow: { minSentences: 2, maxWallMs: 60_000 },
      nowMs,
    });
    // The window lands at sentence 2 of 2 — pausing AFTER the work is done
    // would be a dialog about a decision that no longer exists.
    expect(onCalibration).not.toHaveBeenCalled();
  });

  it("keeps the estimate live: every boundary revises it, down to zero at the end", async () => {
    const { engine, nowMs } = timedHarness(2000);
    const remaining: Array<number | null> = [];
    await generateSpeech({
      sentences: sentences(4),
      voice: "af_heart",
      engine,
      onProgress: (event: TtsProgress) => {
        if (event.stage === "generating") remaining.push(event.estimatedRemainingComputeSec);
      },
      nowMs,
    });
    expect(remaining).toHaveLength(4);
    // Equal sentences at a constant rate: 6s, 4s, 2s left, then done.
    expect(remaining[0]).toBeCloseTo(6, 5);
    expect(remaining[1]).toBeCloseTo(4, 5);
    expect(remaining[2]).toBeCloseTo(2, 5);
    expect(remaining[3]).toBe(0);
  });

  it("the sanity bound matches the platform's audio ceiling", () => {
    expect(ESTIMATE_SANITY_COMPUTE_SEC).toBe(45 * 60);
    expect(CALIBRATION_WINDOW).toEqual({ minSentences: 2, maxWallMs: 25_000 });
  });

  it("estimateFromProgress keeps both direction names exact inverses", () => {
    const estimate = estimateFromProgress({
      charsDone: 100,
      charsTotal: 1000,
      audioSecDone: 10,
      computeSecDone: 34,
      sentencesDone: 2,
    });
    expect(estimate.computeSecPerAudioSec).toBeCloseTo(3.4, 5);
    expect(estimate.audioSecPerComputeSec).toBeCloseTo(1 / 3.4, 5);
    expect(estimate.estimatedTotalAudioSec).toBeCloseTo(100, 5);
    expect(estimate.estimatedTotalComputeSec).toBeCloseTo(340, 5);
    expect(estimate.estimatedRemainingComputeSec).toBeCloseTo(306, 5);
  });

  it("the bare name 'rtf' does not exist in TTS code", () => {
    // Two meanings of one name is the error class that has cost this project
    // days; both directions are spelled out or nothing is.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      `grep -rniE '\\brtf\\b' src/lib/tts/ src/routes/_authenticated/projects.new.tsx || true`,
      { encoding: "utf8" },
    );
    expect(hits.trim()).toBe("");
  });
});

describe("Item 2 — the conformance-floor gate", () => {
  const adapter = (bindingSize: number, info?: Record<string, unknown>) => ({
    requestAdapter: async () => ({
      limits: { maxBufferSize: 2_147_483_648, maxStorageBufferBindingSize: bindingSize },
      info,
    }),
  });

  it("refuses an adapter below the WebGPU spec default", async () => {
    const verdict = await checkWebGpu(adapter(MIN_STORAGE_BUFFER_BINDING_BYTES - 1));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/Chrome or Edge/);
  });

  it("passes a conformant adapter and returns the survey", async () => {
    const verdict = await checkWebGpu(
      adapter(MIN_STORAGE_BUFFER_BINDING_BYTES, { vendor: "nvidia", architecture: "kepler" }),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.survey.maxStorageBufferBindingSize).toBe(MIN_STORAGE_BUFFER_BINDING_BYTES);
      expect(verdict.survey.info).toEqual({ vendor: "nvidia", architecture: "kepler" });
    }
  });

  it("still refuses absence: no gpu, and a null adapter", async () => {
    expect((await checkWebGpu({ requestAdapter: async () => null })).ok).toBe(false);
  });
});

describe("Item 3 — the honest label's source of truth", () => {
  const cachesWith = (keys: string[]) =>
    ({
      open: async () => ({
        match: async (url: string) => (keys.includes(url) ? new Response("x") : undefined),
      }),
    }) as unknown as CacheStorage;

  it("reports cached only when the exact dtype's model URL is in transformers-cache", async () => {
    const fp32Url = `${TTS_MODEL_BASE_URL}onnx-community/Kokoro-82M-v1.0-ONNX/main/onnx/model.onnx`;
    expect(await isModelCached("fp32", cachesWith([fp32Url]))).toBe(true);
    expect(await isModelCached("q8", cachesWith([fp32Url]))).toBe(false);
    expect(
      await isModelCached(
        "q8",
        cachesWith([
          `${TTS_MODEL_BASE_URL}onnx-community/Kokoro-82M-v1.0-ONNX/main/onnx/model_quantized.onnx`,
        ]),
      ),
    ).toBe(true);
  });

  it("answers 'not cached' when the Cache API is unavailable — the safe wrong answer", async () => {
    expect(await isModelCached("fp32", undefined)).toBe(false);
  });
});

describe("Item 4 — markdown sanitisation", () => {
  it("cleans the production incident string", () => {
    // 2026-08-16: this exact structure was SPOKEN and became scene 43.
    const spoken = splitScriptIntoSentences(
      "The tale begins here.\n\n---\n\n## CHAPTER ONE — THE KINGDOM OF EMBERS\n\nFire lit the sky.",
    );
    expect(spoken).toEqual([
      "The tale begins here.",
      "CHAPTER ONE — THE KINGDOM OF EMBERS Fire lit the sky.",
    ]);
    expect(spoken.join(" ")).not.toMatch(/[#*`]|---/);
  });

  it("handles a Docs-style paste: headings, bold, italics, lists", () => {
    const cleaned = sanitizeScript(
      "# My Story\n\nIt was a **dark** and _stormy_ night.\n\n- First point\n- Second point\n\n1. Numbered thing.",
    );
    expect(cleaned).toContain("It was a dark and stormy night.");
    expect(cleaned).toContain("First point");
    expect(cleaned).toContain("Numbered thing.");
    expect(cleaned).not.toMatch(/[#*_-]\s/);
  });

  it("handles a ChatGPT-style paste: rules, links, fences, inline code", () => {
    const cleaned = sanitizeScript(
      "Intro line.\n\n---\n\nSee [the moon](https://example.com) tonight.\n\n```\nconsole.log('not narration')\n```\n\nUse the `telescope` carefully.",
    );
    expect(cleaned).toContain("See the moon tonight.");
    expect(cleaned).toContain("Use the telescope carefully.");
    expect(cleaned).not.toContain("example.com");
    expect(cleaned).not.toContain("console.log");
    expect(cleaned).not.toContain("```");
  });

  it("REGRESSION: is byte-identical on markdown-free prose, so sentence arrays cannot move", () => {
    // The working path's guarantee (A6): a plain script must produce the
    // same sentences after this change as before it. sanitizeScript is
    // identity on prose, and the splitter output is pinned literally.
    const plain =
      "Dr. Grant studied 2.5 million samples over the years. " +
      'She said "stop." Then she left for St. Petersburg! ' +
      "Was it worth 3.5 percent? Mr. Jones thought so.";
    expect(sanitizeScript(plain)).toBe(plain);
    expect(splitScriptIntoSentences(plain)).toEqual([
      "Dr. Grant studied 2.5 million samples over the years.",
      'She said "stop."',
      "Then she left for St. Petersburg!",
      "Was it worth 3.5 percent?",
      "Mr. Jones thought so.",
    ]);
  });

  it("keeps snake_case and mid-word underscores intact", () => {
    expect(sanitizeScript("The file model_fp16.onnx loads fine.")).toBe(
      "The file model_fp16.onnx loads fine.",
    );
  });
});

describe("Item 5 — the wasm path pin", () => {
  it("the R2 ort path is keyed to the INSTALLED transformers version, with a trailing slash", () => {
    // ORT concatenates filenames directly onto wasmPaths: a missing slash is
    // a malformed URL presenting as a 404/CORS mystery. And a transformers
    // bump without a re-upload would fetch runtime files that do not exist —
    // this is the loud failure A1 requires.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const pkg = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "node_modules/@huggingface/transformers/package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(ORT_WASM_BASE_URL).toContain(`/ort/transformers-${pkg.version}/`);
    expect(ORT_WASM_BASE_URL.endsWith("/")).toBe(true);
    expect(ORT_WASM_BASE_URL.startsWith(TTS_MODEL_BASE_URL)).toBe(true);
  });

  it("wasmPaths is assigned before the model loads", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/tts/generate.ts"), "utf8");
    const wasmAt = source.indexOf("wasmPaths =");
    const pretrainedAt = source.indexOf("KokoroTTS.from_pretrained(");
    expect(wasmAt).toBeGreaterThan(-1);
    expect(wasmAt).toBeLessThan(pretrainedAt);
  });
});

describe("Item 6 — the Preview instrument is untouched where it matters", () => {
  it("the printed ratio line format is byte-identical", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/routes/_authenticated/projects.new.tsx"),
      "utf8",
    );
    expect(source).toContain("s of speech in ${computeSec.toFixed(1)}s — ");
    expect(source).toContain("× realtime (${dtype})");
    // And the survey payload keeps its original keys (additions are allowed
    // per A3; renames are not — fleet data is already collected under them).
    for (const key of ["speedRatio:", "speechSec:", "computeSec:"]) {
      expect(source).toContain(key);
    }
    const payload = source.slice(source.indexOf('console.info("[tts-harness]"'));
    expect(payload.slice(0, 800)).toMatch(/\bdtype,/);
    expect(payload.slice(0, 800)).toMatch(/\bvoice,/);
  });
});
