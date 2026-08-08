/**
 * A token that expires mid-poll must not look like a failure.
 *
 * MEASURED. At 07:31:56 three open tabs simultaneously showed
 * "Unauthorized: No authorization header provided" from pollRenderJob. The
 * session had expired while several tabs polled every few seconds; refresh
 * succeeded (2 refreshes, 0 failures) and polling resumed by itself. Nothing
 * broke — the only damage was the red toast.
 *
 * The rule these pin, which is the same rule the 404-after-cancel fix
 * established: report nothing until recovery has been tried and failed.
 *
 * The dangerous direction is over-retrying. A real refusal — "Forbidden.", or a
 * blocked action during maintenance — must still surface at once, or a user
 * sits watching a button that silently does nothing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isRecoverableAuthError,
  PROACTIVE_REFRESH_WINDOW_SECONDS,
  shouldRefreshAhead,
  withAuthRetry,
} from "../auth-retry";

describe("what counts as a recoverable auth error", () => {
  it("recognises the message the run actually produced", () => {
    expect(isRecoverableAuthError(new Error("Unauthorized: No authorization header provided"))).toBe(
      true,
    );
  });

  it("recognises the other ways a stale token is reported", () => {
    for (const message of [
      "Unauthorized: No token provided",
      "Unauthorized: Invalid token",
      "JWT expired",
      "token is expired",
      "Your session has expired",
      "bad_jwt",
    ]) {
      expect(isRecoverableAuthError(new Error(message)), message).toBe(true);
    }
  });

  it("does NOT swallow a real refusal", () => {
    // The whole reason this is an allowlist of recoverable phrasings rather
    // than a match on "unauthorized". Retrying these silently would hide a
    // genuine no behind a spinner.
    for (const message of [
      "Forbidden.",
      "Project not found.",
      "Starting a render is paused while the platform is being updated.",
      "Unauthorized: Only Bearer tokens are supported",
      "The render worker could not be reached (HTTP 502).",
    ]) {
      expect(isRecoverableAuthError(new Error(message)), message).toBe(false);
    }
  });

  it("survives non-Error rejections", () => {
    expect(isRecoverableAuthError("JWT expired")).toBe(true);
    expect(isRecoverableAuthError({ message: "Invalid token" })).toBe(true);
    expect(isRecoverableAuthError(null)).toBe(false);
    expect(isRecoverableAuthError(undefined)).toBe(false);
    expect(isRecoverableAuthError({})).toBe(false);
    expect(isRecoverableAuthError(42)).toBe(false);
  });
});

describe("the retry recovers silently, exactly once", () => {
  it("refreshes and succeeds without the caller ever seeing an error", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const run = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Unauthorized: No authorization header provided");
      return { status: "rendering" };
    });

    const result = await withAuthRetry(run, { refresh });

    expect(result).toEqual({ status: "rendering" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("surfaces the error when the retry fails too", async () => {
    // One silent recovery, then the truth. A session that is genuinely gone has
    // to become visible.
    const refresh = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error("Unauthorized: Invalid token"));

    await expect(withAuthRetry(run, { refresh })).rejects.toThrow(/Invalid token/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never retries more than once", async () => {
    // A loop would turn a revoked session into an invisible hammer on the auth
    // endpoint.
    const refresh = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error("JWT expired"));

    await expect(withAuthRetry(run, { refresh })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not retry, or refresh, a non-auth error", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error("Forbidden."));

    await expect(withAuthRetry(run, { refresh })).rejects.toThrow("Forbidden.");
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports the original error, not the refresh failure", async () => {
    // "Refresh failed" describes our plumbing; the user's situation is that
    // their session ended.
    const refresh = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const run = vi.fn().mockRejectedValue(new Error("JWT expired"));

    await expect(withAuthRetry(run, { refresh })).rejects.toThrow(/JWT expired/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes a successful call straight through", async () => {
    const refresh = vi.fn();
    const run = vi.fn().mockResolvedValue("ok");

    expect(await withAuthRetry(run, { refresh })).toBe("ok");
    expect(refresh).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("refreshing ahead of expiry", () => {
  const NOW_MS = 1_760_000_000_000;
  const nowSeconds = Math.floor(NOW_MS / 1000);

  it("refreshes when the token expires inside the window", () => {
    expect(shouldRefreshAhead(nowSeconds + 60, nowSeconds)).toBe(true);
    expect(shouldRefreshAhead(nowSeconds, nowSeconds)).toBe(true);
    // Already expired: still worth refreshing before trying.
    expect(shouldRefreshAhead(nowSeconds - 300, nowSeconds)).toBe(true);
  });

  it("leaves a healthy token alone", () => {
    expect(shouldRefreshAhead(nowSeconds + PROACTIVE_REFRESH_WINDOW_SECONDS + 1, nowSeconds)).toBe(
      false,
    );
    expect(shouldRefreshAhead(nowSeconds + 3600, nowSeconds)).toBe(false);
  });

  it("does nothing when expiry is unknown", () => {
    expect(shouldRefreshAhead(null, nowSeconds)).toBe(false);
    expect(shouldRefreshAhead(undefined, nowSeconds)).toBe(false);
    expect(shouldRefreshAhead(Number.NaN, nowSeconds)).toBe(false);
  });

  it("turns the common case into no failure at all", async () => {
    // The window exceeds the poll interval plus a slow request, so the token in
    // flight is still valid when it lands. The retry above is the safety net
    // for what this misses — a laptop waking with a long-dead token.
    const refresh = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue("ok");

    await withAuthRetry(run, {
      refresh,
      getExpiresAt: async () => nowSeconds + 30,
      now: () => NOW_MS,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still makes the call when the pre-emptive refresh fails", async () => {
    // Refreshing ahead is an optimisation; the current token may well work.
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const run = vi.fn().mockResolvedValue("ok");

    expect(
      await withAuthRetry(run, {
        refresh,
        getExpiresAt: async () => nowSeconds + 30,
        now: () => NOW_MS,
      }),
    ).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tolerates an unreadable session", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue("ok");

    expect(
      await withAuthRetry(run, {
        refresh,
        getExpiresAt: async () => {
          throw new Error("no storage");
        },
        now: () => NOW_MS,
      }),
    ).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("every polling call site is covered", () => {
  // The failure hit three tabs at once because they all poll on the same
  // expiring session. Fixing one and not the others would have left the same
  // red toast coming from a different component.
  const read = (p: string) =>
    require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), p), "utf8");

  it("wraps the render poll, the pipeline poll and the progress reader", () => {
    const page = read("src/routes/_authenticated/projects.$projectId.tsx");
    expect(page).toMatch(/pollWithAuthRetry\(\(\) =>\s*runPollRender/);
    expect(page).toMatch(/pollWithAuthRetry\(\(\) => runPoll\(/);
    expect(page).toMatch(/pollWithAuthRetry\(\(\) => fetchMatchingProgress/);
    // Both render-poll sites, not just the loop: the one-shot re-sign polls the
    // same server function on the same session.
    expect(page.match(/pollWithAuthRetry\(\(\) =>\s*runPollRender/g)?.length).toBe(2);
  });

  it("wraps the dashboard progress reader", () => {
    expect(read("src/components/project-overview.tsx")).toMatch(
      /pollWithAuthRetry\(\(\) => fetchMatchingProgress/,
    );
  });

  it("wraps the maintenance pollers, which run on a timer too", () => {
    for (const file of [
      "src/components/maintenance-banner.tsx",
      "src/components/maintenance-panel.tsx",
    ]) {
      expect(read(file), file).toMatch(/pollWithAuthRetry\(\(\) => fetchState\(\)\)/);
    }
  });

  it("leaves one-shot user actions alone", () => {
    // Retrying a click silently is a different decision with different risks —
    // a double-submitted render, for instance. This change is about polling.
    const page = read("src/routes/_authenticated/projects.$projectId.tsx");
    expect(page).not.toMatch(/pollWithAuthRetry\(\(\) => runSwap/);
    expect(page).not.toMatch(/pollWithAuthRetry\(\(\) => runSubmit/);
  });
});
