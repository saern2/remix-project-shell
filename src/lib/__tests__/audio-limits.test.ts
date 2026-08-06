/**
 * The ceiling users are told about, rather than discover.
 *
 * Every measurement in this system was taken at 145 scenes. A 524-scene project
 * found the first thing that breaks — a work list and a completion check
 * disagreeing — and it will not be the last. A stated limit at upload costs a
 * user nothing; finding it after a transcription bill costs them real money.
 */
import { describe, expect, it } from "vitest";

import { checkAudioLength, formatDuration, MAX_AUDIO_DURATION_SECONDS } from "../audio-limits";

describe("the audio length ceiling", () => {
  it("is 45 minutes — roughly 450 scenes at ~6s each", () => {
    expect(MAX_AUDIO_DURATION_SECONDS).toBe(2700);
  });

  it("sits above the largest clean production run and below the one that broke", () => {
    // 145 scenes ≈ 15 min ran clean; 524 scenes ≈ 52 min deadlocked.
    expect(MAX_AUDIO_DURATION_SECONDS / 6).toBeGreaterThan(145);
    expect(MAX_AUDIO_DURATION_SECONDS / 6).toBeLessThan(524);
  });

  it("accepts anything at or under the limit", () => {
    expect(checkAudioLength(60).ok).toBe(true);
    expect(checkAudioLength(MAX_AUDIO_DURATION_SECONDS).ok).toBe(true);
  });

  it("rejects over the limit, naming the limit and what to do", () => {
    const verdict = checkAudioLength(52 * 60);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.message).toContain("52 min");
    expect(verdict.message).toContain("45 min");
    // A bare "too long" leaves someone guessing how much to cut.
    expect(verdict.message).toMatch(/split/i);
  });

  it("accepts an unmeasurable duration rather than blocking the upload", () => {
    // Browsers cannot decode metadata for every container. Refusing work we can
    // very likely do would be the worse failure.
    for (const value of [null, undefined, NaN, 0, -1]) {
      expect(checkAudioLength(value).ok).toBe(true);
    }
  });
});

describe("duration formatting", () => {
  it("reads the way a person would say it", () => {
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(52 * 60 + 30)).toBe("52 min 30s");
    expect(formatDuration(42)).toBe("42s");
  });
});
