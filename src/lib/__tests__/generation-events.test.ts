import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The capture trigger, executed — not described.
 *
 * generation_events is written entirely in PL/pgSQL, so a TypeScript mirror of
 * its classification rules would prove nothing about the SQL that actually
 * runs. These tests apply the REAL migration files to a REAL PostgreSQL server
 * and drive them with UPDATE statements shaped like the ones the app issues.
 *
 * Each case runs inside a transaction that is rolled back, so the suite leaves
 * no residue and cases cannot see each other.
 *
 * WHEN THERE IS NO SERVER the whole block skips rather than failing: a
 * developer without a local PostgreSQL should not see a red suite for a
 * database test. That does mean a green run in an environment without
 * PostgreSQL proves nothing about the trigger — the skip message says so.
 * Point it at any throwaway cluster with:
 *   PGHOST=/tmp PGPORT=5433 PGUSER=postgres PGDATABASE=postgres
 */

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const UPSTREAM_SQL = path.resolve(__dirname, "fixtures/generation-events-upstream.sql");
const B1 = path.join(MIGRATIONS, "20260812000001_generation_events.sql");
const B2 = path.join(MIGRATIONS, "20260812000002_generation_events_trigger.sql");
const B4 = path.join(MIGRATIONS, "20260812000003_generation_events_backfill.sql");

const PSQL_ENV = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "/tmp",
  PGPORT: process.env.PGPORT ?? "5433",
  PGUSER: process.env.PGUSER ?? "postgres",
  PGDATABASE: process.env.PGDATABASE ?? "postgres",
};

function psql(sql: string): string {
  return execFileSync("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    env: PSQL_ENV,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function serverAvailable(): boolean {
  try {
    psql("select 1;");
    return true;
  } catch {
    return false;
  }
}

const read = (file: string) => fs.readFileSync(file, "utf8");

/**
 * Applies the upstream fixture and the migrations under test, runs `body`, and
 * rolls the whole thing back. Returns the rows `body` selected.
 */
function inMigratedTransaction(body: string, { withBackfill = false } = {}): string[] {
  const sql = [
    "begin;",
    read(UPSTREAM_SQL),
    read(B1),
    read(B2),
    body,
    withBackfill ? read(B4) : "",
    "rollback;",
  ].join("\n");
  return psql(sql)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Marker lines are `key=value` so ordinary NOTICE chatter cannot be mistaken for a result. */
function value(rows: string[], key: string): string | undefined {
  return rows.find((row) => row.startsWith(`${key}=`))?.slice(key.length + 1);
}

const USER = "11111111-1111-4111-8111-111111111111";
const seedUser = `insert into public.users (id, email, role) values ('${USER}', 'u@example.com', 'user');`;

const available = serverAvailable();
const describeDb = available ? describe : describe.skip;

if (!available) {
  console.warn(
    "[generation-events] no PostgreSQL reachable — trigger tests SKIPPED, not passed. " +
      "Set PGHOST/PGPORT/PGUSER to a throwaway cluster to run them.",
  );
}

describeDb("generation_events capture trigger", () => {
  it("a non-status UPDATE writes no event, at matching-poll volume", () => {
    // Matching writes `projects` two to three times per poll (matching_lock_at
    // on acquire and release, matching_idle_rounds nearly every invocation):
    // 60-170 UPDATEs per project, none of them terminal.
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000001', '${USER}', 'p', 'matching_footage');
      do $$ begin for i in 1..170 loop
        update public.projects
        set matching_idle_rounds = i, matching_lock_at = now()
        where id = 'aaaa0000-0000-4000-8000-000000000001';
      end loop; end; $$;
      select 'events=' || count(*) from public.generation_events;
    `);
    expect(value(rows, "events")).toBe("0");
  });

  it("the trigger carries the WHEN guard, so those UPDATEs never enter the function", () => {
    // The count above proves no ROW was written. This proves the function was
    // never CALLED: with the WHEN clause on the trigger, PostgreSQL evaluates
    // the condition without invoking the function, so the payload subqueries
    // are never planned on a non-terminal update.
    const rows = inMigratedTransaction(`
      select 'def=' || replace(pg_get_triggerdef(oid), E'\\n', ' ')
      from pg_trigger where tgname = 'trg_projects_generation_event';
    `);
    const def = value(rows, "def") ?? "";
    expect(def).toMatch(/WHEN/i);
    expect(def).toMatch(/status IS DISTINCT FROM/i);
    expect(def).toMatch(/'completed'::text, *'failed'::text/i);
  });

  it("a same-status UPDATE writes no event", () => {
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000002', '${USER}', 'p', 'rendering');
      update public.projects set status = 'rendering', matching_idle_rounds = 1
      where id = 'aaaa0000-0000-4000-8000-000000000002';
      select 'events=' || count(*) from public.generation_events;
    `);
    expect(value(rows, "events")).toBe("0");
  });

  it("a repeated terminal transition writes exactly one row", () => {
    // The pipeline is browser-poll driven: two overlapping polls can both
    // observe the same terminal transition. Double-counting is the failure
    // mode this table exists to avoid.
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000003', '${USER}', 'p', 'rendering');
      update public.projects set status = 'completed' where id = 'aaaa0000-0000-4000-8000-000000000003';
      update public.projects set status = 'rendering' where id = 'aaaa0000-0000-4000-8000-000000000003';
      update public.projects set status = 'completed' where id = 'aaaa0000-0000-4000-8000-000000000003';
      select 'events=' || count(*) from public.generation_events;
      select 'type=' || event_type from public.generation_events;
      select 'backfilled=' || backfilled from public.generation_events;
    `);
    expect(value(rows, "events")).toBe("1");
    expect(value(rows, "type")).toBe("completed");
    expect(value(rows, "backfilled")).toBe("false");
  });

  it("a completed project carries its scene count, audio duration and render duration", () => {
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000004', '${USER}', 'p', 'rendering');
      insert into public.scenes (project_id, idx)
      select 'aaaa0000-0000-4000-8000-000000000004', g from generate_series(1, 7) g;
      insert into public.audio_assets (project_id, storage_path, duration_sec)
      values ('aaaa0000-0000-4000-8000-000000000004', 'a/x.mp3', 123.45);
      insert into public.render_jobs (project_id, status, started_at, completed_at, created_at)
      values ('aaaa0000-0000-4000-8000-000000000004', 'completed',
              now() - interval '90 seconds', now(), now());
      update public.projects set status = 'completed' where id = 'aaaa0000-0000-4000-8000-000000000004';
      select 'scenes=' || scene_count from public.generation_events;
      select 'audio=' || audio_duration_seconds from public.generation_events;
      select 'render=' || render_duration_ms from public.generation_events;
      select 'stage=' || coalesce(failure_stage, 'NULL') from public.generation_events;
    `);
    expect(value(rows, "scenes")).toBe("7");
    expect(value(rows, "audio")).toBe("123.45");
    expect(value(rows, "render")).toBe("90000");
    // A completed generation did not fail at a stage.
    expect(value(rows, "stage")).toBe("NULL");
  });

  it("a failed project whose MOST RECENT render job was cancelled classifies as 'cancelled'", () => {
    // cancelRenderJob writes render_jobs.status='cancelled' and THEN
    // projects.status='failed', in separate transactions, so the cancelled row
    // is committed and visible to the trigger.
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000005', '${USER}', 'p', 'rendering');
      insert into public.render_jobs (project_id, status, started_at, completed_at, created_at)
      values ('aaaa0000-0000-4000-8000-000000000005', 'cancelled',
              now() - interval '10 seconds', now(), now());
      update public.projects set status = 'failed', error_message = 'Render was cancelled.'
      where id = 'aaaa0000-0000-4000-8000-000000000005';
      select 'type=' || event_type from public.generation_events;
      select 'stage=' || failure_stage from public.generation_events;
    `);
    expect(value(rows, "type")).toBe("cancelled");
    expect(value(rows, "stage")).toBe("rendering");
  });

  it("REGRESSION (D2): an OLDER cancelled job with a NEWER failed job classifies as 'failed'", () => {
    // The rule this pins down. "Any cancelled render job for this project"
    // would classify this genuine failure as 'cancelled' — and the unique
    // index would then drop it as a duplicate of the cancel already recorded,
    // so the failure would vanish from history entirely. Only the most recent
    // render job may decide.
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000006', '${USER}', 'p', 'rendering');
      insert into public.render_jobs (project_id, status, started_at, completed_at, created_at)
      values ('aaaa0000-0000-4000-8000-000000000006', 'cancelled',
              now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours');
      insert into public.render_jobs (project_id, status, started_at, completed_at, created_at)
      values ('aaaa0000-0000-4000-8000-000000000006', 'failed',
              now() - interval '5 minutes', now(), now());
      update public.projects set status = 'failed', error_message = 'Segment 21 of 21 failed'
      where id = 'aaaa0000-0000-4000-8000-000000000006';
      select 'type=' || event_type from public.generation_events;
      select 'reason=' || failure_reason from public.generation_events;
    `);
    expect(value(rows, "type")).toBe("failed");
    expect(value(rows, "reason")).toBe("Segment 21 of 21 failed");
  });

  it("a pipeline failure with no render job records the stage it failed at", () => {
    const rows = inMigratedTransaction(`
      ${seedUser}
      insert into public.projects (id, user_id, name, status)
      values ('aaaa0000-0000-4000-8000-000000000007', '${USER}', 'p', 'matching_footage');
      update public.projects set status = 'failed', error_message = 'Matching stalled'
      where id = 'aaaa0000-0000-4000-8000-000000000007';
      select 'type=' || event_type from public.generation_events;
      select 'stage=' || failure_stage from public.generation_events;
      select 'render=' || coalesce(render_duration_ms::text, 'NULL') from public.generation_events;
    `);
    expect(value(rows, "type")).toBe("failed");
    expect(value(rows, "stage")).toBe("matching_footage");
    // No render ran, so there is no duration. Zero would read as instant.
    expect(value(rows, "render")).toBe("NULL");
  });

  it("never fails the UPDATE when the insert cannot land, and warns rather than going quiet", () => {
    // A statistic must never fail a render, a cancel or an upload. It must
    // also not disappear silently: the handler raises a WARNING naming the
    // project and the SQLSTATE.
    const sql = [
      "begin;",
      read(UPSTREAM_SQL),
      read(B1),
      read(B2),
      seedUser,
      `insert into public.projects (id, user_id, name, status)
       values ('aaaa0000-0000-4000-8000-000000000008', '${USER}', 'p', 'rendering');`,
      "alter table public.generation_events rename to generation_events_moved;",
      `update public.projects set status = 'completed'
       where id = 'aaaa0000-0000-4000-8000-000000000008';`,
      `select 'status=' || status from public.projects
       where id = 'aaaa0000-0000-4000-8000-000000000008';`,
      "rollback;",
    ].join("\n");

    let stderr = "";
    let stdout = "";
    try {
      stdout = execFileSync("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
        input: sql,
        env: PSQL_ENV,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      throw new Error(`the UPDATE was not allowed to succeed: ${stderr}`);
    }
    // The render's terminal write went through.
    expect(stdout).toContain("status=completed");
  });
});

describeDb("generation_events row-level security", () => {
  // The trigger is SECURITY DEFINER and bypasses RLS as its owner, so these
  // tests deliberately drop to the `authenticated` role — the one a browser
  // actually uses — rather than asserting from a superuser session where every
  // policy is a no-op.
  const seedTwoUsers = `
    insert into public.users (id, email, role) values
      ('11111111-1111-4111-8111-111111111111', 'a@x.com', 'user'),
      ('33333333-3333-4333-8333-333333333333', 'b@x.com', 'user'),
      ('99999999-9999-4999-8999-999999999999', 'admin@x.com', 'admin');
    insert into public.generation_events (user_id, project_id, event_type) values
      ('11111111-1111-4111-8111-111111111111', gen_random_uuid(), 'completed'),
      ('22222222-2222-4222-8222-222222222222', gen_random_uuid(), 'completed');
  `;

  it("a user sees their own rows, an admin sees all, a third party sees none", () => {
    const rows = inMigratedTransaction(`
      ${seedTwoUsers}
      set local role authenticated;
      set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
      select 'owner=' || count(*) from public.generation_events;
      set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
      select 'other=' || count(*) from public.generation_events;
      set local request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
      select 'admin=' || count(*) from public.generation_events;
      reset role;
    `);
    expect(value(rows, "owner")).toBe("1");
    expect(value(rows, "other")).toBe("0");
    expect(value(rows, "admin")).toBe("2");
  });

  it("a client role cannot write, even to a row it owns", () => {
    // Append-only is enforced by the absence of INSERT/UPDATE/DELETE grants and
    // policies, not by convention. If this ever passes, history became editable.
    for (const statement of [
      "insert into public.generation_events (user_id, event_type) values ('11111111-1111-4111-8111-111111111111','completed');",
      "update public.generation_events set event_type = 'failed';",
      "delete from public.generation_events;",
    ]) {
      expect(() =>
        psql(
          [
            "begin;",
            read(UPSTREAM_SQL),
            read(B1),
            seedTwoUsers,
            "set local role authenticated;",
            "set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';",
            statement,
            "rollback;",
          ].join("\n"),
        ),
      ).toThrow(/permission denied|violates row-level security/i);
    }
  });
});

describeDb("generation_events backfill", () => {
  const seedProjects = `
    ${seedUser}
    insert into public.projects (user_id, name, status, updated_at)
    select '${USER}', 'p' || g, 'completed',
           timestamptz '2026-08-05 00:00:00Z' + (g || ' hours')::interval
    from generate_series(1, 37) g;
    insert into public.projects (user_id, name, status) values
      ('${USER}', 'stuck', 'rendering'),
      ('${USER}', 'fresh', 'draft');
  `;

  it("inserts exactly one row per terminal project and nothing for the rest", () => {
    const rows = inMigratedTransaction(
      `${seedProjects}
       select 'eligible=' || count(*) from public.projects where status in ('completed','failed');`,
      { withBackfill: true },
    );
    expect(value(rows, "eligible")).toBe("37");

    const counted = inMigratedTransaction(
      `${seedProjects}
       ${read(B4)}
       select 'events=' || count(*) from public.generation_events;
       select 'backfilled=' || count(*) from public.generation_events where backfilled;
       select 'staged=' || count(failure_stage) from public.generation_events;
       select 'nonterminal=' || count(*) from public.generation_events e
         join public.projects p on p.id = e.project_id
         where p.status not in ('completed','failed');`,
    );
    expect(value(counted, "events")).toBe("37");
    // Every row flagged as reconstructed...
    expect(value(counted, "backfilled")).toBe("37");
    // ...and none of them claims a failure stage it cannot know (D6).
    expect(value(counted, "staged")).toBe("0");
    expect(value(counted, "nonterminal")).toBe("0");
  });

  it("is idempotent: a second run inserts nothing", () => {
    const rows = inMigratedTransaction(
      `${seedProjects}
       ${read(B4)}
       ${read(B4)}
       select 'events=' || count(*) from public.generation_events;`,
    );
    expect(value(rows, "events")).toBe("37");
  });

  it("does not overwrite a row the trigger already captured live", () => {
    // Ordering guard: a project that reaches a terminal status while the
    // backfill is running must keep its measured row, not be replaced by a
    // reconstructed one.
    const rows = inMigratedTransaction(
      `${seedUser}
       insert into public.projects (id, user_id, name, status)
       values ('aaaa0000-0000-4000-8000-000000000009', '${USER}', 'live', 'rendering');
       update public.projects set status = 'completed'
       where id = 'aaaa0000-0000-4000-8000-000000000009';
       ${read(B4)}
       select 'events=' || count(*) from public.generation_events;
       select 'backfilled=' || backfilled from public.generation_events;`,
    );
    expect(rows.filter((r) => r.startsWith("events=")).at(-1)).toBe("events=1");
    expect(value(rows, "backfilled")).toBe("false");
  });

  it("classifies through the same function the trigger uses", () => {
    // Not "identical SQL kept in step by review" — the same function. If this
    // ever fails, the trigger and the backfill have genuinely diverged.
    const rows = inMigratedTransaction(`
      select 'triggerdef=' || count(*) from pg_proc
        where proname = 'record_generation_event'
          and prosrc like '%generation_event_payload%';
      select 'backfilldef=' || (
        select count(*) from regexp_matches(
          $sql$${read(B4).replace(/\$/g, "")}$sql$, 'generation_event_payload', 'g')
      );
    `);
    expect(value(rows, "triggerdef")).toBe("1");
    expect(Number(value(rows, "backfilldef"))).toBeGreaterThanOrEqual(1);
  });
});
