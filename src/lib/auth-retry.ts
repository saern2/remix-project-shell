/**
 * A token that expires mid-poll is a normal event, not a failure.
 *
 * MEASURED. At 07:31:56 three open tabs simultaneously showed
 * "Unauthorized: No authorization header provided" from pollRenderJob. The
 * Supabase session had expired while several tabs polled every few seconds.
 * Refresh succeeded — two refreshes, zero failures — and polling resumed on its
 * own. Nothing broke. The only damage was the red toast.
 *
 * This is the same class of defect as the 404-after-cancel: a routine event
 * rendered as a failure. The rule that follows from both is the same one — the
 * client must not report anything until it knows recovery did not happen.
 *
 * Pure and dependency-injected so the classifier and the retry policy can be
 * tested without a session, a network or a clock. The call sites bind the real
 * Supabase client in auth-retry.browser.ts.
 */

/**
 * Messages that mean "your credentials went stale", as opposed to "you may not
 * do this".
 *
 * Deliberately an allowlist of RECOVERABLE phrasings rather than a catch-all on
 * the word "unauthorized". A genuine permission failure — "Forbidden.", or a
 * blocked action during maintenance — must still surface immediately: retrying
 * it silently would hide a real refusal behind a spinner and leave the user
 * watching a button that does nothing.
 */
const RECOVERABLE_AUTH_PATTERNS: RegExp[] = [
  /no authorization header/i,
  /no token provided/i,
  /invalid token/i,
  /jwt expired/i,
  /token is expired/i,
  /session (?:has )?expired/i,
  /invalid (?:jwt|claim)/i,
  /bad_jwt/i,
];

/** Does this error look like a stale token rather than a real refusal? */
export function isRecoverableAuthError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ((error as { message?: unknown } | null)?.message ?? "");
  if (typeof message !== "string" || message.length === 0) return false;
  return RECOVERABLE_AUTH_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * How close to expiry a token has to be before we refresh ahead of the call.
 *
 * Two minutes comfortably exceeds the poll interval plus a slow request, so the
 * token in flight is still valid when it lands. Refreshing ahead is what turns
 * the common case from "fail, recover, retry" into "no failure at all" — the
 * retry below is the safety net for the times this misses, such as a laptop
 * waking from sleep with a long-dead token.
 */
export const PROACTIVE_REFRESH_WINDOW_SECONDS = 120;

/**
 * Should the session be refreshed before making a call?
 *
 * @param expiresAtSeconds Unix seconds from the session, or null when unknown.
 * @param nowSeconds       Unix seconds now.
 */
export function shouldRefreshAhead(
  expiresAtSeconds: number | null | undefined,
  nowSeconds: number,
): boolean {
  if (expiresAtSeconds == null || !Number.isFinite(expiresAtSeconds)) return false;
  return expiresAtSeconds - nowSeconds <= PROACTIVE_REFRESH_WINDOW_SECONDS;
}

export type AuthRetryDeps = {
  /** Refreshes the session. Rejections are swallowed; the retry decides. */
  refresh: () => Promise<unknown>;
  /** Current session expiry in unix seconds, or null when unknown. */
  getExpiresAt?: () => Promise<number | null>;
  /** Injectable for tests. */
  now?: () => number;
};

/**
 * Runs a call, refreshing the session around a stale token.
 *
 * Retries EXACTLY ONCE, and only for a recoverable auth error. A loop here
 * would turn a genuinely revoked session into an invisible hammer against the
 * auth endpoint, and the second failure is the honest signal that something is
 * actually wrong.
 */
export async function withAuthRetry<T>(run: () => Promise<T>, deps: AuthRetryDeps): Promise<T> {
  const now = deps.now ?? (() => Date.now());

  if (deps.getExpiresAt) {
    try {
      const expiresAt = await deps.getExpiresAt();
      if (shouldRefreshAhead(expiresAt, Math.floor(now() / 1000))) {
        await deps.refresh();
      }
    } catch {
      // Refreshing ahead is an optimisation. If it fails, fall through and let
      // the call itself decide — it may well succeed on the current token.
    }
  }

  try {
    return await run();
  } catch (error) {
    if (!isRecoverableAuthError(error)) throw error;

    try {
      await deps.refresh();
    } catch {
      // Rethrow the ORIGINAL error, not the refresh failure: the user's problem
      // is that their session ended, and "refresh failed" describes our
      // plumbing rather than their situation.
      throw error;
    }

    // If this fails too, it propagates — one silent recovery, then the truth.
    return await run();
  }
}
