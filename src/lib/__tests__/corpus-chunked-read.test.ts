/**
 * The project corpus is read in several statements, never in one.
 *
 * MEASURED 2026-08-12. PostgREST reaches Postgres as `authenticator`, whose
 * statement_timeout is 8s; service_role has none set, and role settings apply
 * at LOGIN only, so PostgREST's SET ROLE never picks one up. A full 40-bucket
 * corpus is ~490 kB stored but ~3.9 MB on the wire — jsonb is stored TOAST-
 * compressed and serialised back out as JSON text — and ~98% of the cost of
 * reading it is CPU-bound detoast plus serialisation (index scan 1.8 ms,
 * detoast + text 49.7 ms, json_agg ~105 ms median on an idle box). So the whole
 * corpus in one statement had to fit its entire serialisation inside 8s, and
 * under contention it did not: "canceling statement due to statement timeout".
 *
 * These tests pin the paging, not the size: the corpus that comes back must be
 * WHOLE and identical to what the single read returned, because assignment
 * running against a partial corpus is the round-8 failure this table exists to
 * prevent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  project_id: string;
  bucket_id: string;
  query: string;
  tokens: unknown;
  demand_ids: unknown;
  candidates: unknown;
  providers_done: unknown;
};

type Statement = {
  eq: Record<string, string>;
  gt: { column: string; value: string } | null;
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
};

const { db } = vi.hoisted(() => ({
  db: {
    rows: [] as Row[],
    statements: [] as Statement[],
    /** Caps every response, the way PostgREST's db-max-rows does. */
    responseCap: null as number | null,
    /** Zero-based index of a statement that should come back as an error. */
    failAt: null as number | null,
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = () => {
    const stmt: Statement = { eq: {}, gt: null, order: null, limit: null };
    const builder = {
      select: () => builder,
      eq: (column: string, value: string) => {
        stmt.eq[column] = value;
        return builder;
      },
      gt: (column: string, value: string) => {
        stmt.gt = { column, value };
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        stmt.order = { column, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit: (count: number) => {
        stmt.limit = count;
        return builder;
      },
      then: (resolve: (value: { data: Row[] | null; error: { message: string } | null }) => void) => {
        db.statements.push(stmt);
        if (db.failAt === db.statements.length - 1) {
          return resolve({
            data: null,
            error: { message: "canceling statement due to statement timeout" },
          });
        }

        let rows = db.rows.filter((row) =>
          Object.entries(stmt.eq).every(([column, value]) => (row as never)[column] === value),
        );
        if (stmt.gt) {
          const { column, value } = stmt.gt;
          rows = rows.filter((row) => String((row as never)[column]) > value);
        }
        if (stmt.order) {
          const { column, ascending } = stmt.order;
          // Plain string comparison, matching the `gt` filter above: Postgres
          // uses one collation for both, so keyset paging stays consistent.
          rows = [...rows].sort((a, b) => {
            const left = String((a as never)[column]);
            const right = String((b as never)[column]);
            const order = left < right ? -1 : left > right ? 1 : 0;
            return ascending ? order : -order;
          });
        }
        if (stmt.limit != null) rows = rows.slice(0, stmt.limit);
        if (db.responseCap != null) rows = rows.slice(0, db.responseCap);
        return resolve({ data: rows, error: null });
      },
    };
    return builder;
  };
  return { supabaseAdmin: { from } };
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

function row(projectId: string, index: number): Row {
  return {
    project_id: projectId,
    // The real shape from clusterStockQueries, which is why `bucket-10` sorts
    // before `bucket-2` — order is lexicographic, not numeric.
    bucket_id: `bucket-${index}`,
    query: `query ${index}`,
    tokens: [`t${index}`],
    demand_ids: [`demand-${index}`],
    candidates: [{ provider: "pexels", provider_clip_id: String(index) }],
    providers_done: index % 2 === 0 ? ["pexels"] : [],
  };
}

function seed(count: number, projectId = PROJECT) {
  for (let index = 0; index < count; index += 1) db.rows.push(row(projectId, index));
}

const load = async () => {
  const { loadProjectCorpus } = await import("../stock-corpus-store.server");
  return loadProjectCorpus(PROJECT);
};

beforeEach(() => {
  db.rows = [];
  db.statements = [];
  db.responseCap = null;
  db.failAt = null;
});

describe("no single statement carries the whole corpus", () => {
  it("splits a full 40-bucket corpus across several statements", async () => {
    seed(40);
    await load();
    // The number of statements is not the property — the per-statement size is.
    expect(db.statements.length).toBeGreaterThan(1);
    for (const statement of db.statements) {
      expect(statement.limit).not.toBeNull();
      expect(statement.limit!).toBeLessThanOrEqual(10);
    }
  });

  it("pages by keyset, so a later statement costs no more than the first", async () => {
    seed(40);
    await load();
    // An OFFSET would make the last statement scan the whole corpus to skip it.
    // Each statement instead re-enters the primary key where the last stopped.
    expect(db.statements[0].gt).toBeNull();
    expect(db.statements[0].order).toEqual({ column: "bucket_id", ascending: true });
    for (let index = 1; index < db.statements.length; index += 1) {
      expect(db.statements[index].gt?.column).toBe("bucket_id");
      expect(db.statements[index].gt!.value > (db.statements[index - 1].gt?.value ?? "")).toBe(true);
    }
  });

  it("still scopes every statement to the one project", async () => {
    seed(12);
    seed(12, OTHER_PROJECT);
    const corpus = await load();
    for (const statement of db.statements) expect(statement.eq.project_id).toBe(PROJECT);
    expect(corpus).toHaveLength(12);
  });
});

describe("the corpus that comes back is whole", () => {
  it("returns every bucket a single read would have", async () => {
    seed(40);
    const corpus = await load();
    expect(corpus).toHaveLength(40);
    expect(new Set(corpus.map((bucket) => bucket.id)).size).toBe(40);
  });

  it("does not stop early when a response is capped below the limit asked for", async () => {
    // PostgREST's db-max-rows can shorten any response. Reading "fewer rows
    // than I asked for" as "that was the last of them" would hand assignment a
    // truncated corpus and look like success.
    seed(40);
    db.responseCap = 3;
    const corpus = await load();
    expect(corpus).toHaveLength(40);
  });

  it("throws when a middle statement fails, rather than returning what it has", async () => {
    seed(40);
    db.failAt = 2;
    // The timeout this fix exists for is exactly this shape, and a partial
    // corpus that resolved would be worse than the timeout: it looks like
    // success and assignment runs against the buckets that happened to arrive.
    await expect(load()).rejects.toThrow(/Corpus load failed.*statement timeout/);
    // It really did fail partway, with buckets already in hand to return.
    expect(db.statements).toHaveLength(3);
  });

  it("carries each bucket's fields through unchanged", async () => {
    seed(2);
    const corpus = await load();
    const first = corpus.find((bucket) => bucket.id === "bucket-0")!;
    expect(first).toEqual({
      id: "bucket-0",
      query: "query 0",
      tokens: ["t0"],
      demandIds: ["demand-0"],
      candidates: [{ provider: "pexels", provider_clip_id: "0" }],
      // This read DID ask for candidates, so the pool in hand is the real one
      // and buildCorpusCell need not fetch it again to merge into it.
      candidatesLoaded: true,
      providersDone: ["pexels"],
    });
  });

  it("keeps the fallbacks for a row whose json columns are not arrays", async () => {
    // Pre-corpus rows and hand-edited ones both reach here; the single read
    // tolerated them and the chunked one must too.
    db.rows.push({
      project_id: PROJECT,
      bucket_id: "bucket-0",
      query: "slow drifting clouds",
      tokens: null,
      demand_ids: null,
      candidates: null,
      providers_done: null,
    });
    const [bucket] = await load();
    expect(bucket.tokens.length).toBeGreaterThan(0);
    expect(bucket.demandIds).toEqual([]);
    expect(bucket.candidates).toEqual([]);
    expect(bucket.providersDone).toEqual([]);
  });

  it("returns an empty corpus for a project with no buckets", async () => {
    // ensureProjectBuckets keys off length 0 to decide whether to cluster, so
    // an empty read must stay empty and cheap.
    const corpus = await load();
    expect(corpus).toEqual([]);
    expect(db.statements).toHaveLength(1);
  });
});
