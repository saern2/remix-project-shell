/**
 * What an auth state change should actually invalidate.
 *
 * SIGNED_IN does not mean "somebody signed in". auth-js emits it whenever a
 * session is re-established — including from `_recoverAndRefresh` on every
 * `visibilitychange`, via `_onVisibilityChanged` — and rebroadcasts other tabs'
 * events over a BroadcastChannel, so one tab becoming visible fires the handler
 * in all of them.
 *
 * MEASURED 2026-08-12, three HARs, 46 minutes, four concurrent projects:
 * isAdmin 479 calls, accessStatus 489, maintenance 531, with `visibilityChanged`
 * -> SIGNED_IN the single largest identified origin of all three. Each event ran
 * both invalidations: `router.invalidate()`, which re-runs the _authenticated
 * `beforeLoad` and costs two round trips (`supabase.auth.getUser()` plus
 * `getAccessGateStatus()`), and an unscoped `queryClient.invalidateQueries()`,
 * which refetches every mounted query including am-i-admin and maintenance-state.
 *
 * The corroborating capture came from the other direction: one tab, no tab
 * switching, therefore no visibility events — and the same three endpoints
 * collapsed to 1 call, 3 calls, and maintenance's own 22s timer.
 *
 * Pure, so the rule is testable without a router, a Supabase client or a
 * browser — the same reason render-retry.ts and polling-state.ts are separate.
 */

export type AuthInvalidationEvent = string;

export type AuthInvalidationDecision = {
  /** Re-run beforeLoad. Two network round trips; only when identity changed. */
  invalidateRouter: boolean;
  /** Drop every cached query. Only when the cache belongs to someone else. */
  invalidateQueries: boolean;
  /** Identity to remember for the next event. */
  nextUserId: string | null;
  /** Whether this tab has now handled at least one event. */
  handled: boolean;
};

const ACTIONABLE = new Set(["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"]);

const NOTHING = (nextUserId: string | null, handled: boolean): AuthInvalidationDecision => ({
  invalidateRouter: false,
  invalidateQueries: false,
  nextUserId,
  handled,
});

/**
 * @param event        The auth-js event name.
 * @param userId       User id carried by the event's session, null when absent.
 * @param lastUserId   Identity this tab last reacted to.
 * @param hasHandled   Whether this tab has reacted to any event yet.
 */
export function decideAuthInvalidation({
  event,
  userId,
  lastUserId,
  hasHandled,
}: {
  event: AuthInvalidationEvent;
  userId: string | null;
  lastUserId: string | null;
  hasHandled: boolean;
}): AuthInvalidationDecision {
  // TOKEN_REFRESHED, INITIAL_SESSION, PASSWORD_RECOVERY and the rest describe
  // the session's plumbing, not who is using the app.
  if (!ACTIONABLE.has(event)) return NOTHING(lastUserId, hasHandled);

  // The first event only records who we are. The route tree was just built from
  // this same session, so there is nothing to refresh — and a genuine first
  // sign-in navigates on its own, which runs beforeLoad anyway.
  if (!hasHandled) return NOTHING(userId, true);

  const identityChanged = lastUserId !== userId;

  // A SIGNED_IN for the SAME user re-affirms the session we are already running
  // on. Skipping it is the whole fix: scoping the query invalidation would
  // still run this handler hundreds of times and merely invalidate fewer keys.
  if (event === "SIGNED_IN" && !identityChanged) return NOTHING(userId, true);

  return {
    invalidateRouter: true,
    // Deliberately all-or-nothing rather than a key list. This now fires only
    // when a DIFFERENT user is present or the profile itself changed, and then
    // every cached query belongs to somebody else or is stale by definition. A
    // maintained list of keys would have to stay in step with every query added
    // anywhere in the app, and one forgotten entry leaks the previous user's
    // data into the new session.
    //
    // Not on SIGNED_OUT: beforeLoad redirects to /auth, and clearing the cache
    // first only makes the outgoing screen flicker on the way there.
    invalidateQueries: event !== "SIGNED_OUT",
    nextUserId: userId,
    handled: true,
  };
}
