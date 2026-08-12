/**
 * The check that would have caught the missing migration.
 *
 * Deployed symptom: every render_jobs poll returned
 * 400 {"code":"42703","message":"column render_jobs.stall_notice does not exist"}
 * and the render page simply never loaded. Nothing server-side said "you are
 * missing a migration" — the only evidence was a 400 loop in a browser console.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { errors: {} as Record<string, { code: string; message: string } | null> },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        limit: async () => ({ data: [], error: state.errors[table] ?? null }),
      }),
    }),
  },
}));

describe("schema check", () => {
  beforeEach(() => {
    state.errors = {};
    vi.resetModules();
    delete process.env.SCHEMA_CHECK;
  });

  it("passes when every required table and column is present", async () => {
    const { findSchemaProblems } = await import("../schema-check.server");
    expect(await findSchemaProblems()).toEqual([]);
  });

  it("reports a missing column, naming the table and the migration that adds it", async () => {
    state.errors["render_jobs"] = {
      code: "42703",
      message: "column render_jobs.stall_notice does not exist",
    };
    const { findSchemaProblems, describeSchemaProblems } = await import("../schema-check.server");

    const problems = await findSchemaProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].table).toBe("render_jobs");

    const described = describeSchemaProblems(problems);
    expect(described).toContain("render_jobs.stall_notice");
    // The operator needs to know what to run, not just what is broken.
    expect(described).toContain("20260805120000_render_job_stall_notice");
    expect(described).toContain("catch-up.sql");
  });

  it("reports a missing table too", async () => {
    state.errors["project_stock_corpus"] = {
      code: "42P01",
      message: 'relation "public.project_stock_corpus" does not exist',
    };
    const { findSchemaProblems } = await import("../schema-check.server");
    const problems = await findSchemaProblems();
    expect(problems.map((p) => p.table)).toEqual(["project_stock_corpus"]);
  });

  it("does not blame a migration for a failure that is not a schema failure", async () => {
    // A bad service key or a network blip must not send an operator off to run
    // migrations that are already applied.
    state.errors["projects"] = { code: "42501", message: "permission denied" };
    const { findSchemaProblems } = await import("../schema-check.server");
    expect(await findSchemaProblems()).toEqual([]);
  });

  it("does not block the app when the privileged schema client is unavailable", async () => {
    vi.doMock("@/integrations/supabase/client.server", () => {
      throw new Error(
        "Missing Supabase environment variable(s): SUPABASE_SERVICE_ROLE_KEY / SB_SERVICE_ROLE_KEY.",
      );
    });
    vi.resetModules();

    const { findSchemaProblems } = await import("../schema-check.server");
    await expect(findSchemaProblems()).resolves.toEqual([]);
    vi.doUnmock("@/integrations/supabase/client.server");
    vi.resetModules();
  });

  it("throws by default so a broken deploy cannot look healthy", async () => {
    state.errors["render_jobs"] = { code: "42703", message: "column ... does not exist" };
    const { runSchemaCheck } = await import("../schema-check.server");
    await expect(runSchemaCheck()).rejects.toThrow(/missing 1 thing/i);
  });

  it("only warns when SCHEMA_CHECK=warn, and skips entirely when off", async () => {
    state.errors["render_jobs"] = { code: "42703", message: "column ... does not exist" };

    process.env.SCHEMA_CHECK = "warn";
    const { runSchemaCheck } = await import("../schema-check.server");
    expect(await runSchemaCheck()).toHaveLength(1);

    process.env.SCHEMA_CHECK = "off";
    expect(await runSchemaCheck()).toEqual([]);
  });
});
