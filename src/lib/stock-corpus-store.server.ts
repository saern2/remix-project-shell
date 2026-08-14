/**
 * Persistence for the project-wide stock corpus.
 *
 * WHY THIS EXISTS. Round 6 sliced matching into ~12s invocations, and clustering
 * was sliced along with it: matchStockCorpus clustered whatever demands it was
 * handed, so a 5-scene slice produced 5 buckets and 5 fresh provider queries.
 * Across 29 slices that is ~145 distinct cluster queries where a whole-project
 * clustering needs ~37 — the measured 244 cache misses against 33 hits. Worse,
 * assignment could only see its own slice's pools, so project-wide uniqueness
 * drained them and late scenes found everything already reserved.
 *
 * The corpus is therefore clustered ONCE over every scene, built incrementally
 * under the same time budget, and read WHOLE at assignment time. Candidates are
 * distilled and capped so "read whole" is one small query, not the multi-megabyte
 * prefetch round 6 correctly removed from the hot path.
 */

import {
  clusterStockQueries,
  type StockDemand,
  type StockQueryBucket,
} from "@/lib/stock-corpus.server";
import {
  expandNasaQueries,
  searchProviderCandidatePool,
  stockQueryTokens,
  type Orientation,
  type StockSearchSession,
  type StockVideo,
} from "@/lib/stock.server";

/**
 * Candidates kept per bucket. With ~37 buckets that is ~1,500 sources for a
 * 145-scene project — two orders of magnitude more than a slice ever saw, and
 * still small enough to load in a single query. Uniqueness needs breadth, not
 * every result the provider returned.
 */
export const CORPUS_CANDIDATES_PER_BUCKET = 40;

/** Keywords are for relevance scoring; a dozen carries the signal. */
const MAX_KEYWORDS = 12;
/** Renditions are for download + oversize fall-through. */
const MAX_FILES = 5;

export type CorpusBucket = StockQueryBucket & {
  candidates: StockVideo[];
  providersDone: string[];
  /**
   * Whether `candidates` is the row's real pool, or just an empty array because
   * the read that produced this bucket did not ask for it.
   *
   * Set by loadProjectCorpus and by buildCorpusCell's return; absent on
   * loadCorpusProgress. buildCorpusCell reads the stored pool only when this is
   * not true, so a bucket built more than once in an invocation — NASA is three
   * cells per bucket — is fetched once rather than three times.
   *
   * OPTIONAL AND UNSET-MEANS-RELOAD, deliberately. A future loader that forgets
   * to set it makes the build slower, never wrong; the opposite default would
   * merge into an empty pool and write the row's candidates away.
   */
  candidatesLoaded?: boolean;
};

export type CorpusProvider = "pexels" | "pixabay" | "nasa";

/**
 * Strips a provider result down to what ranking, uniqueness and download need.
 *
 * A raw Pexels/Pixabay video is 1-2 KB of JSON, most of it renditions and
 * metadata nothing downstream reads. Storing them whole would make loading the
 * project corpus a multi-megabyte read on every invocation — exactly the cost
 * round 6 removed. Distilled, the same corpus is a few hundred KB.
 */
export function distillCandidate(video: StockVideo): StockVideo {
  return {
    provider: video.provider,
    provider_clip_id: video.provider_clip_id,
    duration_sec: video.duration_sec,
    ...(video.duration_known === undefined ? {} : { duration_known: video.duration_known }),
    width: video.width,
    height: video.height,
    thumbnail_url: video.thumbnail_url,
    files: video.files.slice(0, MAX_FILES).map((file) => ({
      url: file.url,
      width: file.width,
      height: file.height,
      ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
    })),
    ...(video.title ? { title: video.title.slice(0, 200) } : {}),
    ...(video.keywords?.length ? { keywords: video.keywords.slice(0, MAX_KEYWORDS) } : {}),
    ...(video.has_captions === undefined ? {} : { has_captions: video.has_captions }),
  };
}

/** Provider name as a telemetry-key suffix: "pexels" -> "Pexels". */
function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function dedupeById(videos: StockVideo[]): StockVideo[] {
  const seen = new Set<string>();
  return videos.filter((video) => {
    const key = `${video.provider}:${video.provider_clip_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Buckets read per statement.
 *
 * MEASURED 2026-08-12 against production rows: a full 40-bucket corpus is
 * ~490 kB stored but ~3.9 MB on the wire, because jsonb is stored TOAST-
 * compressed and PostgREST serialises it back out as JSON text — an ~8x
 * expansion. Nearly all of that is CPU rather than I/O: an index scan over the
 * same rows measures 1.8 ms, detoasting and serialising them ~105 ms on an idle
 * box. (EXPLAIN ANALYZE hides this — it never materialises the output.)
 *
 * PostgREST reaches Postgres as `authenticator`, whose statement_timeout is 8s.
 * service_role has none set, and role settings apply at LOGIN only, so
 * PostgREST's SET ROLE never picks up a service_role setting. One statement
 * carrying the whole corpus therefore has to fit its entire serialisation
 * inside those 8s — and under CPU contention it did not, which is the observed
 * "canceling statement due to statement timeout" on corpus load.
 *
 * Ten buckets is ~1 MB per statement. This does not make the work smaller; it
 * stops any single statement approaching the ceiling, giving the same total
 * work roughly four times the headroom it had.
 */
const CORPUS_READ_BUCKETS_PER_STATEMENT = 10;

/**
 * Backstop on the paging loop. bucket_id is unique within a project — it is
 * half the primary key — so `gt(bucket_id, last)` strictly advances and the
 * loop terminates on its own. This bounds it anyway, and throws rather than
 * returning what it has: a short corpus would let assignment run against a
 * partial pool, which is the exact failure round 8 exists to prevent.
 */
const CORPUS_READ_MAX_STATEMENTS = 200;

/**
 * Reads the whole corpus for a project.
 *
 * Deliberately unfiltered: assignment must see every bucket, because that is the
 * property whose absence caused late scenes to fail. The cost is bounded by
 * distillation and the per-bucket cap rather than by narrowing the query.
 *
 * The read is SPLIT across statements — see CORPUS_READ_BUCKETS_PER_STATEMENT —
 * but the result is not. Callers still get every bucket, and the signature is
 * unchanged.
 */
export async function loadProjectCorpus(projectId: string): Promise<CorpusBucket[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const buckets: CorpusBucket[] = [];
  let after: string | null = null;

  for (let statement = 0; statement < CORPUS_READ_MAX_STATEMENTS; statement += 1) {
    let filter = supabaseAdmin
      .from("project_stock_corpus")
      .select("bucket_id, query, tokens, demand_ids, candidates, providers_done")
      .eq("project_id", projectId);
    // Keyset, not offset: each statement re-enters the (project_id, bucket_id)
    // primary key exactly where the last one stopped, so paging costs no more in
    // total than the single read did, and a row updated mid-read cannot shift a
    // bucket across a page boundary and be skipped or repeated.
    if (after !== null) filter = filter.gt("bucket_id", after);

    const { data, error } = await filter
      .order("bucket_id", { ascending: true })
      .limit(CORPUS_READ_BUCKETS_PER_STATEMENT);
    if (error) throw new Error(`Corpus load failed: ${error.message}`);

    const rows = data ?? [];
    // Stops on an EMPTY page, not a short one. PostgREST can cap a response
    // below the requested limit (db-max-rows), and reading "fewer than asked
    // for" as "that was the last of them" would silently truncate the corpus.
    // The cost of being sure is one extra statement that returns no rows, which
    // detoasts nothing.
    if (rows.length === 0) return buckets;

    for (const row of rows) {
      buckets.push({
        id: row.bucket_id,
        query: row.query,
        tokens: Array.isArray(row.tokens) ? (row.tokens as string[]) : stockQueryTokens(row.query),
        demandIds: Array.isArray(row.demand_ids) ? (row.demand_ids as string[]) : [],
        candidates: Array.isArray(row.candidates)
          ? (row.candidates as unknown as StockVideo[])
          : [],
        candidatesLoaded: true,
        providersDone: Array.isArray(row.providers_done) ? (row.providers_done as string[]) : [],
      });
    }
    after = rows[rows.length - 1].bucket_id;
  }

  throw new Error(
    `Corpus load failed: paging did not finish after ${CORPUS_READ_MAX_STATEMENTS} statements ` +
      `(${buckets.length} buckets read for project ${projectId})`,
  );
}

/**
 * Reads what the BUILD phase needs, and nothing else.
 *
 * pendingCorpusWork reads only `providersDone`; buildCorpusCell needs the
 * bucket's `id` and `query` to search. None of them touch `candidates` — and
 * candidates are the entire cost: ~98 kB per bucket on the wire against ~120 B
 * for the rest of the row. A 40-bucket corpus is ~3.9 MB read this way and
 * ~8 kB read that way, and the build phase runs ~20 times per project.
 *
 * The returned buckets carry `candidates: []` — NOT because the buckets are
 * empty, but because this read did not ask for them. That is safe for deciding
 * what work remains and for scheduling cells; it is NOT a corpus, and must
 * never reach assignment, which needs every candidate to make a scene unique.
 * prepareCorpus therefore re-reads the whole corpus with loadProjectCorpus at
 * the moment the build finishes.
 */
export async function loadCorpusProgress(projectId: string): Promise<CorpusBucket[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // One statement: without candidates the whole result is a few kB, nowhere
  // near the 8s ceiling that made loadProjectCorpus page.
  const { data, error } = await supabaseAdmin
    .from("project_stock_corpus")
    .select("bucket_id, query, tokens, demand_ids, providers_done")
    .eq("project_id", projectId)
    .order("bucket_id", { ascending: true });
  if (error) throw new Error(`Corpus progress load failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.bucket_id,
    query: row.query,
    tokens: Array.isArray(row.tokens) ? (row.tokens as string[]) : stockQueryTokens(row.query),
    demandIds: Array.isArray(row.demand_ids) ? (row.demand_ids as string[]) : [],
    candidates: [],
    providersDone: Array.isArray(row.providers_done) ? (row.providers_done as string[]) : [],
  }));
}

/**
 * One bucket's stored pool — the merge base for the cell about to be written.
 *
 * MEASURED 2026-08-12, capture 44 against 42/43: this read costs ~255 ms, and
 * doing it per CELL cost 21% of build throughput (12.9 -> 9.9 cells per
 * invocation). pendingCorpusWork is bucket-major and a space project is 5 cells
 * per bucket, so ~10 cells span 2-3 buckets — hence candidatesLoaded, which
 * makes this once per bucket rather than once per cell.
 */
async function loadBucketCandidates(projectId: string, bucketId: string): Promise<StockVideo[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("project_stock_corpus")
    .select("candidates")
    .eq("project_id", projectId)
    .eq("bucket_id", bucketId)
    .maybeSingle();
  if (error) throw new Error(`Corpus bucket read failed: ${error.message}`);
  return Array.isArray(data?.candidates) ? (data.candidates as unknown as StockVideo[]) : [];
}

/**
 * Clusters every scene in the project into buckets and persists them, once.
 *
 * Clustering is deterministic for a given demand set, but it is persisted rather
 * than recomputed so that later invocations cannot silently re-cluster against a
 * different demand list (say, after some scenes are matched) and start searching
 * a different set of queries — which is the regression this whole file exists to
 * undo.
 */
export async function ensureProjectBuckets(
  projectId: string,
  allDemands: StockDemand[],
): Promise<CorpusBucket[]> {
  const existing = await loadProjectCorpus(projectId);
  if (existing.length > 0) return existing;
  if (allDemands.length === 0) return [];

  const buckets = clusterStockQueries(allDemands);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rows = buckets.map((bucket) => ({
    project_id: projectId,
    bucket_id: bucket.id,
    query: bucket.query,
    tokens: bucket.tokens as unknown as never,
    demand_ids: bucket.demandIds as unknown as never,
    candidates: [] as unknown as never,
    providers_done: [] as unknown as never,
  }));
  const { error } = await supabaseAdmin
    .from("project_stock_corpus")
    .upsert(rows, { onConflict: "project_id,bucket_id" });
  if (error) throw new Error(`Corpus bucket write failed: ${error.message}`);

  console.info("[corpus] clustered project", {
    projectId,
    scenes: allDemands.length,
    buckets: buckets.length,
  });
  // Marked: these rows were just written empty, so the pool in hand is the real
  // one and the first cell of each bucket need not read it back.
  return buckets.map((bucket) => ({
    ...bucket,
    candidates: [],
    candidatesLoaded: true,
    providersDone: [],
  }));
}

/**
 * NASA queries per bucket. expandNasaQueries widens a bucket query into related
 * phrasings; three is what the matcher used before the corpus existed.
 */
export const NASA_QUERIES_PER_BUCKET = 3;

/**
 * A single unit of corpus work: one bucket, one provider, one query.
 *
 * NASA used to be one cell that ran all three of its queries in a loop. A cell
 * cannot be preempted, so on a space project that made the smallest schedulable
 * unit three sequential HTTP searches — which is how invocations reached 17s
 * against a 12s budget. One query per cell makes the budget able to stop.
 */
export type CorpusCell = {
  bucket: CorpusBucket;
  provider: CorpusProvider;
  /** Which of the provider's queries this cell covers. */
  queryIndex: number;
};

/** The stable identifier stored in providers_done once a cell is searched. */
export function corpusCellKey(provider: CorpusProvider, queryIndex: number): string {
  // pexels/pixabay keep their bare provider name so rows written before cells
  // were split still read as done.
  return provider === "nasa" ? `nasa#${queryIndex}` : provider;
}

function cellsForProvider(provider: CorpusProvider): number {
  return provider === "nasa" ? NASA_QUERIES_PER_BUCKET : 1;
}

/** The (bucket, provider, query) cells still to search, in a stable order. */
export function pendingCorpusWork(
  buckets: CorpusBucket[],
  providers: CorpusProvider[],
): CorpusCell[] {
  return buckets.flatMap((bucket) =>
    providers.flatMap((provider) => {
      // A row written before cells were split records a bare "nasa" for the
      // whole provider. Honour it rather than re-searching all three queries.
      if (bucket.providersDone.includes(provider) && provider === "nasa") return [];
      return Array.from({ length: cellsForProvider(provider) }, (_, queryIndex) => ({
        bucket,
        provider,
        queryIndex,
      })).filter(
        (cell) => !bucket.providersDone.includes(corpusCellKey(provider, cell.queryIndex)),
      );
    }),
  );
}

/**
 * Searches one (bucket, provider) pair and merges the result into the bucket's
 * stored pool.
 *
 * Merging rather than replacing is what lets providers accumulate: a bucket ends
 * up holding Pexels + Pixabay (+ NASA) candidates together, which is the pool
 * assignment then ranks across.
 */
export async function buildCorpusCell(opts: {
  projectId: string;
  bucket: CorpusBucket;
  provider: CorpusProvider;
  queryIndex?: number;
  orientation: Orientation;
  targetWidth: number;
  niche?: string | null;
  session: StockSearchSession;
}): Promise<CorpusBucket> {
  const { bucket, provider } = opts;
  const queryIndex = opts.queryIndex ?? 0;
  const spaceBias = opts.niche === "space";

  const profile = opts.session?.profile;
  const cap = CORPUS_CANDIDATES_PER_BUCKET * 3;

  // Read the merge base BEFORE searching. Merged against what is STORED, not
  // against the bucket handed in: the build phase loads progress only, so
  // `bucket.candidates` is routinely empty while the row holds everything the
  // earlier cells found, and merging against the argument would write those
  // away. Unless the caller already has the real pool — loadProjectCorpus marks
  // its buckets, and so does this function's own return value, which the build
  // loop stores back, so the row is read once per bucket per invocation rather
  // than once per cell.
  const stored =
    bucket.candidatesLoaded === true
      ? bucket.candidates
      : await loadBucketCandidates(opts.projectId, bucket.id);

  // A FULL BUCKET MAKES THIS CELL'S SEARCH PROVABLY POINTLESS.
  //
  // `stored` is already deduped and already at the cap, so
  // dedupeById([...stored, ...found]).slice(0, cap) === stored for any `found`
  // whatsoever. The merge cannot change the row; only the providers_done marker
  // can. So the search, its two sequential HTTP calls, and the rewrite of the
  // candidates column are all skipped, and the cell completes in one small
  // write.
  //
  // MEASURED across captures 50, 51 and 52: corpusCellAtCapPixabay was 40 of 40
  // buckets every time. Providers run pexels -> pixabay (nasa first on a space
  // project), so Pexels fills the bucket and every Pixabay cell then searched a
  // bucket it could not add to. That is half the corpus cells on a general
  // project doing two round trips for nothing, and the win is in INVOCATION
  // COUNT: a skipped cell costs milliseconds, so far more cells fit inside the
  // 12s budget.
  //
  // The marker is still written, so the cell is never revisited. If the cap is
  // ever raised, buckets already marked will not be re-searched — the same
  // property providers_done has always had.
  const atCap = stored.length >= cap;
  if (atCap) profile?.count(`corpusCellAtCap${capitalize(provider)}`);

  let found: StockVideo[] = [];
  try {
    if (atCap) {
      // Nothing to search for.
    } else if (provider === "nasa") {
      // Exactly one query per cell — see CorpusCell for why this is not a loop.
      const query = expandNasaQueries(bucket.query).slice(0, NASA_QUERIES_PER_BUCKET)[queryIndex];
      // expandNasaQueries dedupes its four variants, so a short bucket query
      // yields fewer than NASA_QUERIES_PER_BUCKET and the trailing cells search
      // nothing at all. They cost no HTTP but they are counted as cells built,
      // which dilutes every per-cell average computed from that number.
      if (!query) profile?.count("corpusCellsNoQuery");
      if (query) {
        found = await searchProviderCandidatePool({
          provider: "nasa",
          query,
          orientation: opts.orientation,
          targetWidth: opts.targetWidth,
          seed: `${opts.projectId}:${bucket.id}:${query}`,
          session: opts.session,
        });
      }
    } else {
      found = await searchProviderCandidatePool({
        provider,
        query: spaceBias ? `${bucket.query} space astronomy cosmos` : bucket.query,
        orientation: opts.orientation,
        targetWidth: opts.targetWidth,
        seed: `${opts.projectId}:${bucket.id}`,
        session: opts.session,
      });
    }
  } catch (error) {
    // A provider outage must not strand the corpus: mark the cell done so the
    // build can finish and assignment can work with whatever else was found.
    console.warn("[corpus] provider search failed; continuing without it", {
      projectId: opts.projectId,
      bucket: bucket.id,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const deduped = atCap ? stored : dedupeById([...stored, ...found.map(distillCandidate)]);
  const merged = atCap ? stored : deduped.slice(0, cap);

  profile?.count("corpusCandidatesFound", found.length);
  profile?.count("corpusCandidatesDiscarded", deduped.length - merged.length);
  const providersDone = [
    ...new Set([...bucket.providersDone, corpusCellKey(provider, queryIndex)]),
  ];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // A skipped cell writes only the marker. `merged` is `stored` by identity, so
  // sending the candidates column back would ship ~98 kB to store what is
  // already there.
  const patch = atCap
    ? { providers_done: providersDone as unknown as never, updated_at: new Date().toISOString() }
    : {
        candidates: merged as unknown as never,
        providers_done: providersDone as unknown as never,
        updated_at: new Date().toISOString(),
      };
  const { error } = await supabaseAdmin
    .from("project_stock_corpus")
    .update(patch)
    .eq("project_id", opts.projectId)
    .eq("bucket_id", bucket.id);
  if (error) throw new Error(`Corpus cell write failed: ${error.message}`);

  // Marked: `merged` is the pool that was just written, so the next cell for
  // this bucket needs no read of its own.
  return { ...bucket, candidates: merged, candidatesLoaded: true, providersDone };
}

/** Discards a project's corpus, so a re-match rebuilds it from scratch. */
export async function clearProjectCorpus(projectId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("project_stock_corpus").delete().eq("project_id", projectId);
}
