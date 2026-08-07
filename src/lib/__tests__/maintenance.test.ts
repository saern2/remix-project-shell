/**
 * Maintenance mode policy.
 *
 * Two properties matter more than the rest, and both are here because getting
 * either wrong is worse than not having the feature:
 *
 *   1. Read-only means read-only. Someone who wants yesterday's video must not
 *      be blocked by a deploy, and someone who tries to start a render must be
 *      refused BY THE SERVER, not by a greyed-out button.
 *   2. The env var is an emergency brake, so it wins in both directions. A
 *      brake that can only be applied and never released is not a brake — the
 *      case it exists for is the one where the dashboard that would turn it off
 *      is itself unreachable.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  READ_ONLY_ACTIONS,
  decideMaintenance,
  describeBlockedAction,
  describeFreezeImpact,
  describeFrozenProject,
  describeMaintenanceNotice,
  parseMaintenanceEnv,
  resolveMaintenanceState,
  type MaintenanceAction,
} from "../maintenance";

const ON = { enabled: true, message: null };
const OFF = { enabled: false, message: null };

const BLOCKED: MaintenanceAction[] = [
  "create_project",
  "upload_audio",
  "start_pipeline",
  "retry_pipeline",
  "swap_clip",
  "start_render",
  "cancel_render",
  "delete_project",
  "admin_action",
];

describe("what a regular user can still do", () => {
  it("allows signing in, browsing and downloading", () => {
    for (const action of READ_ONLY_ACTIONS) {
      const decision = decideMaintenance({ state: ON, action, isAdmin: false });
      expect(decision.allowed, action).toBe(true);
    }
  });

  it("blocks everything that writes", () => {
    for (const action of BLOCKED) {
      const decision = decideMaintenance({ state: ON, action, isAdmin: false });
      expect(decision.allowed, action).toBe(false);
      expect(decision.reason, action).toBeTruthy();
    }
  });

  it("blocks by allowlist, so an action added later is blocked by default", () => {
    // The safe direction to be wrong in: wrongly blocking is an operator
    // noticing during maintenance; wrongly allowing is a write landing
    // mid-migration.
    const invented = "some_future_action" as MaintenanceAction;
    expect(decideMaintenance({ state: ON, action: invented, isAdmin: false }).allowed).toBe(false);
  });

  it("changes nothing at all when maintenance is off", () => {
    for (const action of [...READ_ONLY_ACTIONS, ...BLOCKED]) {
      expect(decideMaintenance({ state: OFF, action, isAdmin: false }).allowed, action).toBe(true);
    }
  });
});

describe("admins bypass entirely", () => {
  it("can do everything a normal user cannot", () => {
    // The operator has to be able to use the platform during maintenance to
    // check the fix actually worked. A maintenance mode that locks out the
    // person doing the maintenance is one nobody turns on.
    for (const action of BLOCKED) {
      expect(decideMaintenance({ state: ON, action, isAdmin: true }).allowed, action).toBe(true);
    }
  });

  it("is told loudly that maintenance is on", () => {
    const notice = describeMaintenanceNotice({
      state: { ...ON, source: "database", overridden: false },
      isAdmin: true,
    });
    expect(notice).not.toBeNull();
    expect(notice!.headline).toMatch(/maintenance mode is on/i);
    // The admin failure mode is forgetting it is on and leaving users frozen
    // out for hours, so their banner says so in those words.
    expect(notice!.detail).toMatch(/read-only|full access/i);
  });

  it("is told when the env var is overriding the dashboard toggle", () => {
    const notice = describeMaintenanceNotice({
      state: { ...ON, source: "env", overridden: true },
      isAdmin: true,
    });
    expect(notice!.detail).toMatch(/MAINTENANCE_MODE/);
    expect(notice!.detail).toMatch(/overrides/i);
  });
});

describe("the env var wins in both directions", () => {
  it("forces ON over a stored flag that says off", () => {
    const state = resolveMaintenanceState({ enabled: false }, true);
    expect(state.enabled).toBe(true);
    expect(state.source).toBe("env");
    expect(state.overridden).toBe(true);
  });

  it("forces OFF over a stored flag that says on", () => {
    const state = resolveMaintenanceState({ enabled: true }, false);
    expect(state.enabled).toBe(false);
    expect(state.source).toBe("env");
    expect(state.overridden).toBe(true);
    // The stored value is still reported, so the dashboard can show the toggle
    // in its real position while saying it is being overridden.
    expect(state.storedEnabled).toBe(true);
  });

  it("stands aside when unset", () => {
    const state = resolveMaintenanceState({ enabled: true }, null);
    expect(state.enabled).toBe(true);
    expect(state.source).toBe("database");
    expect(state.overridden).toBe(false);
  });

  it("parses the values an operator would actually type", () => {
    for (const yes of ["1", "true", "TRUE", "on", "yes", "enabled"]) {
      expect(parseMaintenanceEnv(yes), yes).toBe(true);
    }
    for (const no of ["0", "false", "FALSE", "off", "no", "disabled"]) {
      expect(parseMaintenanceEnv(no), no).toBe(false);
    }
    expect(parseMaintenanceEnv(undefined)).toBeNull();
    expect(parseMaintenanceEnv("")).toBeNull();
    expect(parseMaintenanceEnv("   ")).toBeNull();
    // Not a licence to guess: a malformed brake reads as "the operator meant to
    // pull it".
    expect(parseMaintenanceEnv("banana")).toBe(true);
  });

  it("agrees with the worker's copy of the same rule", () => {
    // Two processes, one precedence rule. If these drift, the app and the
    // worker disagree about whether the platform is frozen, which is worse than
    // either answer.
    const worker = readFileSync(
      resolve(process.cwd(), "render-worker/src/maintenance.js"),
      "utf8",
    );
    for (const value of ["1", "true", "on", "yes", "enabled"]) {
      expect(worker).toContain(`'${value}'`);
    }
    for (const value of ["0", "false", "off", "no", "disabled"]) {
      expect(worker).toContain(`'${value}'`);
    }
  });
});

describe("a blocked action explains itself", () => {
  it("names what is paused and says nothing was lost", () => {
    const message = describeBlockedAction("start_render", null);
    expect(message).toMatch(/render/i);
    expect(message).toMatch(/nothing has been lost/i);
    // Not an error. Nothing has gone wrong and the words must not suggest it has.
    expect(message).not.toMatch(/error|failed|invalid|forbidden/i);
  });

  it("includes the operator's estimate when there is one", () => {
    expect(describeBlockedAction("create_project", "Back at 3pm")).toContain("Back at 3pm");
  });

  it("gives no estimate when the message is blank", () => {
    const message = describeBlockedAction("create_project", null);
    expect(message).not.toMatch(/back at|until/i);
  });
});

describe("what a user with a frozen project sees", () => {
  it("says it is safe and shows how far it got", () => {
    // "Paused" without a position is indistinguishable from "stuck" — the same
    // confusion that made a working 90%-complete project look broken twice.
    const text = describeFrozenProject({ chunksCompleted: 30, chunksTotal: 51 });
    expect(text).toMatch(/safe/i);
    expect(text).toMatch(/continue automatically/i);
    expect(text).toContain("30 of 51");
  });

  it("still reassures when the position is unknown", () => {
    const text = describeFrozenProject({ chunksCompleted: null, chunksTotal: null });
    expect(text).toMatch(/safe/i);
    expect(text).not.toMatch(/\bof\b \d/);
  });
});

describe("the confirmation before freezing", () => {
  it("names what is about to be interrupted", () => {
    const text = describeFreezeImpact({ rendering: 3, matching: 2 });
    expect(text).toContain("3 projects rendering");
    expect(text).toContain("2 matching");
    // And promises the thing the operator is actually worried about.
    expect(text).toMatch(/resume from the segment/i);
  });

  it("says so plainly when nothing is running", () => {
    expect(describeFreezeImpact({ rendering: 0, matching: 0 })).toMatch(/nothing is running/i);
  });

  it("gets the singular right", () => {
    expect(describeFreezeImpact({ rendering: 1, matching: 0 })).toContain("1 project rendering");
  });
});

describe("enforcement is server-side, not decoration", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("guards every mutating server function", () => {
    // A hidden button is not a permission. Each of these must reject a direct
    // call even when the UI would never have offered it.
    const pipeline = read("src/lib/pipeline.functions.ts");
    const render = read("src/lib/render.functions.ts");
    const del = read("src/lib/deleteProject.ts");

    expect(pipeline).toMatch(/assertMaintenanceAllows\("start_pipeline", userId\)/);
    expect(pipeline).toMatch(/assertMaintenanceAllows\("swap_clip", userId\)/);
    expect(render).toMatch(/assertMaintenanceAllows\("start_render", userId\)/);
    expect(render).toMatch(/assertMaintenanceAllows\("cancel_render", userId\)/);
    expect(del).toMatch(/assertMaintenanceAllows\("delete_project", userId\)/);
  });

  it("freezes matching by returning early, before the lock and the idle counter", () => {
    // Matching advances only while a page polls, so returning IS the freeze.
    // It must happen before advanceFromMatchingFootage or a frozen project
    // would accumulate idle rounds and be killed by the watchdog for failing to
    // progress while it was forbidden to.
    const pipeline = read("src/lib/pipeline.functions.ts");
    const guardAt = pipeline.indexOf("paused_for_maintenance: true");
    const advanceAt = pipeline.indexOf('if (project.status === "matching_footage")');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(advanceAt);
  });

  it("does not throw from the poll path, which would become a toast storm", () => {
    const pipeline = read("src/lib/pipeline.functions.ts");
    const block = pipeline.slice(
      pipeline.indexOf("const maintenance = await readMaintenanceState();"),
      pipeline.indexOf('if (project.status === "transcribing")'),
    );
    expect(block).toMatch(/return \{/);
    expect(block).not.toMatch(/throw/);
  });

  it("verifies admin against the database rather than trusting the session", () => {
    const server = read("src/lib/maintenance.server.ts");
    expect(server).toMatch(/from\("users"\)[\s\S]{0,120}select\("role"\)/);
  });

  it("fails OPEN on the flag and CLOSED on the admin check", () => {
    // Opposite defaults on purpose: an unreadable flag must not freeze the
    // platform, but an unverifiable admin claim must not become a bypass.
    const server = read("src/lib/maintenance.server.ts");
    expect(server).toMatch(/FAIL OPEN/);
    expect(server).toMatch(/must not become a bypass/);
  });
});
