/**
 * Process-local cache for the data a matching invocation re-reads every time.
 *
 * WHY. Round 8 measured setupMs at ~3.4s per invocation. The payloads are not
 * large; the round trips are. A single invocation's setup made seven or eight
 * sequential requests to Supabase — cancel check, project, scenes, audio asset,
 * existing slices, corpus, visual queries — and on a VPS talking to hosted
 * Supabase each one costs 200-400ms of pure latency. Seven of those IS 3.4s.
 *
 * Three of those reads return data that CANNOT change while matching runs:
 *
 *   - the scene skeleton (id, idx, start_ts, end_ts) — scenes are written once
 *     by generate-scenes and deleted wholesale on regeneration, never edited
 *   - each scene's visual_query — same lifecycle
 *   - the corpus, once complete — buckets are written during the build phase and
 *     never touched again; assignment only reads
 *
 * So they are cached in memory and re-read only when the process is new or the
 * entry has expired. Everything that DOES change during matching (slices,
 * project status, the cancel flag) is still read from the database every time.
 *
 * SAFETY. Scene regeneration deletes the scenes and clears the corpus; both call
 * `invalidateMatchingCache`, so a stale entry cannot outlive the data it
 * describes within a process. Across processes the entries are independent and
 * each is populated from the database, so a second process simply misses the
 * cache — it never sees another process's stale copy. The TTL is the backstop
 * for the one case neither covers: a project whose scenes were deleted by some
 * path that did not go through this module.
 *
 * This is a latency cache, never a source of truth. Every value here is
 * reconstructible from the database, and a cold process behaves identically —
 * only slower.
 */

import type { CorpusBucket } from "@/lib/stock-corpus-store.server";

/** Entries older than this are re-read. A matching run is minutes, not hours. */
const TTL_MS = 15 * 60 * 1000;

/**
 * Projects held at once. Matching is single-flight per project and the server
 * handles a handful concurrently, so this is generous; the cap exists to bound
 * memory on a long-lived process, not to be tuned.
 */
const MAX_PROJECTS = 8;

export type SceneSkeleton = {
  id: string;
  idx: number;
  start_ts: number | string;
  end_ts: number | string;
};

type Entry = {
  storedAt: number;
  scenes?: SceneSkeleton[];
  visualQueries?: Map<string, string>;
  /** Only ever stored once every bucket has been fully searched. */
  corpus?: CorpusBucket[];
};

const entries = new Map<string, Entry>();

function live(projectId: string, now: number): Entry | undefined {
  const entry = entries.get(projectId);
  if (!entry) return undefined;
  if (now - entry.storedAt > TTL_MS) {
    entries.delete(projectId);
    return undefined;
  }
  // Refresh insertion order so the least recently USED entry is the one evicted.
  entries.delete(projectId);
  entries.set(projectId, entry);
  return entry;
}

function upsert(projectId: string, patch: Partial<Entry>, now: number): void {
  const existing = live(projectId, now);
  const entry: Entry = { ...(existing ?? { storedAt: now }), ...patch, storedAt: now };
  entries.set(projectId, entry);
  while (entries.size > MAX_PROJECTS) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

export function getCachedScenes(
  projectId: string,
  now: number = Date.now(),
): SceneSkeleton[] | undefined {
  return live(projectId, now)?.scenes;
}

export function cacheScenes(
  projectId: string,
  scenes: SceneSkeleton[],
  now: number = Date.now(),
): void {
  upsert(projectId, { scenes }, now);
}

export function getCachedVisualQueries(
  projectId: string,
  now: number = Date.now(),
): Map<string, string> | undefined {
  return live(projectId, now)?.visualQueries;
}

export function cacheVisualQueries(
  projectId: string,
  queries: Map<string, string>,
  now: number = Date.now(),
): void {
  upsert(projectId, { visualQueries: new Map(queries) }, now);
}

/**
 * Merges newly-read queries into whatever is already known.
 *
 * The first invocation reads every scene's query to cluster the corpus; later
 * ones read only the scenes they are about to match. Merging means the cache
 * fills from either path and the partial reads stop happening once it is whole.
 */
export function mergeVisualQueries(
  projectId: string,
  queries: Map<string, string>,
  now: number = Date.now(),
): void {
  const existing = getCachedVisualQueries(projectId, now);
  if (!existing) {
    cacheVisualQueries(projectId, queries, now);
    return;
  }
  for (const [sceneId, query] of queries) existing.set(sceneId, query);
  upsert(projectId, { visualQueries: existing }, now);
}

export function getCachedCorpus(
  projectId: string,
  now: number = Date.now(),
): CorpusBucket[] | undefined {
  return live(projectId, now)?.corpus;
}

/**
 * Caches the corpus, but ONLY when it is complete.
 *
 * A partially-built corpus is the one thing that must never be served from
 * memory: the build phase decides what work remains by looking at the corpus it
 * loaded, so a stale partial copy would either re-search cells already stored or
 * declare the build finished early — and assignment against a partial pool is
 * precisely the defect round 8 fixed.
 */
export function cacheCompleteCorpus(
  projectId: string,
  corpus: CorpusBucket[],
  now: number = Date.now(),
): void {
  upsert(projectId, { corpus }, now);
}

/** Drops everything known about a project. Call when its scenes change. */
export function invalidateMatchingCache(projectId: string): void {
  entries.delete(projectId);
}

/** Test seam: forget every project. */
export function resetMatchingCache(): void {
  entries.clear();
}
