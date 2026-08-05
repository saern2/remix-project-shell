/**
 * Administrators are exempt from the two-project limit, in both places that
 * matter.
 *
 * The UI is not the gate — the browser inserts straight into PostgREST, so the
 * trigger has the final word. An exemption in only one of the two would either
 * show an admin a form that the database then rejects, or let the check drift
 * apart silently. Both are asserted here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { oldestProject, PROJECT_LIMIT, projectUsage } from "../project-limit";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260806000001_admin_project_limit_and_cancelled_render_status.sql",
  ),
  "utf8",
).toLowerCase();

describe("admin exemption from the project limit", () => {
  it("exempts admins in the trigger, before any counting", () => {
    expect(migration).toContain("u.role = 'admin'");
    expect(migration).toContain("return new;");
    // The exemption must come before the count, otherwise an admin at the limit
    // still takes the advisory lock and does the work for nothing.
    expect(migration.indexOf("u.role = 'admin'")).toBeLessThan(
      migration.indexOf("pg_advisory_xact_lock"),
    );
  });

  it("keeps enforcing the limit for regular users", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain(") >= 2");
    expect(migration).toContain("project_limit_reached");
  });

  it("reports no limit for an admin and the usual limit for everyone else", () => {
    const admin = projectUsage(7, { isAdmin: true });
    expect(admin.atLimit).toBe(false);
    expect(admin.exempt).toBe(true);

    const user = projectUsage(PROJECT_LIMIT, { isAdmin: false });
    expect(user.atLimit).toBe(true);
    expect(user.exempt).toBe(false);

    // Absent flag means "not an admin" — the safe reading while the query loads.
    expect(projectUsage(PROJECT_LIMIT).atLimit).toBe(true);
  });
});

describe("the project a one-click delete offers", () => {
  it("is the oldest by creation time, not by list order", () => {
    const projects = [
      { id: "b", created_at: "2026-03-01T00:00:00Z" },
      { id: "a", created_at: "2026-01-01T00:00:00Z" },
      { id: "c", created_at: "2026-02-01T00:00:00Z" },
    ];
    expect(oldestProject(projects)?.id).toBe("a");
  });

  it("does not reorder the caller's array", () => {
    const projects = [
      { id: "b", created_at: "2026-03-01T00:00:00Z" },
      { id: "a", created_at: "2026-01-01T00:00:00Z" },
    ];
    oldestProject(projects);
    expect(projects.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("is null when there is nothing to delete", () => {
    expect(oldestProject([])).toBeNull();
  });
});

describe("render_jobs may be cancelled", () => {
  it("widens the status constraint that cancellation was silently violating", () => {
    expect(migration).toContain("render_jobs_status_check");
    expect(migration).toContain("'cancelled'");
  });
});
