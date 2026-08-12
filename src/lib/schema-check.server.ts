/**
 * Verifies at boot that the database has the columns and tables this build needs.
 *
 * WHY. A missing migration does not announce itself. `render_jobs.stall_notice`
 * had never been applied, so every poll of the render page came back
 *
 *   400 {"code":"42703","message":"column render_jobs.stall_notice does not exist"}
 *
 * and the page simply never loaded its status. Nothing in the server logs said
 * "you are missing a migration" — the failure was visible only as a 400 loop in
 * a browser console, on a page the operator had no reason to open with devtools.
 *
 * The check is a per-table probe: select the columns this build reads, limited to
 * zero rows. PostgREST answers with 42703 and names the offending column when one
 * is absent, and 42P01 when the whole table is, so a single cheap request per
 * table reports exactly what is missing. Zero rows means the cost does not scale
 * with the data.
 *
 * WHAT TO LIST HERE. Not every column — the recently added ones, the ones whose
 * absence is silent, and any column added by a migration that shipped after the
 * database was last migrated. A column missing from this list is not a bug in
 * this file; it just is not covered.
 */

/**
 * Columns whose absence has to be caught at deploy time. Each entry names the
 * migration that adds it, so the failure message can point at the fix.
 */
export const REQUIRED_SCHEMA: Array<{
  table: string;
  columns: string[];
  migration: string;
}> = [
  {
    table: "render_jobs",
    columns: [
      "stall_notice",
      "chunks_total",
      "chunks_completed",
      "queue_position",
      "queue_estimate_seconds",
      "stitch_state",
      "stitches_ahead",
      "chunk_state",
      "chunks_ahead",
    ],
    migration:
      "20260805120000_render_job_stall_notice / 20260725101708_add_chunks_to_render_jobs / 20260809000001_render_job_queue_position / 20260809000002_render_job_stitch_state / 20260811000001_render_job_chunk_state",
  },
  {
    table: "render_clip_slices",
    columns: ["fallback_urls", "provider", "in_point_seconds", "timeline_start_seconds"],
    migration: "20260805140000_clip_fallback_renditions / 20260802000001_stock_pipeline_resilience",
  },
  {
    table: "clip_candidates",
    columns: ["fallback_urls"],
    migration: "20260805140000_clip_fallback_renditions",
  },
  {
    table: "projects",
    columns: ["matching_lock_at", "matching_idle_rounds", "niche", "pipeline_cancel_requested_at"],
    migration:
      "20260804000001_matching_footage_advisory_lock / 20260731000001_project_niche_nasa_provider",
  },
  {
    table: "nasa_asset_cache",
    columns: ["has_captions"],
    migration: "20260805000001_nasa_caption_cache",
  },
  {
    // Absent, every gated action would fail open and maintenance mode would
    // silently do nothing — the failure would only show up as writes landing
    // during a migration, which is exactly when it is hardest to notice.
    table: "maintenance_state",
    columns: ["enabled", "message", "enabled_by", "enabled_at"],
    migration: "20260810000001_maintenance_mode",
  },
  {
    table: "project_stock_corpus",
    columns: ["bucket_id", "candidates", "providers_done"],
    migration: "20260805160000_project_stock_corpus",
  },
  {
    // Absent, nothing breaks and nothing complains: the trigger that writes it
    // swallows its own errors so a statistic can never fail a render. The
    // lifetime count would simply stay at zero, which is indistinguishable
    // from "no generations yet" — and every project that finished in the
    // meantime would be unrecoverable, because the history it was reading
    // from is deleted on a 30-hour cycle.
    table: "generation_events",
    columns: ["user_id", "project_id", "event_type", "backfilled", "created_at"],
    migration:
      "20260812000001_generation_events / 20260812000002_generation_events_trigger / 20260812000003_generation_events_backfill",
  },
  {
    table: "auth_login_codes",
    columns: ["client_token_hash", "attempts", "max_attempts", "expires_at", "invalidated_at"],
    migration: "20260807000001_passwordless_sign_in",
  },
  {
    table: "auth_login_failures",
    columns: ["email_normalized", "ip_address", "stage"],
    migration: "20260807000001_passwordless_sign_in",
  },
  {
    table: "access_activations",
    columns: ["trusted_until", "client_token_hash", "revoked_at"],
    migration: "20260807000001_passwordless_sign_in",
  },
  {
    table: "user_access_secrets",
    columns: ["secret_hash", "secret_suffix", "status", "activation_count", "max_activations"],
    migration: "20260801000001_approval_waitlist_access_secrets",
  },
  {
    table: "stock_search_cache",
    columns: ["provider", "query", "orientation", "results"],
    migration: "20260720065512 (base stock cache)",
  },
];

export type SchemaProblem = {
  table: string;
  migration: string;
  /** Postgres error code: 42703 unknown column, 42P01 unknown table. */
  code: string;
  detail: string;
};

function isUnavailablePrivilegedClient(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Missing Supabase environment variable\(s\):.*(?:SERVICE_ROLE_KEY|SUPABASE_URL)/i.test(error.message)
  );
}

/** Postgres codes that mean "the schema does not have this", vs. any other failure. */
const MISSING_COLUMN = "42703";
const MISSING_TABLE = "42P01";

export function isMissingSchemaCode(code: string | undefined | null): boolean {
  return code === MISSING_COLUMN || code === MISSING_TABLE;
}

/**
 * Probes every required table. Returns the problems found; an empty array means
 * the database is up to date for this build.
 *
 * Errors that are NOT schema errors (network, auth, RLS) are deliberately not
 * reported as missing migrations — telling an operator to run a migration when
 * the real problem is a bad service key would send them the wrong way. They are
 * logged and the check passes, because this check exists to catch one specific
 * class of failure and should not become a general health gate.
 */
export async function findSchemaProblems(): Promise<SchemaProblem[]> {
  let supabaseAdmin: typeof import("@/integrations/supabase/client.server")["supabaseAdmin"];
  try {
    ({ supabaseAdmin } = await import("@/integrations/supabase/client.server"));
  } catch (error) {
    if (!isUnavailablePrivilegedClient(error)) throw error;
    // The schema probe is diagnostic only. In preview/dev the privileged client
    // may be unavailable even though public and authenticated app traffic can
    // still use the generated browser/server-session clients. Do not turn that
    // credential/configuration condition into a site-wide 503. Confirmed 42P01
    // and 42703 responses below still fail the deployment as intended.
    console.warn(
      "[schema-check] privileged schema probe unavailable; skipping deploy-time verification",
      error,
    );
    return [];
  }
  const problems: SchemaProblem[] = [];

  try {
    await Promise.all(
      REQUIRED_SCHEMA.map(async ({ table, columns, migration }) => {
        const { error } = await supabaseAdmin
          .from(table as never)
          .select(columns.join(", "))
          .limit(0);
        if (!error) return;

        if (isMissingSchemaCode(error.code)) {
          problems.push({
            table,
            migration,
            code: error.code ?? "unknown",
            detail: error.message,
          });
          return;
        }
        console.warn("[schema-check] could not verify table; not treating as a missing migration", {
          table,
          code: error.code,
          message: error.message,
        });
      }),
    );
  } catch (error) {
    if (!isUnavailablePrivilegedClient(error)) throw error;
    console.warn(
      "[schema-check] privileged schema probe unavailable; skipping deploy-time verification",
      error,
    );
    return [];
  }

  return problems.sort((a, b) => a.table.localeCompare(b.table));
}

/** The message an operator sees. Names each gap and the migration that closes it. */
export function describeSchemaProblems(problems: SchemaProblem[]): string {
  const lines = problems.map(
    (problem) =>
      `  - ${problem.table}: ${problem.detail}\n    fixed by migration ${problem.migration}`,
  );
  return [
    `The database is missing ${problems.length} thing(s) this build needs:`,
    ...lines,
    "",
    "Apply the pending migrations in supabase/migrations, or paste supabase/catch-up.sql",
    "into the Supabase SQL editor — it is idempotent and safe to re-run.",
  ].join("\n");
}

/**
 * Runs the check once at boot.
 *
 * Fails the process by default: a deploy that cannot serve its own render page
 * should not report itself healthy. Set SCHEMA_CHECK=warn to log and continue
 * (useful when deliberately deploying ahead of a migration), or SCHEMA_CHECK=off
 * to skip it entirely.
 */
export async function runSchemaCheck(): Promise<SchemaProblem[]> {
  const mode = process.env.SCHEMA_CHECK ?? "fail";
  if (mode === "off") return [];

  const problems = await findSchemaProblems();
  if (problems.length === 0) {
    console.info("[schema-check] database schema matches this build");
    return [];
  }

  const message = describeSchemaProblems(problems);
  if (mode === "warn") {
    console.warn(`[schema-check] ${message}`);
    return problems;
  }

  console.error(`[schema-check] ${message}`);
  throw new Error(message);
}
