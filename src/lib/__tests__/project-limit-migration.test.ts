import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260731000003_enforce_two_project_limit.sql"),
  "utf8",
).toLowerCase();

describe("two-project limit migration", () => {
  it("serializes inserts per user before counting all statuses", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("where user_id = new.user_id");
    expect(migration).toContain(") >= 2");
    expect(migration).not.toContain("status =");
  });

  it("uses a stable error and does not delete existing data", () => {
    expect(migration).toContain("project_limit_reached");
    expect(migration).not.toMatch(/delete\s+from\s+public\.projects/);
    expect(migration).not.toMatch(/truncate\s+/);
  });

  it("installs an insert trigger and supporting index", () => {
    expect(migration).toContain("create index if not exists idx_projects_user_id");
    expect(migration).toContain("before insert on public.projects");
  });
});
