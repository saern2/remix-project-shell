/**
 * The catch-up script must actually catch up.
 *
 * A missing migration is invisible until someone opens the page that reads the
 * missing column — that is how render_jobs.stall_notice reached production
 * absent, turning every render poll into a 400. supabase/catch-up.sql is the
 * one-paste remedy, so it has to stay complete as migrations are added: this
 * reads every migration file and asserts the script covers what each one
 * creates.
 *
 * It checks SCHEMA, not data. Migrations that only backfilled or realigned rows
 * are excluded by name below, with the reason, because replaying them would
 * rewrite data the app has legitimately changed since.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");
const catchUp = readFileSync(resolve(process.cwd(), "supabase/catch-up.sql"), "utf8").toLowerCase();

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function sqlOf(file: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, file), "utf8").toLowerCase();
}

const allMigrationSql = migrationFiles.map(sqlOf).join("\n");

/** Every table any migration creates. */
function createdTables(sql: string): string[] {
  const matches = sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)/g);
  return [...matches].map((match) => match[1]);
}

/** Every column any migration adds. */
function addedColumns(sql: string): string[] {
  const matches = sql.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/g);
  return [...matches].map((match) => match[1]);
}

/** Every function any migration defines. */
function definedFunctions(sql: string): string[] {
  const matches = sql.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_]+)/g);
  return [...new Set([...matches].map((match) => match[1]))];
}

describe("supabase/catch-up.sql", () => {
  it("creates every table the migrations create", () => {
    const missing = [...new Set(createdTables(allMigrationSql))].filter(
      (table) => !catchUp.includes(`create table if not exists public.${table}`),
    );
    expect(missing).toEqual([]);
  });

  it("adds every column the migrations add", () => {
    const missing = [...new Set(addedColumns(allMigrationSql))].filter(
      (column) => !catchUp.includes(column),
    );
    expect(missing).toEqual([]);
  });

  it("defines every function the migrations define", () => {
    const missing = definedFunctions(allMigrationSql).filter(
      (fn) => !catchUp.includes(`create or replace function public.${fn}`),
    );
    expect(missing).toEqual([]);
  });

  it("is written to be safe to re-run", () => {
    // Every create must be guarded, and every policy must be dropped before it
    // is recreated — "create policy" has no IF NOT EXISTS form.
    const unguardedTables = catchUp.match(/create\s+table\s+(?!if\s+not\s+exists)/g) ?? [];
    expect(unguardedTables).toEqual([]);

    const unguardedIndexes =
      catchUp.match(/create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)/g) ?? [];
    expect(unguardedIndexes).toEqual([]);

    // Every named policy the script creates must be dropped by that same name
    // first. Counting statements would not catch a create whose drop names a
    // different policy, which is the way this actually goes wrong.
    const created = [...catchUp.matchAll(/create\s+policy\s+"([^"]+)"/g)].map((m) => m[1]);
    const dropped = new Set(
      [...catchUp.matchAll(/drop\s+policy\s+if\s+exists\s+"([^"]+)"/g)].map((m) => m[1]),
    );
    expect(created.filter((name) => !dropped.has(name))).toEqual([]);
  });

  it("confirms every column the operator asked about", () => {
    for (const column of [
      "render_jobs.stall_notice",
      "render_clip_slices.fallback_urls",
      "clip_candidates.fallback_urls",
      "projects.matching_lock_at",
      "nasa_asset_cache.has_captions",
      "project_stock_corpus (table)",
    ]) {
      // Each appears in the verification query at the end of the script.
      expect(catchUp).toContain(column.toLowerCase());
    }
  });

  it("does not replay one-time data repairs", () => {
    // These migrations only rewrote existing rows. Re-running them against data
    // the app has since updated would undo that work.
    expect(catchUp).not.toContain("with ranked as");
    expect(catchUp).not.toContain("with scene_spans as");
    expect(catchUp).not.toMatch(/set\s+status\s*=\s*'revoked'/);
  });

  it("has an entry in the startup check for each table it creates", async () => {
    // The catch-up script and the boot check are two halves of the same promise:
    // the script fixes a gap, the check notices one. A table in neither is a gap
    // nobody will see until a user does.
    const { REQUIRED_SCHEMA } = await import("../schema-check.server");
    const checked = new Set(REQUIRED_SCHEMA.map((entry) => entry.table));
    for (const table of ["render_jobs", "render_clip_slices", "projects", "project_stock_corpus"]) {
      expect(checked.has(table)).toBe(true);
    }
  });
});
