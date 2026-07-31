import { describe, expect, it } from "vitest";

import { parseNasaDurationSeconds } from "../nasaStock.server";

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
});
