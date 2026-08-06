/**
 * The pool floor, in its second life.
 *
 * The same number used to gate uploads: "minimum valid keys before replacing
 * pool". That gate went away with the destructive upload, but the risk it aimed
 * at did not. The pool shrinks from keys expiring, being revoked at Pexels, or
 * being deactivated mid-run after repeated 401s and 429s — none of which
 * announce themselves. The first symptom used to be matching failing to find
 * footage on a project that looked healthy everywhere else.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POOL_FLOOR,
  describePoolHealth,
  normalizePoolFloor,
  shouldWarnAboutPool,
} from "../pexels-pool-health";

describe("the floor decides when to warn", () => {
  it("stays quiet at or above the floor", () => {
    for (const active of [5, 6, 20]) {
      const health = describePoolHealth(active, 5);
      expect(health.level).toBe("ok");
      expect(shouldWarnAboutPool(health)).toBe(false);
    }
  });

  it("warns the moment the pool dips below", () => {
    const health = describePoolHealth(4, 5);
    expect(health.level).toBe("low");
    expect(shouldWarnAboutPool(health)).toBe(true);
    expect(health.headline).toContain("4 active Pexels keys");
    expect(health.headline).toContain("floor of 5");
  });

  it("names why keys disappear, so the warning is not read as data loss", () => {
    // "Add more keys" on its own invites the assumption that something deleted
    // them — which is exactly the fear the destructive upload earned.
    const health = describePoolHealth(2, 5);
    expect(health.detail).toMatch(/expire/i);
    expect(health.detail).toMatch(/revoked/i);
    expect(health.detail).toMatch(/failing mid-run/i);
  });
});

describe("an empty pool is an outage, not a warning", () => {
  it("is its own level, distinct from low", () => {
    const empty = describePoolHealth(0, 5);
    expect(empty.level).toBe("empty");
    expect(empty.level).not.toBe(describePoolHealth(1, 5).level);
  });

  it("says matching cannot search Pexels at all", () => {
    const empty = describePoolHealth(0, 5);
    expect(empty.detail).toMatch(/cannot search pexels/i);
  });

  it("is an outage regardless of how low the floor is set", () => {
    // Setting the floor to 1 must not turn "no keys" into "fine".
    expect(describePoolHealth(0, 1).level).toBe("empty");
  });
});

describe("singular and plural read correctly", () => {
  it("says one key, not 1 keys", () => {
    expect(describePoolHealth(1, 5).headline).toContain("1 active Pexels key —");
    expect(describePoolHealth(2, 5).headline).toContain("2 active Pexels keys");
  });
});

describe("the floor value is clamped, not trusted", () => {
  it("falls back to the default for nonsense", () => {
    expect(normalizePoolFloor("not a number")).toBe(DEFAULT_POOL_FLOOR);
    expect(normalizePoolFloor(null)).toBe(DEFAULT_POOL_FLOOR);
    expect(normalizePoolFloor(undefined)).toBe(DEFAULT_POOL_FLOOR);
  });

  it("keeps the field inside a usable range", () => {
    expect(normalizePoolFloor(0)).toBe(1);
    expect(normalizePoolFloor(-4)).toBe(1);
    expect(normalizePoolFloor(500)).toBe(100);
    expect(normalizePoolFloor("7")).toBe(7);
    expect(normalizePoolFloor(7.9)).toBe(7);
  });

  it("survives a floor that was never set", () => {
    // A stored value of null is the first-visit case, not an error.
    const health = describePoolHealth(3, normalizePoolFloor(null));
    expect(health.level).toBe("low");
  });
});
