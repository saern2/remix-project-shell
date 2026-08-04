import { describe, expect, it } from "vitest";

import { isMissingPollResult, nextPollDelayMs, pollIntervalWhileActive } from "../polling-state";

describe("terminal polling state", () => {
  const active = new Set(["matching_footage", "rendering"]);

  it("stops refetch intervals when the subject vanishes", () => {
    expect(pollIntervalWhileActive(null, active, 3000)).toBe(false);
    expect(pollIntervalWhileActive(undefined, active, 3000)).toBe(false);
  });

  it("continues only for explicitly active statuses", () => {
    expect(pollIntervalWhileActive({ status: "rendering" }, active, 3000)).toBe(3000);
    expect(pollIntervalWhileActive({ status: "completed" }, active, 3000)).toBe(false);
    expect(pollIntervalWhileActive({ status: "not_found" }, active, 3000)).toBe(false);
  });

  it("recognizes a vanished server poll result as terminal", () => {
    expect(isMissingPollResult({ status: "not_found" })).toBe(true);
    expect(isMissingPollResult({ status: "rendering" })).toBe(false);
  });
});

describe("poll backoff (round 6, Issue 6)", () => {
  it("stays at the base interval while polls succeed", () => {
    expect(nextPollDelayMs(0)).toBe(4000);
  });

  it("backs off exponentially on consecutive errors", () => {
    expect(nextPollDelayMs(1)).toBe(8000);
    expect(nextPollDelayMs(2)).toBe(16000);
    expect(nextPollDelayMs(3)).toBe(30000); // 32000 capped
  });

  it("never exceeds the ceiling no matter how long the streak", () => {
    expect(nextPollDelayMs(50)).toBe(30000);
    expect(nextPollDelayMs(50, 4000, 20000)).toBe(20000);
  });
});
