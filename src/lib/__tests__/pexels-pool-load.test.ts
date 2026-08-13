/**
 * Which rows of pexels_api_keys become usable keys.
 *
 * THE DEFECT THIS FILE EXISTS FOR, measured 2026-08-13 against production:
 * 39 rows, 34 active, every one healthy — minimum 14,933 requests remaining,
 * none carrying an error — and the pool loaded ZERO of them.
 *
 * The predicate opened with `if (reset_at > now) return false`, reading a
 * future reset date as "exhausted". It means the opposite: Pexels reports the
 * END OF THE CURRENT QUOTA WINDOW, roughly a month ahead for a monthly quota.
 * And markKeyUsed writes that header back after every SUCCESSFUL response — so
 * a key disqualified itself the first time it worked, and stayed out until its
 * window rolled over. Adding keys could not fix it.
 *
 * It was invisible for eleven days because every symptom is an empty result
 * set, which is the expected outcome for ~65% of stock searches. provider_usage
 * dates the decay from 2026-08-02, the day the predicate shipped.
 *
 * This path had no test coverage at all. That is why these are here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  api_key: string;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: string | null;
};

const { db } = vi.hoisted(() => ({ db: { rows: [] as Row[], activeFilter: null as boolean | null } }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const builder = {
        select: () => builder,
        eq: (column: string, value: boolean) => {
          if (column === "is_active") db.activeFilter = value;
          return builder;
        },
        then: (resolve: (value: { data: Row[]; error: null }) => void) =>
          resolve({ data: db.rows, error: null }),
      };
      return builder;
    },
  },
}));

const A_MONTH_AHEAD = "2026-09-11T01:27:56+00:00";
const LAST_MONTH = "2026-07-11T01:27:56+00:00";

const key = (id: string, remaining: number | null, resetAt: string | null): Row => ({
  id,
  api_key: `secret-${id}`,
  rate_limit_remaining: remaining,
  rate_limit_reset_at: resetAt,
});

async function loadPool() {
  const { createStockSearchSession, invalidatePexelsPoolSnapshot } = await import("../stock.server");
  // The 45s snapshot would otherwise serve the previous test's answer.
  invalidatePexelsPoolSnapshot();
  const session = await createStockSearchSession();
  return session.pexelsPool;
}

beforeEach(() => {
  db.rows = [];
  db.activeFilter = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T19:19:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  const { invalidatePexelsPoolSnapshot } = await import("../stock.server");
  invalidatePexelsPoolSnapshot();
});

describe("a healthy key is usable", () => {
  it("loads the exact shape that production had when the pool went empty", async () => {
    // is_active, ~24,988 remaining, reset a month out. 34 rows of this loaded
    // as zero keys. If this test fails, Pexels is dead again.
    db.rows = [key("k1", 24988, A_MONTH_AHEAD)];
    const pool = await loadPool();
    expect(pool.keys.map((k) => k.id)).toEqual(["k1"]);
  });

  it("loads all of them, not just the first", async () => {
    db.rows = [
      key("k1", 24988, A_MONTH_AHEAD),
      key("k2", 14933, "2026-08-17T11:46:03+00:00"),
      key("k3", 20511, "2026-09-02T16:58:49+00:00"),
    ];
    const pool = await loadPool();
    expect(pool.keys).toHaveLength(3);
    expect(pool.initialCount).toBe(3);
  });

  it("loads a key that has never been used", async () => {
    db.rows = [key("fresh", null, null)];
    expect((await loadPool()).keys.map((k) => k.id)).toEqual(["fresh"]);
  });

  it("only ever considers active rows", async () => {
    db.rows = [key("k1", 24988, A_MONTH_AHEAD)];
    await loadPool();
    // The 401-rejected keys markKeyDead deactivates must not come back.
    expect(db.activeFilter).toBe(true);
  });
});

describe("a spent key waits for its window, and only a spent key", () => {
  it("excludes a key with nothing left and a window still open", async () => {
    db.rows = [key("spent", 0, A_MONTH_AHEAD)];
    expect((await loadPool()).keys).toHaveLength(0);
  });

  it("readmits it once the window has rolled over", async () => {
    db.rows = [key("rolled", 0, LAST_MONTH)];
    expect((await loadPool()).keys.map((k) => k.id)).toEqual(["rolled"]);
  });

  it("tries a spent key with no reset date rather than dropping it forever", async () => {
    // One request either succeeds or 429s, and markKeyRateLimited then writes a
    // real reset. Excluding it permanently is the defect this file documents.
    db.rows = [key("unknown-window", 0, null)];
    expect((await loadPool()).keys.map((k) => k.id)).toEqual(["unknown-window"]);
  });

  it("keeps the healthy keys when only some are spent", async () => {
    db.rows = [
      key("spent", 1, A_MONTH_AHEAD),
      key("healthy", 24988, A_MONTH_AHEAD),
      key("fresh", null, null),
    ];
    expect((await loadPool()).keys.map((k) => k.id).sort()).toEqual(["fresh", "healthy"]);
  });
});

describe("the pool says whether it is empty by configuration or by exhaustion", () => {
  it("is configured when rows exist, so the env fallback stays out of the way", async () => {
    db.rows = [key("spent", 0, A_MONTH_AHEAD)];
    const pool = await loadPool();
    expect(pool.configured).toBe(true);
    expect(pool.keys).toHaveLength(0);
  });

  it("reports an empty configured pool through the profile, not just a log line", async () => {
    // The absence of a counter is what surfaced this defect after eleven days.
    // An absence is a terrible alarm; this is the presence of one.
    db.rows = [key("spent", 0, A_MONTH_AHEAD)];
    const { createMatchingProfile } = await import("../matching-profile");
    const { pexelsProvider, createStockSearchSession, invalidatePexelsPoolSnapshot } = await import(
      "../stock.server"
    );
    invalidatePexelsPoolSnapshot();
    const profile = createMatchingProfile();
    const session = await createStockSearchSession(profile);

    const results = await pexelsProvider.search("aurora", "landscape", 1, session);

    expect(results).toEqual([]);
    expect(profile.summary().pexelsPoolEmpty).toBe(1);
    // And no request was attempted, which is why providerSearchPexelsMs reads 0.
    expect(profile.summary().pexelsRequests).toBeUndefined();
  });
});
