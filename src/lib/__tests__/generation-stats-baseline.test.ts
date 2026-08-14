import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The pre-capture baseline, executed against real PostgreSQL.
 *
 * generation_events began capturing on 2026-08-12. The operator counts 607
 * completed videos since 2026-08-03; the table holds 216. The 391 missing
 * generations were deleted before capture existed — no user, no duration, no
 * scene count survives them.
 *
 * They are added as ONE labelled number rather than 391 invented rows, and the
 * whole safety argument is containment: platform lifetime moves, and NOTHING
 * else does. Most of the tests below exist to prove the "nothing else" half,
 * because that is the part that would corrupt the page quietly.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const UPSTREAM_SQL = path.resolve(__dirname, "fixtures/generation-events-upstream.sql");
const TABLE = path.join(MIGRATIONS, "20260812000001_generation_events.sql");
const TRIGGER = path.join(MIGRATIONS, "20260812000002_generation_events_trigger.sql");
const RPC = path.join(MIGRATIONS, "20260813000001_generation_stats_rpc.sql");
const BASELINE = path.join(MIGRATIONS, "20260814000001_analytics_baseline.sql");

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

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

/** Alice: 3 completed + 1 failed. Bob: 1 completed. Five events, four complete. */
const SEED = `
  insert into public.users (id, email, role) values
    ('${ALICE}', 'alice@x.com', 'user'),
    ('${BOB}', 'bob@x.com', 'user');
  insert into public.generation_events
    (user_id, project_id, event_type, scene_count, audio_duration_seconds, created_at) values
    ('${ALICE}', gen_random_uuid(), 'completed',  20,  600, now()),
    ('${ALICE}', gen_random_uuid(), 'completed',  75, 1200, now() - interval '2 days'),
    ('${ALICE}', gen_random_uuid(), 'completed', 250, 1800, now() - interval '3 days'),
    ('${ALICE}', gen_random_uuid(), 'failed',     10,  300, now()),
    ('${BOB}',   gen_random_uuid(), 'completed',  40,  480, now());
`;

/**
 * @param baselineRow SQL replacing the shipped row, or "" to drop it entirely.
 */
function query(selects: string, baselineRow?: string): string[] {
  return psql(
    [
      "begin;",
      read(UPSTREAM_SQL),
      read(TABLE),
      read(TRIGGER),
      read(RPC),
      read(BASELINE),
      SEED,
      baselineRow === undefined
        ? ""
        : `delete from public.analytics_baseline; ${baselineRow}`,
      selects,
      "rollback;",
    ].join("\n"),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const value = (rows: string[], key: string) =>
  rows.find((row) => row.startsWith(`${key}=`))?.slice(key.length + 1);

const platform = `public.get_generation_stats('platform', null, 'UTC')`;
const alice = `public.get_generation_stats('user', '${ALICE}', 'UTC')`;

const available = serverAvailable();
const describeDb = available ? describe : describe.skip;

if (!available) {
  console.warn("[analytics-baseline] no PostgreSQL reachable — tests SKIPPED, not passed.");
}

describeDb("the baseline lands in platform lifetime", () => {
  it("adds its generations to the lifetime totals", () => {
    const rows = query(`
      select 'completed=' || (${platform}->'lifetime'->>'completed');
      select 'total='     || (${platform}->'lifetime'->>'total');
      select 'seconds='   || (${platform}->'lifetime'->>'seconds');
    `);
    // 4 measured completions + 391; 5 measured events + 391.
    expect(value(rows, "completed")).toBe(String(4 + 391));
    expect(value(rows, "total")).toBe(String(5 + 391));
    // 4080s measured + 9775 minutes of estimate.
    expect(value(rows, "seconds")).toBe(String(4080 + 9775 * 60));
  });

  it("ships the numbers the operator reconstructed", () => {
    const rows = query(`
      select 'completed=' || (${platform}->'baseline'->>'generations_completed');
      select 'total='     || (${platform}->'baseline'->>'generations_total');
      select 'minutes='   || (${platform}->'baseline'->>'video_minutes');
      select 'from='      || (${platform}->'baseline'->>'effective_from');
    `);
    expect(value(rows, "completed")).toBe("391");
    // A FLOOR: failures in that window were manually deleted, so the true
    // attempt count is unknown and total is not a measurement either.
    expect(value(rows, "total")).toBe("391");
    expect(value(rows, "minutes")).toBe("9775");
    expect(value(rows, "from")).toBe("2026-08-03");
  });

  it("carries a note that says both estimates out loud", () => {
    const rows = query(`select 'note=' || (${platform}->'baseline'->>'note');`);
    const note = value(rows, "note") ?? "";
    expect(note.toLowerCase()).toContain("estimate");
    expect(note.toLowerCase()).toContain("floor");
    expect(note).toContain("25 minutes per video");
  });

  it("moves the success-rate fraction by exactly the baseline", () => {
    // 4 of 5 measured becomes 395 of 396 — the shape the card renders.
    const rows = query(`
      select 'c=' || (${platform}->'lifetime'->>'completed');
      select 't=' || (${platform}->'lifetime'->>'total');
    `);
    const completed = Number(value(rows, "c"));
    const total = Number(value(rows, "t"));
    expect(total - completed).toBe(1); // the one measured failure, unchanged
  });
});

describeDb("nothing else moves", () => {
  it("leaves user scope entirely measured", () => {
    const rows = query(`
      select 'completed=' || (${alice}->'lifetime'->>'completed');
      select 'total='     || (${alice}->'lifetime'->>'total');
      select 'seconds='   || (${alice}->'lifetime'->>'seconds');
      select 'baseline='  || coalesce((${alice}->>'baseline'), 'null');
    `);
    expect(value(rows, "completed")).toBe("3");
    expect(value(rows, "total")).toBe("4");
    expect(value(rows, "seconds")).toBe("3600");
    // Not merely zero — absent. A per-user view has no share of a platform
    // total, and offering one would invite it to be added.
    expect(value(rows, "baseline")).toBe("null");
  });

  it("leaves the Today window measured", () => {
    const rows = query(`
      select 'completed=' || (${platform}->'today'->>'completed');
      select 'total='     || (${platform}->'today'->>'total');
      select 'seconds='   || (${platform}->'today'->>'seconds');
      select 'prev='      || (${platform}->'previous_day'->>'total');
    `);
    expect(value(rows, "completed")).toBe("2");
    expect(value(rows, "total")).toBe("3");
    expect(value(rows, "seconds")).toBe("1080");
    expect(value(rows, "prev")).toBe("0");
  });

  it("leaves the 30-day chart measured", () => {
    const rows = query(`
      select 'sum=' || (
        select coalesce(sum((d->>'count')::int), 0)
        from jsonb_array_elements(${platform}->'daily') d
      );
      select 'days=' || jsonb_array_length(${platform}->'daily');
    `);
    // Four completions, all inside the window. No 391 anywhere.
    expect(value(rows, "sum")).toBe("4");
    expect(value(rows, "days")).toBe("30");
  });

  it("leaves the outcomes donut measured", () => {
    const rows = query(`
      select 'sum=' || (
        select coalesce(sum((o->>'count')::int), 0)
        from jsonb_array_elements(${platform}->'outcomes') o
      );
    `);
    expect(value(rows, "sum")).toBe("5");
  });

  it("leaves the ranked panel and the recent list measured", () => {
    const rows = query(`
      select 'ranked=' || (
        select coalesce(sum((r->>'count')::int), 0)
        from jsonb_array_elements(${platform}->'ranked') r
      );
      select 'recent=' || jsonb_array_length(${platform}->'recent');
    `);
    expect(value(rows, "ranked")).toBe("4");
    expect(value(rows, "recent")).toBe("5");
  });

  it("keeps range_start at the first MEASURED event, not the baseline's date", () => {
    // The label needs both dates: this is where measurement begins, and the
    // baseline block says what precedes it. Collapsing them would claim the
    // reconstructed period was recorded.
    const rows = query(`
      select 'start=' || ((${platform}->>'range_start')::date > date '2026-08-03');
    `);
    expect(value(rows, "start")).toBe("true");
  });

  it("leaves the active-now card alone", () => {
    const rows = query(`select 'active=' || (${platform}->>'active_now');`);
    expect(value(rows, "active")).toBe("0");
  });
});

describeDb("without a baseline row the page is exactly what it was", () => {
  it("reports measured totals and a null baseline", () => {
    const rows = query(
      `
      select 'completed=' || (${platform}->'lifetime'->>'completed');
      select 'total='     || (${platform}->'lifetime'->>'total');
      select 'seconds='   || (${platform}->'lifetime'->>'seconds');
      select 'baseline='  || coalesce((${platform}->>'baseline'), 'null');
    `,
      "",
    );
    expect(value(rows, "completed")).toBe("4");
    expect(value(rows, "total")).toBe("5");
    expect(value(rows, "seconds")).toBe("4080");
    expect(value(rows, "baseline")).toBe("null");
  });

  it("honours an operator correction rather than the shipped constant", () => {
    const rows = query(
      `
      select 'completed=' || (${platform}->'lifetime'->>'completed');
      select 'minutes='   || (${platform}->'baseline'->>'video_minutes');
    `,
      `insert into public.analytics_baseline
         (id, generations_completed, generations_total, video_minutes, effective_from, note)
       values (1, 10, 12, 250, date '2026-08-01', 'corrected');`,
    );
    expect(value(rows, "completed")).toBe(String(4 + 10));
    expect(value(rows, "minutes")).toBe("250");
  });
});

describeDb("the table refuses states that would misreport", () => {
  it("allows only one row", () => {
    expect(() =>
      query(
        `select 1;`,
        `insert into public.analytics_baseline
           (id, generations_completed, generations_total, video_minutes, effective_from, note)
         values (2, 1, 1, 1, current_date, 'second row');`,
      ),
    ).toThrow();
  });

  it("refuses a total below the completed count", () => {
    expect(() =>
      query(
        `select 1;`,
        `insert into public.analytics_baseline
           (id, generations_completed, generations_total, video_minutes, effective_from, note)
         values (1, 400, 391, 100, current_date, 'more successes than attempts');`,
      ),
    ).toThrow();
  });

  it("re-running the migration cannot clobber a corrected row", () => {
    // on conflict do nothing: the operator's edit survives a replay of
    // catch-up.sql, which is the script most likely to be pasted twice.
    const rows = psql(
      [
        "begin;",
        read(UPSTREAM_SQL),
        read(TABLE),
        read(TRIGGER),
        read(RPC),
        read(BASELINE),
        `update public.analytics_baseline set generations_completed = 7, note = 'corrected';`,
        read(BASELINE),
        `select 'completed=' || generations_completed || ',note=' || note from public.analytics_baseline;`,
        "rollback;",
      ].join("\n"),
    );
    expect(rows).toContain("completed=7,note=corrected");
  });
});
