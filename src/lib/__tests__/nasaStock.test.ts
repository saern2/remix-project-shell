import { describe, expect, it } from "vitest";

import {
  findNasaDurationSeconds,
  nasaFileFromUrl,
  nasaPageForSeed,
  parseNasaDurationSeconds,
} from "../nasaStock.server";

describe("NASA stock metadata helpers", () => {
  it("parses QuickTime hh:mm:ss durations from NASA metadata", () => {
    expect(parseNasaDurationSeconds("1:10:15")).toBe(4215);
    expect(parseNasaDurationSeconds("0:02:32")).toBe(152);
  });

  it("parses QuickTime mm:ss and seconds durations", () => {
    expect(parseNasaDurationSeconds("02:06")).toBe(126);
    expect(parseNasaDurationSeconds("7.5 s")).toBe(7.5);
  });

  it("rejects missing, zero, and malformed durations", () => {
    expect(parseNasaDurationSeconds(null)).toBeNull();
    expect(parseNasaDurationSeconds("0 s")).toBeNull();
    expect(parseNasaDurationSeconds("not a duration")).toBeNull();
  });

  it("scans unstable metadata keys and skips zero-duration placeholders", () => {
    expect(
      findNasaDurationSeconds({
        "QuickTime:PreviewDuration": "0 s",
        "XMP:Duration": { Scale: 1.11111111111111e-5, Value: 12_009_600 },
        "QuickTime:MediaDuration": "0:02:13",
      }),
    ).toBeCloseTo(133.44, 2);
  });

  it("keeps MP4 files whose names do not contain a NASA size tier", () => {
    expect(nasaFileFromUrl("https://images-assets.nasa.gov/video/example.mp4")).toEqual({
      url: "https://images-assets.nasa.gov/video/example.mp4",
      width: 1280,
      height: 720,
    });
  });

  it("derives valid, varied pages from the seed and total hit count", () => {
    const pages = new Set(
      Array.from({ length: 30 }, (_, index) => nasaPageForSeed(`project-${index}`, 37)),
    );
    expect(Math.min(...pages)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...pages)).toBeLessThanOrEqual(37);
    expect(pages.size).toBeGreaterThan(1);
  });
});
