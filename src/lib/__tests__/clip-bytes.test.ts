/**
 * Byte-aware rendition selection.
 *
 * The round-6 source-duration budget bounds how LONG a source is, which does not
 * bound how BIG it is. A 235,132,958-byte Pixabay rendition passed the duration
 * budget and was selected against the worker's 157,286,400-byte MAX_CLIP_BYTES,
 * so the chunk's first attempt was rejected every time that clip was drawn.
 *
 * Pixabay reports per-rendition byte size in the search response we already
 * make. These tests pin that the size is captured and honoured — with no extra
 * provider request, which is the constraint that rules out a HEAD per candidate.
 */
import { describe, expect, it } from "vitest";

import {
  fallbackRenditions,
  isOversizedFile,
  maxClipBytes,
  selectRenditionForTarget,
  type StockVideoFile,
} from "../stock.server";

const CEILING = 157_286_400; // the worker's MAX_CLIP_BYTES

const file = (width: number, bytes?: number): StockVideoFile => ({
  url: `https://cdn.pixabay.com/video/${width}.mp4`,
  width,
  height: Math.round((width * 9) / 16),
  ...(bytes == null ? {} : { bytes }),
});

describe("byte ceiling", () => {
  it("defaults to the worker's 150 MB and honours an override", () => {
    delete process.env.MAX_CLIP_BYTES;
    expect(maxClipBytes()).toBe(CEILING);
    process.env.MAX_CLIP_BYTES = "1000";
    expect(maxClipBytes()).toBe(1000);
    for (const raw of ["0", "-1", "nope", ""]) {
      process.env.MAX_CLIP_BYTES = raw;
      expect(maxClipBytes()).toBe(CEILING);
    }
    delete process.env.MAX_CLIP_BYTES;
  });

  it("treats unknown size as usable, never as oversized", () => {
    // Pexels and NASA report no size. Guessing "too big" would reject most of
    // the catalogue; the worker's pre-check remains the authority for them.
    expect(isOversizedFile(file(1920), CEILING)).toBe(false);
    expect(isOversizedFile(file(1920, CEILING + 1), CEILING)).toBe(true);
    expect(isOversizedFile(file(1920, CEILING), CEILING)).toBe(false);
  });
});

describe("rendition selection", () => {
  it("skips the known-oversized rendition and takes the next one down", () => {
    // The production shape exactly: target width 1920, the 1920 rendition is
    // 235 MB, and a smaller one is available.
    const files = [file(640, 8_000_000), file(1280, 40_000_000), file(1920, 235_132_958)];
    const chosen = selectRenditionForTarget(files, 1920, CEILING);
    expect(chosen?.width).toBe(1280);
  });

  it("still prefers the smallest rendition at or above the target width", () => {
    const files = [file(640, 8_000_000), file(1280, 40_000_000), file(1920, 90_000_000)];
    expect(selectRenditionForTarget(files, 1280, CEILING)?.width).toBe(1280);
    expect(selectRenditionForTarget(files, 1920, CEILING)?.width).toBe(1920);
  });

  it("is unchanged when no size is reported", () => {
    const files = [file(640), file(1280), file(1920)];
    expect(selectRenditionForTarget(files, 1920, CEILING)?.width).toBe(1920);
    expect(selectRenditionForTarget(files, 720, CEILING)?.width).toBe(1280);
  });

  it("falls back to the largest affordable file when all are below target", () => {
    const files = [file(640, 8_000_000), file(960, 20_000_000)];
    expect(selectRenditionForTarget(files, 1920, CEILING)?.width).toBe(960);
  });

  it("takes the smallest oversized file rather than nothing when every option is too big", () => {
    // Degenerate but reachable. A rejected download the worker can report beats
    // an unmatched scene, and the fall-through gives it somewhere to go.
    const files = [file(1280, 200_000_000), file(1920, 400_000_000)];
    expect(selectRenditionForTarget(files, 1920, CEILING)?.width).toBe(1280);
  });

  it("returns null only for an empty file list", () => {
    expect(selectRenditionForTarget([], 1920, CEILING)).toBeNull();
  });
});

describe("fallback renditions", () => {
  it("offers only smaller renditions, largest first", () => {
    const files = [file(640, 8_000_000), file(1280, 40_000_000), file(1920, 90_000_000)];
    const chosen = selectRenditionForTarget(files, 1920, CEILING)!;
    expect(fallbackRenditions(files, chosen, CEILING)).toEqual([
      files[1].url, // 1280 before 640: closest to the intended quality first
      files[0].url,
    ]);
  });

  it("never offers a rendition already known to be oversized", () => {
    // Falling "across" to another too-large file would just re-hit the ceiling.
    const files = [file(640, 8_000_000), file(1280, 300_000_000), file(1920, 90_000_000)];
    const chosen = files[2];
    expect(fallbackRenditions(files, chosen, CEILING)).toEqual([files[0].url]);
  });

  it("never offers the chosen file back to itself, or anything larger", () => {
    const files = [file(640, 8_000_000), file(1280, 40_000_000), file(1920, 90_000_000)];
    const chosen = files[0];
    expect(fallbackRenditions(files, chosen, CEILING)).toEqual([]);
  });

  it("is empty when the source has a single rendition", () => {
    const files = [file(1920, 90_000_000)];
    expect(fallbackRenditions(files, files[0], CEILING)).toEqual([]);
  });
});
