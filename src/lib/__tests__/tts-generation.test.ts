/**
 * Script-to-video: sample-exact by construction, silent about nothing.
 *
 * The properties pinned here are the design's load-bearing walls:
 *   - every scene boundary derives from ONE integer sample accumulator, so
 *     rounding error is ≤0.5 ms per boundary and does not accumulate (the
 *     round-11 drift class, excluded rather than mitigated)
 *   - the duration gate is zero-tolerance integer equality, checked before a
 *     byte is uploaded or a row written
 *   - the 45-minute ceiling is enforced on MEASURED audio during generation
 *   - the matching path contains no TTS imports — the whole guardrail is
 *     that an audio-to-video project cannot behave differently
 */
import { describe, expect, it, vi } from "vitest";

import {
  PREVIEW_TEXT,
  ScriptTooLongError,
  TTS_VOICES,
  generateSpeech,
  parseDtypeParam,
  type TtsEngine,
  type TtsProgress,
} from "../tts/generate";
import {
  SAMPLES_PER_MS,
  TTS_SAMPLE_RATE,
  assertSampleExact,
  buildWavHeader,
  floatToInt16,
  sentenceBoundariesToMs,
} from "../tts/wav";
import { checkScript, estimateSpokenSeconds, splitScriptIntoSentences } from "../tts/script-input";
import { validateScriptSentences } from "../pipeline.functions";
import { MAX_AUDIO_DURATION_SECONDS } from "../audio-limits";

/** An engine that speaks each sentence as `samplesPerChar × length` samples. */
function fakeEngine(samplesPerChar = 800, sampleRate = TTS_SAMPLE_RATE): TtsEngine {
  return {
    async generate(text: string) {
      const samples = new Float32Array(text.length * samplesPerChar);
      for (let i = 0; i < samples.length; i += 13) samples[i] = Math.sin(i) * 0.5;
      return { samples, sampleRate };
    },
  };
}

describe("the generation loop is sample-exact by construction", () => {
  it("produces contiguous boundaries whose last sample IS the file length", async () => {
    const sentences = ["First sentence.", "The second one is longer.", "Third."];
    const result = await generateSpeech({
      sentences,
      voice: "af_heart",
      engine: fakeEngine(),
      onProgress: () => {},
    });

    expect(result.sentences).toHaveLength(3);
    expect(result.sentences[0].start_ms).toBe(0);
    for (let i = 1; i < result.sentences.length; i += 1) {
      expect(result.sentences[i].start_ms).toBe(result.sentences[i - 1].end_ms);
    }
    // The WAV is exactly the accumulator: 44-byte header + 2 bytes per sample.
    expect(result.wavBlob.size).toBe(44 + result.totalSamples * 2);
    expect(result.durationSec).toBeCloseTo(result.totalSamples / TTS_SAMPLE_RATE, 10);
    // And the server-side gate accepts what the client built.
    expect(validateScriptSentences(result.sentences, result.durationSec)).toBeNull();
  });

  it("boundary rounding never accumulates, even over 500 sentences", async () => {
    // Each sentence lands on a non-integer millisecond (127 samples ≈ 5.29 ms)
    // — the worst case for drift. Every boundary must stay within 0.5 ms of
    // its exact sample position, at sentence 3 and at sentence 500 alike.
    const engine: TtsEngine = {
      async generate() {
        return { samples: new Float32Array(127), sampleRate: TTS_SAMPLE_RATE };
      },
    };
    const sentences = Array.from({ length: 500 }, (_, i) => `s${i}`);
    const result = await generateSpeech({
      sentences,
      voice: "af_heart",
      engine,
      onProgress: () => {},
    });

    for (let i = 0; i < 500; i += 1) {
      const exactMs = ((i + 1) * 127) / SAMPLES_PER_MS;
      expect(Math.abs(result.sentences[i].end_ms - exactMs)).toBeLessThanOrEqual(0.5);
    }
    expect(validateScriptSentences(result.sentences, result.durationSec)).toBeNull();
  });

  it("reports real progress: sentence N of M with seconds generated", async () => {
    const events: TtsProgress[] = [];
    await generateSpeech({
      sentences: ["One.", "Two.", "Three."],
      voice: "af_heart",
      engine: fakeEngine(),
      onProgress: (event) => events.push(event),
    });
    const generating = events.filter((event) => event.stage === "generating");
    expect(generating.map((event) => (event.stage === "generating" ? event.sentence : -1))).toEqual(
      [1, 2, 3],
    );
    expect(events.at(-1)).toEqual({ stage: "assembling" });
  });

  it("refuses a wrong sample rate loudly instead of writing wrong timings", async () => {
    await expect(
      generateSpeech({
        sentences: ["Hello."],
        voice: "af_heart",
        engine: fakeEngine(800, 22_050),
        onProgress: () => {},
      }),
    ).rejects.toThrow(/nothing was saved/i);
  });

  it("stops at the 45-minute ceiling with a message that says what to do", async () => {
    // 2 sentences × 30 minutes each: the ceiling trips mid-generation, on
    // measured samples, long before a word count could have known.
    const engine: TtsEngine = {
      async generate() {
        return {
          samples: new Float32Array(30 * 60 * TTS_SAMPLE_RATE),
          sampleRate: TTS_SAMPLE_RATE,
        };
      },
    };
    const failure = await generateSpeech({
      sentences: ["Half one.", "Half two."],
      voice: "af_heart",
      engine,
      onProgress: () => {},
    }).catch((err) => err);
    expect(failure).toBeInstanceOf(ScriptTooLongError);
    expect(failure.message).toMatch(/45 minutes/);
    expect(failure.message).toMatch(/Nothing was saved/i);
    expect(failure.message).toMatch(/split/i);
    expect(failure.message).not.toMatch(/sample|Int16|accumulator/i);
  });

  it("stops between sentences when cancelled", async () => {
    const controller = new AbortController();
    const engine: TtsEngine = {
      async generate(text: string) {
        if (text === "Two.") controller.abort();
        return { samples: new Float32Array(2400), sampleRate: TTS_SAMPLE_RATE };
      },
    };
    await expect(
      generateSpeech({
        sentences: ["One.", "Two.", "Three."],
        voice: "af_heart",
        engine,
        onProgress: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe("the WAV container", () => {
  it("writes a correct RIFF header for 24 kHz mono 16-bit", () => {
    const header = new DataView(buildWavHeader(24_000)); // one second
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => header.getUint8(offset + i)));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");
    expect(header.getUint16(20, true)).toBe(1); // PCM
    expect(header.getUint16(22, true)).toBe(1); // mono
    expect(header.getUint32(24, true)).toBe(24_000);
    expect(header.getUint32(28, true)).toBe(48_000); // byte rate
    expect(header.getUint16(34, true)).toBe(16);
    expect(header.getUint32(40, true)).toBe(48_000); // data bytes
    expect(header.getUint32(4, true)).toBe(36 + 48_000);
  });

  it("clamps out-of-range floats instead of wrapping them into clicks", () => {
    const pcm = floatToInt16(new Float32Array([0, 1, -1, 1.5, -1.5, 0.5]));
    expect(pcm[1]).toBe(0x7fff);
    expect(pcm[2]).toBe(-0x8000);
    expect(pcm[3]).toBe(0x7fff);
    expect(pcm[4]).toBe(-0x8000);
  });

  it("the gate rejects a dropped chunk, a gap, and a phantom sample", () => {
    const good = [
      { text: "a", startSample: 0, endSample: 100 },
      { text: "b", startSample: 100, endSample: 250 },
    ];
    expect(() => assertSampleExact(good, 250, 250)).not.toThrow();
    // Part total disagrees with the accumulator: a chunk was dropped.
    expect(() => assertSampleExact(good, 250, 150)).toThrow(/nothing was saved/i);
    // Spans do not reach the end of the file.
    expect(() => assertSampleExact(good, 300, 300)).toThrow(/nothing was saved/i);
    // A gap between spans.
    expect(() =>
      assertSampleExact(
        [
          { text: "a", startSample: 0, endSample: 100 },
          { text: "b", startSample: 120, endSample: 250 },
        ],
        250,
        250,
      ),
    ).toThrow(/nothing was saved/i);
  });

  it("shared boundaries round identically, so contiguity survives ms conversion", () => {
    const spans = [
      { text: "a", startSample: 0, endSample: 127 },
      { text: "b", startSample: 127, endSample: 301 },
    ];
    const ms = sentenceBoundariesToMs(spans);
    expect(ms[0].end_ms).toBe(ms[1].start_ms);
  });
});

describe("the sentence splitter", () => {
  it("splits ordinary prose on terminators", () => {
    expect(splitScriptIntoSentences("One sentence. Another one! A third?")).toEqual([
      "One sentence.",
      "Another one!",
      "A third?",
    ]);
  });

  it("does not split on abbreviations, initials or decimals", () => {
    expect(
      splitScriptIntoSentences("Dr. Grant found 2.5 million samples. J. Smith agreed."),
    ).toEqual(["Dr. Grant found 2.5 million samples.", "J. Smith agreed."]);
  });

  it("keeps closing quotes with their sentence", () => {
    expect(splitScriptIntoSentences('She said "stop." Then she left.')).toEqual([
      'She said "stop."',
      "Then she left.",
    ]);
  });

  it("collapses whitespace and returns the tail even without a final period", () => {
    expect(splitScriptIntoSentences("Line one.\n\nLine   two")).toEqual(["Line one.", "Line two"]);
    expect(splitScriptIntoSentences("   ")).toEqual([]);
  });
});

describe("the script pre-check", () => {
  it("refuses empty scripts in plain language", () => {
    const verdict = checkScript("   ");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/paste or upload/i);
  });

  it("warns near the ceiling but only refuses the absurd", () => {
    const minuteOfWords = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ") + ".";
    const nearCeiling = Array.from({ length: 50 }, () => minuteOfWords).join(" ");
    const overCeiling = Array.from({ length: 80 }, () => minuteOfWords).join(" ");
    expect(estimateSpokenSeconds(nearCeiling)).toBeGreaterThan(MAX_AUDIO_DURATION_SECONDS);

    const warned = checkScript(nearCeiling);
    expect(warned.ok).toBe(true);
    if (warned.ok) expect(warned.warning).toMatch(/limit/i);

    const refused = checkScript(overCeiling);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/split/i);
  });
});

describe("the server-side gate", () => {
  const contiguous = (durationsMs: number[]) => {
    let at = 0;
    return durationsMs.map((duration, i) => {
      const row = { text: `s${i}`, start_ms: at, end_ms: at + duration };
      at += duration;
      return row;
    });
  };

  it("accepts a contiguous timeline that matches the duration", () => {
    expect(validateScriptSentences(contiguous([5000, 6200, 4800]), 16)).toBeNull();
  });

  it("rejects gaps, overlaps, nonzero starts, and length mismatches", () => {
    const gap = contiguous([5000, 5000]);
    gap[1].start_ms += 10;
    gap[1].end_ms += 10;
    expect(validateScriptSentences(gap, 10.01)).toMatch(/gap or overlap/i);

    const nonzero = contiguous([5000]).map((s) => ({ ...s, start_ms: 5, end_ms: 5005 }));
    expect(validateScriptSentences(nonzero, 5.005)).toMatch(/start at zero/i);

    expect(validateScriptSentences(contiguous([5000, 5000]), 12)).toMatch(/does not match/i);

    expect(
      validateScriptSentences(
        contiguous([(MAX_AUDIO_DURATION_SECONDS + 60) * 1000]),
        MAX_AUDIO_DURATION_SECONDS + 60,
      ),
    ).toMatch(/45-minute limit/i);
  });

  it("tolerates exactly the 1 ms that boundary rounding can introduce", () => {
    const rows = contiguous([5000]);
    expect(validateScriptSentences(rows, 5.001)).toBeNull();
    expect(validateScriptSentences(rows, 5.003)).toMatch(/does not match/i);
  });
});

describe("the dtype comparison harness", () => {
  it("defaults to fp32 for anything it does not recognise", () => {
    // fp32 is the shipped decision; a mistyped param must never silently
    // select a quantised model.
    expect(parseDtypeParam("")).toBe("fp32");
    expect(parseDtypeParam("?dtype=fp16")).toBe("fp16");
    expect(parseDtypeParam("?dtype=q8")).toBe("q8");
    expect(parseDtypeParam("?dtype=q4")).toBe("fp32");
    expect(parseDtypeParam("?dtype=FP16")).toBe("fp32");
    expect(parseDtypeParam("?other=1")).toBe("fp32");
  });

  it("previews a fixed paragraph that splits into full sentences", () => {
    // Fixed input is the point: every dtype and voice is judged on identical
    // material, and the material exercises numbers, a name and a question.
    const sentences = splitScriptIntoSentences(PREVIEW_TEXT);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(PREVIEW_TEXT).toMatch(/\d/);
    expect(PREVIEW_TEXT).toMatch(/\?/);
  });
});

describe("voices and guardrails", () => {
  it("offers 3-5 preset English voices", () => {
    expect(TTS_VOICES.length).toBeGreaterThanOrEqual(3);
    expect(TTS_VOICES.length).toBeLessThanOrEqual(5);
    for (const voice of TTS_VOICES) expect(voice.label).toMatch(/American|British/);
  });

  it("the matching path contains no TTS imports", () => {
    // THE guardrail, as source: an audio-to-video project can only behave
    // identically if the shared path gained zero new code. TTS ends at the
    // same five rows ASR produces; nothing downstream may know it exists.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    for (const file of [
      "src/lib/stock-corpus.server.ts",
      "src/lib/stock-corpus-store.server.ts",
      "src/lib/stock.server.ts",
      "src/lib/matching-budget.ts",
      "src/lib/matching-cache.server.ts",
      "src/lib/visual-queries.server.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, `${file} must not import TTS code`).not.toMatch(/from "@\/lib\/tts|kokoro/i);
    }
    // And the TTS modules import nothing from the matching path.
    for (const file of [
      "src/lib/tts/generate.ts",
      "src/lib/tts/wav.ts",
      "src/lib/tts/script-input.ts",
      "src/lib/tts/webgpu.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, `${file} must not touch the matching path`).not.toMatch(
        /stock-corpus|stock\.server|matching-(budget|cache|profile)/,
      );
    }
  });

  it("kokoro-js and mammoth are loaded lazily, never statically", () => {
    // The ordinary app bundle must stay byte-identical: a static import
    // anywhere in src/ would pull transformers.js into the main chunk.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      `grep -rn 'from "kokoro-js"\\|from "mammoth' src/ --include='*.ts' --include='*.tsx' ` +
        `--exclude-dir=__tests__ || true`,
      { encoding: "utf8" },
    );
    expect(hits.trim()).toBe("");
  });
});
