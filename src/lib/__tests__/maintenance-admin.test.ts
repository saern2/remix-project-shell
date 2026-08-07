/**
 * The admin surface for maintenance mode.
 *
 * These pin the parts an operator depends on being true when they are already
 * under pressure: that only an admin can toggle it, that the toggle reaches the
 * worker and says so when it does not, and that the dashboard never shows a
 * switch that quietly disagrees with reality.
 *
 * Source-level where the behaviour lives in wiring rather than in a value —
 * these paths need a session, a database and a live worker, and a mock of all
 * three would only pin my idea of them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const fns = read("src/lib/maintenance.functions.ts");
const panel = read("src/components/maintenance-panel.tsx");
const banner = read("src/components/maintenance-banner.tsx");
const migration = read("supabase/migrations/20260810000001_maintenance_mode.sql");

describe("only admins can toggle it", () => {
  it("checks the role server-side before writing", () => {
    const handler = fns.slice(fns.indexOf("export const setMaintenanceState"));
    expect(handler).toMatch(/if \(!\(await isAdminUser\(context\.userId\)\)\) throw new Error\("Forbidden\."\)/);
    // ...and the check precedes the write, not the other way round.
    expect(handler.indexOf("isAdminUser")).toBeLessThan(handler.indexOf('.from("maintenance_state")'));
  });

  it("grants no write to authenticated at all, so no policy can go wrong", () => {
    // The write path is one auditable server function. An RLS policy allowing
    // admin writes would be a second one that has to stay in step with it.
    expect(migration).toMatch(/grant select on public\.maintenance_state to authenticated/);
    expect(migration).not.toMatch(/grant .*(insert|update|delete).* to authenticated/);
  });

  it("lets any signed-in user READ it, because refusals have to explain themselves", () => {
    expect(migration).toMatch(/for select to authenticated using \(true\)/);
  });

  it("withholds operational detail from non-admins", () => {
    // Which projects are frozen and how many are rendering is not theirs.
    const handler = fns.slice(fns.indexOf("export const getMaintenanceState"));
    expect(handler).toMatch(/if \(!viewerIsAdmin\)/);
    expect(handler).toMatch(/frozenProjects: \[\]/);
  });
});

describe("the state is one row and cannot become ambiguous", () => {
  it("pins the singleton with a primary key and a check", () => {
    // No ordering, no "most recent", no possibility of two rows disagreeing
    // about whether the platform is frozen.
    expect(migration).toMatch(/id boolean primary key default true/);
    expect(migration).toMatch(/constraint maintenance_state_singleton check \(id is true\)/);
    expect(migration).toMatch(/on conflict \(id\) do nothing/);
  });

  it("is idempotent", () => {
    expect(migration).toMatch(/create table if not exists/);
    expect(migration).toMatch(/drop policy if exists/);
  });

  it("is in catch-up.sql and the boot schema check", () => {
    expect(read("supabase/catch-up.sql")).toMatch(/create table if not exists public\.maintenance_state/);
    expect(read("src/lib/schema-check.server.ts")).toMatch(/table: "maintenance_state"/);
  });
});

describe("the worker gets the flag too", () => {
  it("pushes it after the database write", () => {
    const handler = fns.slice(fns.indexOf("export const setMaintenanceState"));
    expect(handler.indexOf('.from("maintenance_state")')).toBeLessThan(
      handler.indexOf("pushWorkerState"),
    );
  });

  it("reports a failed push instead of a success toast", () => {
    // A half-applied freeze — users blocked while the worker keeps rendering —
    // is the worst of both outcomes and must not hide behind "Saved".
    expect(fns).toMatch(/workerSynced: pushed\.ok/);
    expect(panel).toMatch(/if \(!result\.workerSynced\)/);
    expect(panel).toMatch(/toast\.warning/);
    expect(panel).toMatch(/MAINTENANCE_MODE/);
  });

  it("never lets an unreachable worker break the page or the toggle", () => {
    // The worker may be the thing being deployed. Reading its state is
    // best-effort by construction.
    expect(fns).toMatch(/async function readWorkerState[\s\S]*?catch \{[\s\S]*?return \{ frozen: \[\], rendering: null, queued: null \}/);
    expect(fns).toMatch(/AbortSignal\.timeout/);
  });
});

describe("the operator is never surprised", () => {
  it("confirms before freezing, naming what will be interrupted", () => {
    expect(panel).toMatch(/AlertDialog/);
    expect(panel).toMatch(/describeFreezeImpact/);
    expect(panel).toMatch(/Turn maintenance mode on\?/);
  });

  it("says when the env var is overriding the toggle", () => {
    // Otherwise the switch sits in a position that does not match reality and
    // nothing on screen admits it.
    expect(panel).toMatch(/data\.overridden/);
    expect(panel).toMatch(/overriding this toggle/);
  });

  it("lists frozen projects so one that never resumes is visible", () => {
    expect(panel).toMatch(/data\.frozenProjects\.map/);
    expect(panel).toMatch(/segment \{project\.chunkIndex \+ 1\}/);
  });

  it("keeps the message box from being wiped by a background refetch", () => {
    // The panel refetches every 10s; a controlled input bound straight to the
    // query would erase what the operator is part-way through typing.
    expect(panel).toMatch(/const messageValue = message \?\? data\.message \?\? ""/);
  });
});

describe("the banner is unmissable", () => {
  it("lives in the shell, not on one page", () => {
    // The admin failure mode is forgetting it is on. A notice you can navigate
    // away from does not prevent that.
    expect(read("src/components/app-shell.tsx")).toMatch(/<MaintenanceBanner \/>/);
  });

  it("renders nothing at all when maintenance is off", () => {
    expect(banner).toMatch(/if \(!data\?\.enabled\) return null/);
  });

  it("warns admins and merely informs everyone else", () => {
    // For an admin it is a warning; for a user nothing is wrong, and the
    // styling should not imply otherwise.
    expect(banner).toMatch(/isAdmin[\s\S]{0,200}amber/);
    expect(banner).toMatch(/describeMaintenanceNotice/);
  });
});
