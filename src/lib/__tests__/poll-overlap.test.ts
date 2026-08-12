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
  it("holds the in-flight flag in a ref, so it survives an effect restart", () => {
    // A local variable would be re-created by the restart and guard nothing.
    expect(page).toMatch(/const pollInFlight = useRef\(false\)/);
    // Declared outside the effect body.
    expect(page.indexOf("const pollInFlight = useRef(false)")).toBeLessThan(
      page.indexOf("// Poll the pipeline server function"),
    );
  });

  it("drops a tick that arrives while a call is outstanding", () => {
    expect(effect).toMatch(/if \(pollInFlight\.current\)/);
    // Dropped, not queued: the tick reschedules and returns without calling.
    const guard = effect.slice(effect.indexOf("if (pollInFlight.current)"));
    const guardBody = guard.slice(0, guard.indexOf("}") + 1);
    expect(guardBody).toMatch(/setTimeout\(tick/);
    expect(guardBody).not.toMatch(/runPoll|pollWithAuthRetry/);
  });

  it("claims the flag before awaiting and releases it on every path", () => {
    const claimAt = effect.indexOf("pollInFlight.current = true");
    const awaitAt = effect.indexOf("await pollWithAuthRetry");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(awaitAt);
    // A `finally`, not a trailing assignment: the missing-project branch
    // returns early, and a flag left set would stop this project polling for
    // the rest of the session.
    expect(effect).toMatch(/\}\s*finally\s*\{\s*[^}]*pollInFlight\.current = false/s);
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

describe("the project query that drives the churn is unchanged", () => {
  it("still refetches every 3s while in progress", () => {
    // This is deliberately NOT the variable being changed. The poll effect no
    // longer cares how often the row is refetched, which is the point.
    expect(page).toMatch(/pollIntervalWhileActive\(query\.state\.data, IN_PROGRESS, 3000\)/);
  });
});
