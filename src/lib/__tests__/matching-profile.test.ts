import { describe, expect, it } from "vitest";

import { createMatchingProfile } from "../matching-profile";

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("matching profile", () => {
  it("accumulates timings per bucket and rounds them for logging", async () => {
    const clock = fakeClock();
    const profile = createMatchingProfile(clock.now);

    await profile.time("providerSearch", async () => clock.advance(1_200));
    await profile.time("providerSearch", async () => clock.advance(800));
    await profile.time("dbWrite", async () => clock.advance(150));

    const summary = profile.summary();
    expect(summary.providerSearchMs).toBe(2_000);
    expect(summary.dbWriteMs).toBe(150);
  });

  it("records time even when the timed operation throws", async () => {
    // A failing provider call still consumed wall-clock time and must appear.
    const clock = fakeClock();
    const profile = createMatchingProfile(clock.now);

    await expect(
      profile.time("providerSearch", async () => {
        clock.advance(900);
        throw new Error("provider 500");
      }),
    ).rejects.toThrow("provider 500");

    expect(profile.summary().providerSearchMs).toBe(900);
  });

  it("times synchronous work and returns its value", () => {
    const clock = fakeClock();
    const profile = createMatchingProfile(clock.now);

    const result = profile.timeSync("assignment", () => {
      clock.advance(400);
      return "picked";
    });

    expect(result).toBe("picked");
    expect(profile.summary().assignmentMs).toBe(400);
  });

  it("tracks counters separately from timings", () => {
    const profile = createMatchingProfile(fakeClock().now);
    profile.count("searchCacheHits");
    profile.count("searchCacheHits");
    profile.count("searchCacheMisses", 3);

    const summary = profile.summary();
    expect(summary.searchCacheHits).toBe(2);
    expect(summary.searchCacheMisses).toBe(3);
  });

  it("returns an empty summary when nothing was measured", () => {
    expect(createMatchingProfile(fakeClock().now).summary()).toEqual({});
  });
});
