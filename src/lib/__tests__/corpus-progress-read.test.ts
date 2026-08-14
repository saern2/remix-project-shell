/**
 * The build phase reads progress, not candidates.
 *
 * MEASURED 2026-08-12 in production: a 40-bucket corpus is ~3.9 MB of JSON on
 * the wire, and the matching pipeline read all of it on every one of its ~20
 * build invocations — ~80 MB per project — to answer a question that lives
 * entirely in providers_done. It is also the read that hit `authenticator`'s
 * 8s statement_timeout.
 *
 * Two properties matter, and the second is the dangerous one:
 *
 *   1. the build reads only what it needs;
 *   2. assignment still gets the WHOLE corpus. "The corpus must be whole before
 *      a single scene is assigned" is the round-8 fix — a candidate-less bucket
 *      reaching assignment would silently look like an exhausted pool.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const { db } = vi.hoisted(() => ({
  db: {
    rows: [] as Row[],
    /** Columns each statement asked for, in order. */
    selects: [] as string[],
    updates: [] as Array<Record<string, unknown>>,
    found: [] as unknown[],
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = () => {
    const stmt = { columns: "", eq: {} as Record<string, string>, gt: null as string | null };
    const rowsFor = () => {
      let rows = db.rows.filter((row) =>
        Object.entries(stmt.eq).every(([column, value]) => (row as never)[column] === value),
      );
      if (stmt.gt !== null) rows = rows.filter((row) => row.bucket_id > stmt.gt!);
      return [...rows].sort((a, b) => (a.bucket_id < b.bucket_id ? -1 : 1));
    };
    const builder = {
      select: (columns: string) => {
        stmt.columns = columns;
        db.selects.push(columns);
        return builder;
      },
      eq: (column: string, value: string) => {
        stmt.eq[column] = value;
        return builder;
      },
      gt: (_column: string, value: string) => {
        stmt.gt = value;
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
      update: async (patch: Record<string, unknown>) => {
        db.updates.push(patch);
        for (const row of rowsFor()) Object.assign(row, patch);
        return { error: null };
      },
      then: (resolve: (value: { data: Row[]; error: null }) => void) =>
        resolve({ data: rowsFor(), error: null }),
    };
    // `update(...).eq(...).eq(...)` — the filters come after the patch, so the
    // update has to be applied when the chain is awaited, not when it is built.
    const chain = {
      ...builder,
      update: (patch: Record<string, unknown>) => {
        db.updates.push(patch);
        const applying = {
          eq: (column: string, value: string) => {
            stmt.eq[column] = value;
            return applying;
          },
          then: (resolve: (value: { error: null }) => void) => {
            for (const row of rowsFor()) Object.assign(row, patch);
            return resolve({ error: null });
          },
        };
        return applying;
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/stock.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchProviderCandidatePool: async () => db.found,
}));

const PROJECT = "11111111-1111-4111-8111-111111111111";

const candidate = (id: string) => ({
  provider: "pexels" as const,
  provider_clip_id: id,
  duration_sec: 12,
  width: 1920,
  height: 1080,
  thumbnail_url: `https://example.test/${id}.jpg`,
  files: [{ url: `https://example.test/${id}.mp4`, width: 1920, height: 1080 }],
});

beforeEach(() => {
  db.rows = [
    {
      project_id: PROJECT,
      bucket_id: "bucket-0",
      query: "slow drifting clouds",
      tokens: ["slow", "clouds"],
      demand_ids: ["scene-a"],
      candidates: [candidate("stored-1"), candidate("stored-2"), candidate("stored-3")],
      providers_done: ["pexels"],
    },
  ];
  db.selects = [];
  db.updates = [];
  db.found = [];
});

describe("loadCorpusProgress reads what the build needs and no more", () => {
  it("never asks for the candidates column", async () => {
    const { loadCorpusProgress } = await import("../stock-corpus-store.server");
    await loadCorpusProgress(PROJECT);
    expect(db.selects).toHaveLength(1);
    // The whole point: ~120 B a bucket instead of ~98 kB.
    expect(db.selects[0]).not.toMatch(/candidates/);
    expect(db.selects[0]).toMatch(/providers_done/);
    expect(db.selects[0]).toMatch(/bucket_id/);
    // buildCorpusCell searches on the bucket's query, so it has to come back.
    expect(db.selects[0]).toMatch(/query/);
  });

  it("returns buckets whose pools are empty because they were not read", async () => {
    const { loadCorpusProgress, pendingCorpusWork } = await import("../stock-corpus-store.server");
    const [bucket] = await loadCorpusProgress(PROJECT);
    expect(bucket.candidates).toEqual([]);
    // Scheduling is unaffected — it reads providersDone only.
    expect(pendingCorpusWork([bucket], ["pexels", "pixabay"]).map((c) => c.provider)).toEqual([
      "pixabay",
    ]);
  });
});

describe("a cell merges into the stored pool, never over it", () => {
  it("keeps candidates the build phase never loaded", async () => {
    // This is the failure mode of reading progress only: the bucket in hand has
    // an empty pool, the row has three, and a merge against the argument would
    // write the three away and leave the project with one candidate.
    const { buildCorpusCell, loadCorpusProgress } = await import("../stock-corpus-store.server");
    db.found = [candidate("fresh-1")];
    const [progressBucket] = await loadCorpusProgress(PROJECT);

    const updated = await buildCorpusCell({
      projectId: PROJECT,
      bucket: progressBucket,
      provider: "pixabay",
      orientation: "landscape",
      targetWidth: 1920,
      session: undefined as never,
    });

    expect(updated.candidates.map((c) => c.provider_clip_id)).toEqual([
      "stored-1",
      "stored-2",
      "stored-3",
      "fresh-1",
    ]);
    expect(db.rows[0].candidates).toHaveLength(4);
    expect(updated.providersDone).toEqual(["pexels", "pixabay"]);
  });

  it("still deduplicates against what is already stored", async () => {
    const { buildCorpusCell, loadCorpusProgress } = await import("../stock-corpus-store.server");
    db.found = [candidate("stored-2"), candidate("fresh-1")];
    const [progressBucket] = await loadCorpusProgress(PROJECT);
    const updated = await buildCorpusCell({
      projectId: PROJECT,
      bucket: progressBucket,
      provider: "pixabay",
      orientation: "landscape",
      targetWidth: 1920,
      session: undefined as never,
    });
    expect(updated.candidates).toHaveLength(4);
  });
});

/**
 * MEASURED capture 44 against 42/43: the merge-base read costs ~255 ms, and
 * doing it per cell cost 21% of build throughput — 12.9 cells per invocation
 * down to 9.9, about 72s per project. pendingCorpusWork is bucket-major and a
 * space project is 5 cells per bucket (nasa x3 + pexels + pixabay, and 200
 * pending over 40 buckets confirms it), so ~10 cells span 2-3 buckets. Reading
 * once per bucket instead of once per cell is the difference.
 */
describe("the merge base is read once per bucket, not once per cell", () => {
  const cell = async (bucket: unknown, provider: "pexels" | "pixabay" | "nasa", queryIndex = 0) => {
    const { buildCorpusCell } = await import("../stock-corpus-store.server");
    return buildCorpusCell({
      projectId: PROJECT,
      bucket: bucket as never,
      provider,
      queryIndex,
      orientation: "landscape",
      targetWidth: 1920,
      session: undefined as never,
    });
  };
  const candidateReads = () => db.selects.filter((columns) => columns === "candidates").length;

  it("does not re-read for the second and third cell of the same bucket", async () => {
    // The build loop feeds each result back through byId, which is what makes
    // this reachable: after the first cell, the invocation holds the real pool.
    const { loadCorpusProgress } = await import("../stock-corpus-store.server");
    // expandNasaQueries dedupes its variants, so a three-token query yields only
    // two and the third cell searches nothing. Five tokens gives three real
    // queries, which is what a NASA bucket looks like in production.
    db.rows[0].query = "aerial coastline sunrise drone footage";
    const [progressBucket] = await loadCorpusProgress(PROJECT);

    db.found = [candidate("nasa-0")];
    let bucket = await cell(progressBucket, "nasa", 0);
    expect(candidateReads()).toBe(1);

    db.found = [candidate("nasa-1")];
    bucket = await cell(bucket, "nasa", 1);
    db.found = [candidate("nasa-2")];
    bucket = await cell(bucket, "nasa", 2);

    // Still one: NASA's three cells used to cost three reads of the same row.
    expect(candidateReads()).toBe(1);
    // And nothing was lost by trusting the pool in hand.
    expect(bucket.candidates.map((c) => c.provider_clip_id)).toEqual([
      "stored-1",
      "stored-2",
      "stored-3",
      "nasa-0",
      "nasa-1",
      "nasa-2",
    ]);
    expect(db.rows[0].candidates).toHaveLength(6);
  });

  it("does not read at all for a bucket that came from loadProjectCorpus", async () => {
    const { loadProjectCorpus } = await import("../stock-corpus-store.server");
    const [full] = await loadProjectCorpus(PROJECT);
    db.selects.length = 0;
    db.found = [candidate("fresh-1")];
    const updated = await cell(full, "pixabay");
    expect(candidateReads()).toBe(0);
    expect(updated.candidates).toHaveLength(4);
  });

  it("still reads for a bucket that carries no marker", async () => {
    // The safe default: forgetting the flag costs a round trip, never data. A
    // hand-built bucket with an empty pool must NOT be trusted.
    db.found = [candidate("fresh-1")];
    const updated = await cell(
      {
        id: "bucket-0",
        query: "slow drifting clouds",
        tokens: [],
        demandIds: [],
        candidates: [],
        providersDone: [],
      },
      "pixabay",
    );
    expect(candidateReads()).toBe(1);
    expect(updated.candidates).toHaveLength(4);
    expect(db.rows[0].candidates).toHaveLength(4);
  });

  it("marks what it returns, or the loop would read every time", async () => {
    const { loadCorpusProgress } = await import("../stock-corpus-store.server");
    const [progressBucket] = await loadCorpusProgress(PROJECT);
    expect(progressBucket.candidatesLoaded).toBeUndefined();
    expect((await cell(progressBucket, "pixabay")).candidatesLoaded).toBe(true);
  });
});

/**
 * A cell whose bucket is already full does not search at all.
 *
 * MEASURED across captures 50, 51 and 52: corpusCellAtCapPixabay was 40 of 40
 * buckets every time. Providers run pexels -> pixabay (nasa first on a space
 * project), so Pexels fills the bucket to the 120 cap and every Pixabay cell
 * then made two sequential HTTP calls for results that could not be stored.
 *
 * Provably lossless: `stored` is already deduped and already at the cap, so
 * dedupeById([...stored, ...found]).slice(0, cap) === stored for ANY `found`.
 * The merge cannot change the row; only the providers_done marker can. So the
 * search and the candidates rewrite are both skipped and only the marker is
 * written.
 *
 * The win is INVOCATION COUNT rather than HTTP: a skipped cell costs
 * milliseconds, so far more cells fit inside the 12s budget.
 */
describe("a cell whose bucket is at the cap skips the search entirely", () => {
  const profileFor = async () => {
    const { createMatchingProfile } = await import("../matching-profile");
    return createMatchingProfile();
  };
  const cellWith = async (
    profile: Awaited<ReturnType<typeof profileFor>>,
    provider: "pexels" | "pixabay" | "nasa",
    queryIndex = 0,
  ) => {
    const { buildCorpusCell, loadCorpusProgress } = await import("../stock-corpus-store.server");
    const [bucket] = await loadCorpusProgress(PROJECT);
    return buildCorpusCell({
      projectId: PROJECT,
      bucket,
      provider,
      queryIndex,
      orientation: "landscape",
      targetWidth: 1920,
      niche: "space",
      session: { profile } as never,
    });
  };

  const full = () =>
    Array.from({ length: 120 }, (_, index) => candidate(`stored-${index}`));

  it("issues no provider request for a bucket already at the cap", async () => {
    db.rows[0].candidates = full();
    // Results are waiting to be returned; the point is that nothing asks.
    db.found = [candidate("fresh-1"), candidate("fresh-2")];
    const profile = await profileFor();
    await cellWith(profile, "pexels");

    const summary = profile.summary();
    expect(summary.corpusCellAtCapPexels).toBe(1);
    // No search happened, so nothing was found and nothing was thrown away.
    expect(summary.corpusCandidatesFound).toBe(0);
    expect(summary.corpusCandidatesDiscarded).toBe(0);
  });

  it("leaves the stored pool byte-identical", async () => {
    db.rows[0].candidates = full();
    const before = JSON.stringify(db.rows[0].candidates);
    db.found = [candidate("fresh-1")];
    const updated = await cellWith(await profileFor(), "pexels");

    // The guardrail: candidates STORED PER BUCKET must not drop.
    expect(JSON.stringify(db.rows[0].candidates)).toBe(before);
    expect(updated.candidates).toHaveLength(120);
  });

  it("writes only the marker, never the candidates column", async () => {
    db.rows[0].candidates = full();
    db.updates.length = 0;
    const updated = await cellWith(await profileFor(), "pexels");

    expect(db.updates).toHaveLength(1);
    // Sending 120 candidates back to store what is already there is ~98 kB per
    // skipped cell — and there are ~40 of them per project.
    expect(db.updates[0]).not.toHaveProperty("candidates");
    expect(db.updates[0]).toHaveProperty("providers_done");
    // Still marked done, so the cell is never revisited.
    expect(updated.providersDone).toContain("pexels");
    expect(db.rows[0].providers_done).toContain("pexels");
  });

  it("still searches a bucket one candidate short of the cap", async () => {
    // The boundary is >=, so 119 must behave exactly as before.
    db.rows[0].candidates = Array.from({ length: 119 }, (_, i) => candidate(`stored-${i}`));
    db.found = [candidate("fresh-1"), candidate("fresh-2")];
    const profile = await profileFor();
    const updated = await cellWith(profile, "pexels");

    expect(profile.summary().corpusCellAtCapPexels).toBeUndefined();
    expect(profile.summary().corpusCandidatesFound).toBe(2);
    // 121 deduped, capped back to 120 — one genuinely discarded.
    expect(profile.summary().corpusCandidatesDiscarded).toBe(1);
    expect(updated.candidates).toHaveLength(120);
  });

  it("does not flag a cell whose results the bucket could still hold", async () => {
    db.found = [candidate("fresh-1")];
    const profile = await profileFor();
    await cellWith(profile, "pixabay");

    const summary = profile.summary();
    expect(summary.corpusCellAtCapPixabay).toBeUndefined();
    expect(summary.corpusCandidatesDiscarded).toBe(0);
  });

  it("counts a NASA cell that had no query to search", async () => {
    // expandNasaQueries dedupes to two variants for this bucket query, so
    // nasa#2 issues no HTTP at all while still counting as a cell built.
    const profile = await profileFor();
    const updated = await cellWith(profile, "nasa", 2);

    expect(profile.summary().corpusCellsNoQuery).toBe(1);
    expect(profile.summary().corpusCandidatesFound).toBe(0);
    // Still marked done, exactly as before — this is a measurement, not a fix.
    expect(updated.providersDone).toContain("nasa#2");
  });

  it("leaves a real NASA cell uncounted", async () => {
    db.rows[0].query = "aerial coastline sunrise drone footage";
    db.found = [candidate("nasa-a")];
    const profile = await profileFor();
    await cellWith(profile, "nasa", 2);
    expect(profile.summary().corpusCellsNoQuery).toBeUndefined();
  });
});

/**
 * prepareCorpus lives inside advanceFromMatchingFootage, which is ~600 lines of
 * pipeline state and cannot be called from a test. These pin the three points
 * that decide whether assignment sees a whole corpus, read from the source.
 */
describe("assignment is still handed the whole corpus", () => {
  const source = readFileSync(resolve(process.cwd(), "src/lib/pipeline.functions.ts"), "utf8");
  const prepare = source.slice(
    source.indexOf("const prepareCorpus = async () => {"),
    source.indexOf("if (fixedDuration != null && fixedDuration > 0)"),
  );

  it("reads progress to decide what to build", () => {
    expect(prepare.length).toBeGreaterThan(0);
    expect(prepare).toMatch(/let progress = await loadCorpusProgress\(projectId\)/);
    expect(prepare).toMatch(/pendingCorpusWork\(progress, corpusProviders\)/);
  });

  it("re-reads the whole corpus on every path that hands one to assignment", () => {
    // Three returns say complete: the memo, the nothing-left-to-build exit, and
    // the build finishing inside this invocation. Each must carry a corpus that
    // came from loadProjectCorpus — directly, or from the memo, which the test
    // below pins to the same source.
    const completions = prepare.match(/return \{[^{}]*complete: true as const[^{}]*\}/g) ?? [];
    expect(completions).toHaveLength(3);
    for (const completion of completions) {
      const returned = completion.match(/corpus: (\w+)/)?.[1];
      expect(returned, completion).toBeTruthy();
      if (returned === "memo") continue;
      expect(prepare).toMatch(
        new RegExp(`const ${returned} = await loadProjectCorpus\\(projectId\\)`),
      );
    }
    // And the one incomplete return must NOT claim to be usable.
    expect(prepare).toMatch(/complete: false as const/);
  });

  it("never caches a corpus that came from a progress read", () => {
    for (const cached of prepare.match(/cacheCompleteCorpus\(projectId, (\w+)\)/g) ?? []) {
      const name = cached.match(/, (\w+)\)/)![1];
      expect(prepare).toMatch(new RegExp(`const ${name} = await loadProjectCorpus\\(projectId\\)`));
    }
    expect(prepare).not.toMatch(/cacheCompleteCorpus\(projectId, progress\)/);
  });

  it("leaves the memo and the round-8 invariant alone", () => {
    expect(prepare).toMatch(/const memo = getCachedCorpus\(projectId\)/);
    expect(source).toMatch(/The corpus must be whole before a single scene is assigned\./);
  });
});
