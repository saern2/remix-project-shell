import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { decideAuthInvalidation } from "../auth-invalidation";

/**
 * MEASURED 2026-08-12, three HARs, 46 minutes, four concurrent projects:
 * isAdmin 479 calls, accessStatus 489, maintenance 531 — median inter-arrival
 * 2.7-3.4s per focused tab, and total silence while unfocused. The `_initiator`
 * async parent stacks named the path: `visibilityChangedCallback` was the
 * largest single origin of all three, reaching accessStatus through a frame
 * literally called `beforeLoad` (via router.invalidate) and isAdmin/maintenance
 * through `queryFn`+`refetch` under an `invalidate` frame.
 *
 * The chain, each link checked in @supabase/auth-js 2.110.8:
 *   visibilitychange -> visibilityChangedCallback -> _onVisibilityChanged
 *   -> _recoverAndRefresh -> _notifyAllSubscribers('SIGNED_IN')
 * and BroadcastChannel rebroadcasts it to every other tab.
 *
 * So SIGNED_IN fires constantly for a session that never changed, and each one
 * cost a router.invalidate (two round trips: getUser + getAccessGateStatus)
 * plus an unscoped queryClient.invalidateQueries.
 */

const A = "user-aaaa";
const B = "user-bbbb";

/** Feeds a sequence of events through the rule, threading the state. */
function replay(events: Array<{ event: string; userId: string | null }>) {
  let lastUserId: string | null = null;
  let hasHandled = false;
  const acted = { router: 0, queries: 0 };
  for (const step of events) {
    const d = decideAuthInvalidation({ ...step, lastUserId, hasHandled });
    lastUserId = d.nextUserId;
    hasHandled = d.handled;
    if (d.invalidateRouter) acted.router += 1;
    if (d.invalidateQueries) acted.queries += 1;
  }
  return acted;
}

describe("a session that has not changed costs nothing", () => {
  it("ignores a repeated SIGNED_IN for the same user", () => {
    const d = decideAuthInvalidation({
      event: "SIGNED_IN",
      userId: A,
      lastUserId: A,
      hasHandled: true,
    });
    expect(d.invalidateRouter).toBe(false);
    expect(d.invalidateQueries).toBe(false);
  });

  it("survives the measured shape: 200 visibility-driven SIGNED_INs cost zero", () => {
    // One tab becoming visible rebroadcasts to all of them, so this is the
    // per-tab volume seen over 46 minutes.
    const events = [
      { event: "SIGNED_IN", userId: A },
      ...Array.from({ length: 200 }, () => ({ event: "SIGNED_IN", userId: A })),
    ];
    expect(replay(events)).toEqual({ router: 0, queries: 0 });
  });

  it("ignores the events that describe plumbing rather than identity", () => {
    // TOKEN_REFRESHED was already filtered; INITIAL_SESSION and the rest must
    // stay filtered, and must not disturb the remembered identity.
    for (const event of [
      "TOKEN_REFRESHED",
      "INITIAL_SESSION",
      "PASSWORD_RECOVERY",
      "MFA_CHALLENGE_VERIFIED",
    ]) {
      const d = decideAuthInvalidation({ event, userId: B, lastUserId: A, hasHandled: true });
      expect(d.invalidateRouter, event).toBe(false);
      expect(d.invalidateQueries, event).toBe(false);
      expect(d.nextUserId, event).toBe(A);
    }
  });
});

describe("a session that HAS changed still invalidates everything", () => {
  it("reacts when a different user appears", () => {
    const d = decideAuthInvalidation({
      event: "SIGNED_IN",
      userId: B,
      lastUserId: A,
      hasHandled: true,
    });
    expect(d.invalidateRouter).toBe(true);
    // All of it: every cached query belongs to the previous user.
    expect(d.invalidateQueries).toBe(true);
    expect(d.nextUserId).toBe(B);
  });

  it("reacts to a sign-out, without clearing the cache on the way to /auth", () => {
    const d = decideAuthInvalidation({
      event: "SIGNED_OUT",
      userId: null,
      lastUserId: A,
      hasHandled: true,
    });
    // beforeLoad re-runs, fails getUser, and redirects.
    expect(d.invalidateRouter).toBe(true);
    // Unchanged from the original behaviour: clearing here only makes the
    // outgoing screen flicker on its way to the auth page.
    expect(d.invalidateQueries).toBe(false);
  });

  it("reacts to USER_UPDATED even for the same user", () => {
    // Role or approval status can change under a user without the id changing,
    // and both isAdmin and the access gate depend on them.
    const d = decideAuthInvalidation({
      event: "USER_UPDATED",
      userId: A,
      lastUserId: A,
      hasHandled: true,
    });
    expect(d.invalidateRouter).toBe(true);
    expect(d.invalidateQueries).toBe(true);
  });

  it("does not miss an account switch that happens in another tab", () => {
    // BroadcastChannel delivers the other tab's SIGNED_IN here. A -> B must be
    // caught, or this tab keeps showing the previous account's data.
    expect(
      replay([
        { event: "SIGNED_IN", userId: A },
        { event: "SIGNED_IN", userId: A },
        { event: "SIGNED_IN", userId: B },
      ]),
    ).toEqual({ router: 1, queries: 1 });
  });

  it("catches sign-out then sign-in as a different user", () => {
    expect(
      replay([
        { event: "SIGNED_IN", userId: A },
        { event: "SIGNED_OUT", userId: null },
        { event: "SIGNED_IN", userId: B },
      ]),
    ).toEqual({ router: 2, queries: 1 });
  });
});

describe("the first event only records who we are", () => {
  it("does nothing on the very first actionable event", () => {
    // The route tree was just built from this same session; a genuine first
    // sign-in navigates on its own, which runs beforeLoad anyway.
    const d = decideAuthInvalidation({
      event: "SIGNED_IN",
      userId: A,
      lastUserId: null,
      hasHandled: false,
    });
    expect(d.invalidateRouter).toBe(false);
    expect(d.invalidateQueries).toBe(false);
    // But it remembers, so the NEXT event can be compared against it.
    expect(d.nextUserId).toBe(A);
    expect(d.handled).toBe(true);
  });

  it("still catches a switch immediately after that first event", () => {
    expect(
      replay([
        { event: "SIGNED_IN", userId: A },
        { event: "SIGNED_IN", userId: B },
      ]),
    ).toEqual({ router: 1, queries: 1 });
  });

  it("a non-actionable event does not consume the first-event allowance", () => {
    const d = decideAuthInvalidation({
      event: "TOKEN_REFRESHED",
      userId: A,
      lastUserId: null,
      hasHandled: false,
    });
    expect(d.handled).toBe(false);
  });
});

describe("the component delegates rather than restating the rule", () => {
  const root = readFileSync(resolve(process.cwd(), "src/routes/__root.tsx"), "utf8");

  it("calls the shared decision and acts only on what it returns", () => {
    expect(root).toMatch(/decideAuthInvalidation\(/);
    expect(root).toMatch(/if \(decision\.invalidateRouter\) router\.invalidate\(\)/);
    expect(root).toMatch(/if \(decision\.invalidateQueries\) queryClient\.invalidateQueries\(\)/);
  });

  it("no longer invalidates unconditionally on every actionable event", () => {
    // Scoped to the auth handler: ErrorComponent's "Try again" button calls
    // router.invalidate() too, legitimately, and a whole-file match caught it.
    const handler = root.slice(
      root.indexOf("supabase.auth.onAuthStateChange"),
      root.indexOf("return () => data.subscription.unsubscribe()"),
    );
    expect(handler.length).toBeGreaterThan(0);
    // The shape that produced ~1,500 calls in 40 minutes: act first, ask never.
    expect(handler).not.toMatch(/^\s*router\.invalidate\(\);\s*$/m);
    expect(handler).not.toMatch(/if \(event !== "SIGNED_OUT"\) queryClient\.invalidateQueries\(\)/);
    // Every invalidation in here is now behind the decision.
    for (const call of handler.match(/(router\.invalidate|queryClient\.invalidateQueries)\(\)/g) ??
      []) {
      expect(handler).toMatch(
        new RegExp(`if \\(decision\\.\\w+\\) ${call.replace(/[.()]/g, "\\$&")}`),
      );
    }
  });

  it("keeps the identity memory across events", () => {
    expect(root).toMatch(/lastUserId\.current = decision\.nextUserId/);
    expect(root).toMatch(/hasHandledAuthEvent\.current = decision\.handled/);
  });
});
