import { describe, expect, it } from "vitest";

import { isMissingPollResult, pollIntervalWhileActive } from "../polling-state";

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
