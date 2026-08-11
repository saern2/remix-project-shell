import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The /stats aggregation, executed against real PostgreSQL.
 *
 * Every number on the page comes out of one SQL function, so these tests drive
 * that function rather than a TypeScript restatement of it. Same harness as
 * generation-events.test.ts: real migration files, one rolled-back transaction
 * per case, and the whole block skips when no server is reachable.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const UPSTREAM_SQL = path.resolve(__dirname, "fixtures/generation-events-upstream.sql");
const TABLE = path.join(MIGRATIONS, "20260812000001_generation_events.sql");
const TRIGGER = path.join(MIGRATIONS, "20260812000002_generation_events_trigger.sql");
const RPC = path.join(MIGRATIONS, "20260813000001_generation_stats_rpc.sql");

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
const NOBODY = "33333333-3333-4333-8333-333333333333";

/**
 * Alice: 3 completed + 1 failed today, 2 completed five days ago, 1 completed
 * yesterday. Bob: 2 completed + 1 cancelled today. Plus live projects for the
 * "currently active" card.
 */
const SEED = `
  insert into public.users (id, email, role) values
    ('${ALICE}', 'alice@x.com', 'user'),
    ('${BOB}', 'bob@x.com', 'user');
  insert into public.generation_events
    (user_id, project_id, event_type, scene_count, audio_duration_seconds, render_duration_ms, created_at) values
    ('${ALICE}', gen_random_uuid(), 'completed',  20,  600,  90000, now()),
    ('${ALICE}', gen_random_uuid(), 'completed',  75, 1200, 120000, now()),
    ('${ALICE}', gen_random_uuid(), 'completed', 250, 1800, 300000, now()),
    ('${ALICE}', gen_random_uuid(), 'failed',     10,  300,   null, now()),
    ('${ALICE}', gen_random_uuid(), 'completed', 150,  900,  60000, now() - interval '5 days'),
    ('${ALICE}', gen_random_uuid(), 'completed', 150,  900,  60000, now() - interval '5 days'),
    ('${ALICE}', gen_random_uuid(), 'completed',  30,  300,   null, now() - interval '1 day'),
    ('${BOB}',   gen_random_uuid(), 'completed',  40,  480,   null, now()),
    ('${BOB}',   gen_random_uuid(), 'completed',  40,  480,   null, now()),
    ('${BOB}',   gen_random_uuid(), 'cancelled',  40,  480,   null, now());
  insert into public.projects (user_id, name, status) values
    ('${ALICE}', 'r1', 'rendering'),
    ('${ALICE}', 'm1', 'matching_footage'),
    ('${BOB}',   'r2', 'rendering'),
    ('${ALICE}', 'done', 'completed');
`;

/** Runs `select`s against a migrated, seeded database and rolls back. */
function query(selects: string, { seed = true } = {}): string[] {
  return psql(
    [
      "begin;",
      read(UPSTREAM_SQL),
      read(TABLE),
      read(TRIGGER),
      read(RPC),
      seed ? SEED : "",
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
  console.warn(
    "[generation-stats] no PostgreSQL reachable — aggregation tests SKIPPED, not passed.",
  );
}

describeDb("get_generation_stats — counts by scope", () => {
  it("platform scope counts every user", () => {
    const rows = query(`
      select 'today_completed=' || (${platform}->'today'->>'completed');
      select 'today_total='     || (${platform}->'today'->>'total');
      select 'today_seconds='   || (${platform}->'today'->>'seconds');
      select 'life_completed='  || (${platform}->'lifetime'->>'completed');
      select 'life_total='      || (${platform}->'lifetime'->>'total');
      select 'prev_completed='  || (${platform}->'previous_day'->>'completed');
    `);
    // 5 of today's 7 events completed (Alice 3 + Bob 2; one failed, one cancelled).
    expect(value(rows, "today_completed")).toBe("5");
    expect(value(rows, "today_total")).toBe("7");
    // Seconds count COMPLETED only — the failed run's 300s produced no video.
    expect(value(rows, "today_seconds")).toBe("4560");
    expect(value(rows, "life_completed")).toBe("8");
    expect(value(rows, "life_total")).toBe("10");
    // Yesterday, which is what the Today delta compares against.
    expect(value(rows, "prev_completed")).toBe("1");
  });

  it("user scope counts only that user, and never leaks another's rows", () => {
    const rows = query(`
      select 'today_completed=' || (${alice}->'today'->>'completed');
      select 'today_total='     || (${alice}->'today'->>'total');
      select 'life_completed='  || (${alice}->'lifetime'->>'completed');
      select 'life_total='      || (${alice}->'lifetime'->>'total');
      select 'outcomes='        || (${alice}->'outcomes')::text;
    `);
    expect(value(rows, "today_completed")).toBe("3");
    expect(value(rows, "today_total")).toBe("4");
    expect(value(rows, "life_completed")).toBe("6");
    expect(value(rows, "life_total")).toBe("7");
    // Bob's cancellation must not appear in Alice's outcome mix.
    expect(value(rows, "outcomes")).not.toContain("cancelled");
  });

  it("'currently active' is live project state, not history", () => {
    const rows = query(`
      select 'platform_active=' || (${platform}->>'active_now');
      select 'alice_active='    || (${alice}->>'active_now');
    `);
    // Two rendering + one matching. The 'completed' project is not active.
    expect(value(rows, "platform_active")).toBe("3");
    expect(value(rows, "alice_active")).toBe("2");
  });
});

describeDb("get_generation_stats — day bucketing", () => {
  it("returns exactly 30 days, including the empty ones", () => {
    const rows = query(`
      select 'days=' || jsonb_array_length(${platform}->'daily');
      select 'zero_days=' || count(*) from jsonb_array_elements(${platform}->'daily') d
        where (d->>'count')::int = 0;
    `);
    expect(value(rows, "days")).toBe("30");
    // Only three days in the window carry data, so the rest must still be
    // present as zeroes — a gap would silently rescale the chart.
    expect(value(rows, "zero_days")).toBe("27");
  });

  it("buckets each generation into its own day", () => {
    const rows = query(`
      select 'today=' || (d->>'count') from jsonb_array_elements(${platform}->'daily') d
        where (d->>'day')::date = (now() at time zone 'UTC')::date;
      select 'yesterday=' || (d->>'count') from jsonb_array_elements(${platform}->'daily') d
        where (d->>'day')::date = (now() at time zone 'UTC')::date - 1;
      select 'five_days_ago=' || (d->>'count') from jsonb_array_elements(${platform}->'daily') d
        where (d->>'day')::date = (now() at time zone 'UTC')::date - 5;
    `);
    // Completed only: today's failed and cancelled events are not bars.
    expect(value(rows, "today")).toBe("5");
    expect(value(rows, "yesterday")).toBe("1");
    expect(value(rows, "five_days_ago")).toBe("2");
  });

  it("an unusable timezone falls back to UTC instead of failing the page", () => {
    const rows = query(`
      select 'tz=' || (public.get_generation_stats('platform', null, 'Not/AZone')->>'timezone');
      select 'real=' || (public.get_generation_stats('platform', null, 'America/Los_Angeles')->>'timezone');
    `);
    expect(value(rows, "tz")).toBe("UTC");
    expect(value(rows, "real")).toBe("America/Los_Angeles");
  });
});

describeDb("get_generation_stats — supporting panels", () => {
  it("ranks users by completed count in platform scope", () => {
    const rows = query(`
      select 'first=' || (${platform}->'ranked'->0->>'label');
      select 'first_count=' || (${platform}->'ranked'->0->>'count');
      select 'second=' || (${platform}->'ranked'->1->>'label');
    `);
    expect(value(rows, "first")).toBe("alice@x.com");
    expect(value(rows, "first_count")).toBe("6");
    expect(value(rows, "second")).toBe("bob@x.com");
  });

  it("bands a single user by scene count, keeping empty bands", () => {
    const rows = query(`
      select 'bands=' || (${alice}->'ranked')::text;
      select 'band_count=' || jsonb_array_length(${alice}->'ranked');
      select 'empty_user_bands=' || jsonb_array_length(
        public.get_generation_stats('user','${NOBODY}','UTC')->'ranked');
    `);
    // 20 and 30 scenes -> <50; 75 -> 50-100; 150 x2 -> 100-200; 250 -> 200+.
    expect(value(rows, "bands")).toContain('{"count": 2, "label": "<50"}');
    expect(value(rows, "bands")).toContain('{"count": 1, "label": "50-100"}');
    expect(value(rows, "bands")).toContain('{"count": 2, "label": "100-200"}');
    expect(value(rows, "bands")).toContain('{"count": 1, "label": "200+"}');
    expect(value(rows, "band_count")).toBe("4");
    // All four bands survive even with nothing in them, so the axis is stable.
    expect(value(rows, "empty_user_bands")).toBe("4");
  });

  it("returns the ten most recent, newest first, with a user label only for platform scope", () => {
    const rows = query(`
      select 'count=' || jsonb_array_length(${platform}->'recent');
      select 'newest_first=' || (
        (${platform}->'recent'->0->>'created_at')::timestamptz
        >= (${platform}->'recent'->1->>'created_at')::timestamptz);
      select 'platform_label=' || coalesce(${platform}->'recent'->0->>'user_label', 'NULL');
      select 'user_label=' || coalesce(${alice}->'recent'->0->>'user_label', 'NULL');
    `);
    expect(value(rows, "count")).toBe("10");
    expect(value(rows, "newest_first")).toBe("true");
    expect(value(rows, "platform_label")).toMatch(/@x\.com$/);
    // A user looking at their own stats does not need a column of their own name.
    expect(value(rows, "user_label")).toBe("NULL");
  });

  it("reports the start of RECORDED history, read from the data", () => {
    const rows = query(`
      select 'range=' || (${platform}->>'range_start');
      select 'expected=' || (select min(created_at)::text from public.generation_events);
    `);
    // The lifetime label is never hard-coded: capture began well after the
    // product did, and 18 generations pre-date it.
    expect(value(rows, "range")).toBeTruthy();
    expect(new Date(value(rows, "range")!).toISOString()).toBe(
      new Date(value(rows, "expected")!).toISOString(),
    );
  });
});

describeDb("get_generation_stats — empty state", () => {
  it("returns zeroes and nulls rather than erroring when there is nothing", () => {
    const rows = query(
      `
      select 'completed=' || (public.get_generation_stats('user','${NOBODY}','UTC')->'lifetime'->>'completed');
      select 'total=' || (public.get_generation_stats('user','${NOBODY}','UTC')->'lifetime'->>'total');
      select 'range=' || coalesce(public.get_generation_stats('user','${NOBODY}','UTC')->>'range_start','NULL');
      select 'days=' || jsonb_array_length(public.get_generation_stats('user','${NOBODY}','UTC')->'daily');
      select 'recent=' || jsonb_array_length(public.get_generation_stats('user','${NOBODY}','UTC')->'recent');
      select 'outcomes=' || jsonb_array_length(public.get_generation_stats('user','${NOBODY}','UTC')->'outcomes');
    `,
      { seed: false },
    );
    expect(value(rows, "completed")).toBe("0");
    expect(value(rows, "total")).toBe("0");
    // No history means no start date to label, and the UI must not invent one.
    expect(value(rows, "range")).toBe("NULL");
    // The chart still has its 30 slots, so it renders a flat axis, not nothing.
    expect(value(rows, "days")).toBe("30");
    expect(value(rows, "recent")).toBe("0");
    expect(value(rows, "outcomes")).toBe("0");
  });
});

describeDb("get_generation_stats — privilege", () => {
  it("is not executable by anon or authenticated", () => {
    // The function is SECURITY DEFINER and sees every row regardless of RLS.
    // The only thing standing between a signed-in user and platform-wide data
    // is that they cannot call it at all — the admin check in
    // getGenerationStats guards the one caller that can.
    for (const role of ["anon", "authenticated"]) {
      expect(() =>
        psql(
          [
            "begin;",
            read(UPSTREAM_SQL),
            read(TABLE),
            read(TRIGGER),
            read(RPC),
            `set local role ${role};`,
            `select public.get_generation_stats('platform', null, 'UTC');`,
            "rollback;",
          ].join("\n"),
        ),
      ).toThrow(/permission denied/i);
    }
  });

  it("service_role can execute it", () => {
    const rows = query(`
      set local role service_role;
      select 'ok=' || (${platform}->>'scope');
      reset role;
    `);
    expect(value(rows, "ok")).toBe("platform");
  });
});
