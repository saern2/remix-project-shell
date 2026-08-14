/**
 * When the next pipeline poll goes out.
 *
 * MEASURED 2026-08-14, two full runs (321 and 356 scenes), 69 matching polls:
 *
 *   real-work responses   23 / 43     min 12,096ms / 10,040ms, median ~14s
 *   server elapsedMs      min 10,786ms / 7,292ms
 *   lock-not-held          0 / 1      2,644ms
 *   dead time between polls   118.0s of 474.5s, 209.6s of 833.5s
 *
 * A quarter of matching was the client waiting 4s after invocations that had
 * just spent their entire 12s server budget. The work is server-side; the
 * client's fixed cadence is unrelated to it.
 *
 * The floor of 10.0s is structural, not luck: shouldStartAnotherSlice returns
 * true unconditionally when no slice has run yet, so an invocation that takes
 * the matching lock always does at least one full unit of work.
 *
 * TWO INDEPENDENT GUARDS, and the tests below insist on both:
 *   1. shape — the fast returns that exist today are named and excluded
 *   2. duration — anything that came back under 2s is treated as not-work,
 *      whatever its shape, which is what catches the fast path added tomorrow
 */
import { describe, expect, it } from "vitest";

import {
  MIN_ADVANCING_INVOCATION_MS,
  nextPipelinePollDelayMs,
  nextPollDelayMs,
} from "../polling-state";

/** A response from an invocation that spent its budget building the corpus. */
const working = {
  status: "matching_footage",
  matching: { remaining: 180, lockHeld: 1, elapsedMs: 11_788 },
};

const delay = (result: unknown, elapsedMs: number, consecutiveErrors = 0) =>
  nextPipelinePollDelayMs({ result: result as never, elapsedMs, consecutiveErrors });

describe("an invocation that advanced matching is followed immediately", () => {
  it("returns no delay for a full-budget matching invocation", () => {
    expect(delay(working, 12_500)).toBe(0);
  });

  it("holds across the whole measured range of real invocations", () => {
    // 10,040ms was the fastest working response in either capture; 22,205ms the
    // slowest. Every one of them should chain straight into the next.
    for (const elapsed of [10_040, 12_096, 13_703, 14_782, 18_565, 22_205]) {
      expect(delay(working, elapsed), `${elapsed}ms`).toBe(0);
    }
  });
});

describe("the fast returns keep the 4s beat — by shape", () => {
  it("waits when a peer holds the single-flight lock", () => {
    // pipeline.functions.ts:999 — lockHeld: 0, remaining: -1. Measured at
    // 2,644ms, which is over the duration threshold, so ONLY the shape check
    // catches this one. That is why both guards exist.
    const locked = { status: "matching_footage", matching: { lockHeld: 0, remaining: -1 } };
    expect(delay(locked, 2_644)).toBe(4000);
  });

  it("waits during a maintenance freeze", () => {
    // Returns the project's CURRENT status and no telemetry at all.
    const frozen = { status: "matching_footage", paused_for_maintenance: true };
    expect(delay(frozen, 30_000)).toBe(4000);
  });

  it("waits on the bare transition into matching_footage", () => {
    // pipeline.functions.ts:482 — generating_scenes flips the row and returns
    // without a matching object. No invocation ran.
    expect(delay({ status: "matching_footage", error_message: null }, 5_000)).toBe(4000);
  });

  it("waits once nothing is outstanding", () => {
    const done = { status: "matching_footage", matching: { remaining: 0, lockHeld: 1 } };
    expect(delay(done, 12_000)).toBe(4000);
  });

  it("waits for any status that is not matching_footage", () => {
    for (const status of ["ready", "rendering", "failed", "transcribing", "generating_scenes"]) {
      expect(delay({ status, matching: { remaining: 5, lockHeld: 1 } }, 12_000), status).toBe(4000);
    }
  });

  it("waits on a null or absent result", () => {
    expect(delay(null, 12_000)).toBe(4000);
    expect(delay(undefined, 12_000)).toBe(4000);
  });
});

describe("the duration backstop catches the fast return nobody has written yet", () => {
  it("refuses to chain a response that came back too fast to have worked", () => {
    // Same shape as a working invocation, returned in 300ms. Whatever produced
    // it did not spend a 12s budget, so treating it as work would spin the loop
    // at network speed.
    expect(delay(working, 300)).toBe(4000);
  });

  it("sits an order of magnitude below every measured real invocation", () => {
    expect(MIN_ADVANCING_INVOCATION_MS).toBeLessThan(10_040);
    // And above the 2,644ms lock-not-held response only by shape, not duration
    // — the threshold is not asked to do that job.
    expect(MIN_ADVANCING_INVOCATION_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("bounds an unknown fast path to the 4s beat rather than a tight loop", () => {
    const unknownFastPath = {
      status: "matching_footage",
      matching: { remaining: 12, lockHeld: 1 },
    };
    expect(delay(unknownFastPath, MIN_ADVANCING_INVOCATION_MS - 1)).toBe(4000);
    expect(delay(unknownFastPath, MIN_ADVANCING_INVOCATION_MS)).toBe(0);
  });
});

describe("the error backoff is untouched", () => {
  it("backs off exponentially even on a working-looking response", () => {
    // Round 6, Issue 6: fixed-interval retries stacked invocations on a
    // struggling server function. An immediate retry is the exact behaviour
    // that guard was added to remove, so errors must never reach the fast path.
    for (const errors of [1, 2, 3, 4, 8]) {
      expect(delay(working, 12_000, errors), `${errors} errors`).toBe(nextPollDelayMs(errors));
    }
  });

  it("resumes chaining as soon as the streak breaks", () => {
    expect(delay(working, 12_000, 0)).toBe(0);
  });
});
