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
 * Reads the whole corpus for a project.
 *
 * Deliberately unfiltered: assignment must see every bucket, because that is the
 * property whose absence caused late scenes to fail. The cost is bounded by
 * distillation and the per-bucket cap rather than by narrowing the query.
 */
export async function loadProjectCorpus(projectId: string): Promise<CorpusBucket[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("project_stock_corpus")
    .select("bucket_id, query, tokens, demand_ids, candidates, providers_done")
    .eq("project_id", projectId);
  if (error) throw new Error(`Corpus load failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.bucket_id,
    query: row.query,
    tokens: Array.isArray(row.tokens) ? (row.tokens as string[]) : stockQueryTokens(row.query),
    demandIds: Array.isArray(row.demand_ids) ? (row.demand_ids as string[]) : [],
    candidates: Array.isArray(row.candidates) ? (row.candidates as unknown as StockVideo[]) : [],
    providersDone: Array.isArray(row.providers_done) ? (row.providers_done as string[]) : [],
  }));
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
  return buckets.map((bucket) => ({ ...bucket, candidates: [], providersDone: [] }));
}

/** The (bucket, provider) pairs still to search, in a stable order. */
export function pendingCorpusWork(
  buckets: CorpusBucket[],
  providers: CorpusProvider[],
): Array<{ bucket: CorpusBucket; provider: CorpusProvider }> {
  return buckets.flatMap((bucket) =>
    providers
      .filter((provider) => !bucket.providersDone.includes(provider))
      .map((provider) => ({ bucket, provider })),
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
  orientation: Orientation;
  targetWidth: number;
  niche?: string | null;
  session: StockSearchSession;
}): Promise<CorpusBucket> {
  const { bucket, provider } = opts;
  const spaceBias = opts.niche === "space";

  let found: StockVideo[] = [];
  try {
    if (provider === "nasa") {
      for (const query of expandNasaQueries(bucket.query).slice(0, 3)) {
        found.push(
          ...(await searchProviderCandidatePool({
            provider: "nasa",
            query,
            orientation: opts.orientation,
            targetWidth: opts.targetWidth,
            seed: `${opts.projectId}:${bucket.id}:${query}`,
            session: opts.session,
          })),
        );
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

  const merged = dedupeById([...bucket.candidates, ...found.map(distillCandidate)]).slice(
    0,
    CORPUS_CANDIDATES_PER_BUCKET * 3,
  );
  const providersDone = [...new Set([...bucket.providersDone, provider])];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("project_stock_corpus")
    .update({
      candidates: merged as unknown as never,
      providers_done: providersDone as unknown as never,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", opts.projectId)
    .eq("bucket_id", bucket.id);
  if (error) throw new Error(`Corpus cell write failed: ${error.message}`);

  return { ...bucket, candidates: merged, providersDone };
}

/** Discards a project's corpus, so a re-match rebuilds it from scratch. */
export async function clearProjectCorpus(projectId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("project_stock_corpus").delete().eq("project_id", projectId);
}
