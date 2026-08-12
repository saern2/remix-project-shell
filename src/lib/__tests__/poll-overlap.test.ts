import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A poll tick must never launch while its predecessor is still running.
 *
 * MEASURED 2026-08-12, three HARs over 46 minutes with four concurrent
 * projects: 31 of 83 pollPipeline launches in a single tab overlapped a
 * still-in-flight predecessor, against a median call of 5.56s and a maximum of
 * 51.9s. The app-server runtime saturated — isAdmin's median went from 856ms
 * with one project open to 5.31s, p90 21.7s — while the pipeline itself
 * performed to spec.
 *
 * TWO INDEPENDENT CAUSES, both fixed here:
 *
 * 1. The effect depended on `project`, a react-query result object. Postgres
 *    trigger trg_projects_updated_at bumps updated_at on every write, matching
 *    writes matching_lock_at / matching_idle_rounds two to three times per
 *    invocation, and the project query refetches every 3000ms while in
 *    progress. So the selected row genuinely changed about every 3s,
 *    structural sharing could not preserve the object identity, and the effect
 *    was torn down and restarted at that rate — starting a fresh poll chain
 *    each time while the previous request kept running, because effect cleanup
 *    cancels the timer but cannot abort an in-flight fetch.
 *
 * 2. Nothing tracked "a call is outstanding" across restarts. The setTimeout
 *    chain only serialises ticks within one effect instance.
 *
 * The guard is the load-bearing half: it holds even if some future dependency
 * starts churning again.
 */

const page = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/projects.$projectId.tsx"),
  "utf8",
);

/** The pipeline poll effect, from its comment to the dependency array. */
const effect = (() => {
  const start = page.indexOf("// Poll the pipeline server function");
  const end = page.indexOf("const fetchMatchingProgress", start);
  return page.slice(start, end);
})();

describe("the pipeline poll cannot overlap itself", () => {
  it("holds the claim in a ref, so it survives an effect restart", () => {
    // A local variable would be re-created by the restart and guard nothing.
    expect(page).toMatch(/const pollInFlight = useRef<number \| null>\(null\)/);
    // Declared outside the effect body.
    expect(page.indexOf("const pollInFlight = useRef<number | null>(null)")).toBeLessThan(
      page.indexOf("// Poll the pipeline server function"),
    );
  });

  it("drops a tick that arrives while a call is outstanding", () => {
    const guardAt = effect.indexOf("if (pollInFlight.current != null && heldFor");
    expect(guardAt).toBeGreaterThan(-1);
    // Dropped, not queued: the tick reschedules and returns without calling.
    const guardBody = effect.slice(guardAt, effect.indexOf("}", guardAt) + 1);
    expect(guardBody).toMatch(/setTimeout\(tick/);
    expect(guardBody).not.toMatch(/runPoll|pollWithAuthRetry/);
  });

  it("claims before awaiting and releases it on every path", () => {
    const claimAt = effect.indexOf("pollInFlight.current = claim");
    const awaitAt = effect.indexOf("await pollWithAuthRetry");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(awaitAt);
    // A `finally`, not a trailing assignment: the missing-project branch
    // returns early, and a claim left set would stop this project polling for
    // the rest of the session.
    expect(effect).toMatch(/\}\s*finally\s*\{[\s\S]*?pollInFlight\.current = null/);
  });

  it("depends on the status string, never on the project object", () => {
    // `project` in the dependency array is what restarted the effect every ~3s.
    const deps = effect.slice(effect.lastIndexOf("}, ["), effect.lastIndexOf("]);") + 3);
    expect(deps).toContain("projectStatus");
    expect(deps).not.toMatch(/(^|[,[\s])project([,\]\s]|$)/);
    expect(deps).not.toMatch(/project\?\.status/);
  });

  it("still stops polling when the project leaves an in-progress status", () => {
    expect(effect).toMatch(/if \(!projectStatus \|\| !IN_PROGRESS\.has\(projectStatus\)\) return/);
  });

  it("keeps the error backoff that stops fixed-interval retries stacking", () => {
    // Round 6, Issue 6. The guard complements this rather than replacing it.
    expect(effect).toMatch(/nextPollDelayMs\(hadError \? consecutiveErrors : 0\)/);
  });
});

/**
 * The guard closes the overlap, and in doing so closes an accidental recovery:
 * before it existed, a request that never settled was harmlessly overtaken by
 * the next poll. Nothing on this path can time out — there is no AbortSignal in
 * auth-retry.browser.ts or polling-state.ts, and browser fetch waits forever —
 * so a permanent claim was reachable, and the loop would spin re-arming timers
 * against a flag that could never clear while the pipeline stopped advancing.
 */
describe("a claim that never releases cannot halt the project", () => {
  it("holds the claim time rather than a boolean, so it can expire", () => {
    expect(page).toMatch(/const pollInFlight = useRef<number \| null>\(null\)/);
    expect(effect).toMatch(/pollInFlight\.current = claim/);
  });

  it("bounds the wait above the measured worst case, not arbitrarily", () => {
    // 51.9s was the slowest pollPipeline observed on 2026-08-12. The bound must
    // sit above it or a merely slow poll gets pre-empted and the overlap
    // returns under exactly the load that motivated the guard.
    const match = page.match(/const STALE_POLL_CLAIM_MS = ([\d_]+)/);
    expect(match).toBeTruthy();
    const ms = Number(match![1].replace(/_/g, ""));
    expect(ms).toBeGreaterThan(51_900);
    expect(ms).toBeLessThanOrEqual(120_000);
  });

  it("proceeds once the claim is stale instead of waiting forever", () => {
    expect(effect).toMatch(/heldFor < STALE_POLL_CLAIM_MS/);
    // The guard returns only while the claim is BOTH present and fresh.
    expect(effect).toMatch(/if \(pollInFlight\.current != null && heldFor < STALE_POLL_CLAIM_MS\)/);
  });

  it("says so when it abandons one, rather than recovering silently", () => {
    // A request that never came back is worth knowing about; silent recovery
    // would hide the condition this bound exists for.
    expect(effect).toMatch(
      /console\.warn\(\s*"\[pipeline-poll\] abandoning a stale in-flight claim"/,
    );
  });

  it("releases only its own claim, so a late straggler cannot reopen the overlap", () => {
    // The abandoned request may still settle afterwards. If its finally cleared
    // the flag unconditionally it would free the claim a newer poll is holding.
    expect(effect).toMatch(/if \(pollInFlight\.current === claim\) pollInFlight\.current = null/);
  });
});

describe("the project query that drives the churn is unchanged", () => {
  it("still refetches every 3s while in progress", () => {
    // This is deliberately NOT the variable being changed. The poll effect no
    // longer cares how often the row is refetched, which is the point.
    expect(page).toMatch(/pollIntervalWhileActive\(query\.state\.data, IN_PROGRESS, 3000\)/);
  });
});
