import {
  buildNasaSourceWindows,
  expandNasaQueries,
  fallbackRenditions,
  meetsMinimumSourceDuration,
  selectRenditionForTarget,
  prefetchStockProviderCache,
  searchProviderCandidatePool,
  stockQueryTokens,
  stockReservationKey,
  withinSourceDurationBudget,
  type Orientation,
  type ProjectNiche,
  type StockSearchResult,
  type StockSearchSession,
  type StockVideo,
} from "@/lib/stock.server";
import { nasaRelevanceScore, scoreNasaCandidate } from "@/lib/nasaStock.server";

export type StockDemand = {
  id: string;
  query: string;
  minDurationSec: number;
  seed: string;
  /**
   * Position on the timeline. Only the last-resort reuse tier reads it, and it
   * is what makes "never adjacent, maximise distance" expressible at all.
   */
  sceneIndex?: number;
};

/**
 * Where a source has already been used in this project: which in-point windows
 * are taken, and at which timeline positions.
 *
 * Rebuilt from persisted selections on every invocation, so it describes the
 * WHOLE project rather than the current slice — which is the point.
 */
export type SourceUsage = Map<string, { windows: Set<number>; sceneIndexes: number[] }>;

/** Which tier supplied a scene's clip. Reported so degradation is never silent. */
export type AssignmentTier = "unique" | "alternate-window" | "distant-reuse";

/**
 * Minimum timeline distance between two uses of the same source. Adjacent reuse
 * reads as a glitch; a dozen scenes apart reads as a motif.
 */
export const MIN_REUSE_SCENE_DISTANCE = 8;
/** Absolute floor. Below this a repeat is visible as a repeat, so we would rather fail. */
export const NEVER_REUSE_WITHIN = 2;

export type StockQueryBucket = {
  id: string;
  query: string;
  tokens: string[];
  demandIds: string[];
};

type MatchCorpusOptions = {
  projectId: string;
  demands: StockDemand[];
  orientation: Orientation;
  targetWidth: number;
  niche?: ProjectNiche | string | null;
  usedIds: Set<string>;
  /**
   * Required only for the legacy search-at-assignment path. The corpus path does
   * no I/O at all, so callers that pass `corpus` need not build a session — which
   * saves loading the provider key pool on every assignment invocation.
   */
  session?: StockSearchSession;
  /**
   * The project-wide corpus. When present, matchStockCorpus assigns from it and
   * performs NO searches of its own — clustering and provider work already
   * happened once, for the whole project, in the corpus phase.
   */
  corpus?: Array<StockQueryBucket & { candidates: StockVideo[] }>;
  /** Project-wide source usage, for the degradation tiers. */
  sourceUsage?: SourceUsage;
  /** Called for every scene that could not be matched uniquely. */
  onFallback?: (event: {
    demandId: string;
    tier: AssignmentTier;
    reason: string;
    sourceKey: string;
    sceneDistance: number | null;
  }) => void;
};

const MIN_RELEVANCE = 0.18;
const MAX_NASA_WINDOWS_PER_ASSET = 6;
const RECENT_SOURCE_WINDOW = 20;

export function clusterStockQueries(
  demands: StockDemand[],
  requestedBuckets?: number,
): StockQueryBucket[] {
  if (demands.length === 0) return [];
  const target = Math.min(
    demands.length,
    requestedBuckets ?? Math.min(40, Math.max(30, Math.ceil(demands.length / 4))),
  );
  const seedIndexes = Array.from({ length: target }, (_, index) =>
    Math.min(demands.length - 1, Math.floor((index * demands.length) / target)),
  );
  const seeds = seedIndexes.map((index) => demands[index]);
  const clusters = seeds.map((seed, index) => ({
    id: `bucket-${index}`,
    members: [] as StockDemand[],
    seed,
  }));

  for (const demand of demands) {
    const demandTokens = stockQueryTokens(demand.query);
    let best = clusters[0];
    let bestScore = -1;
    for (const cluster of clusters) {
      const score = jaccard(demandTokens, stockQueryTokens(cluster.seed.query));
      const balancedScore = score - cluster.members.length / Math.max(1, demands.length * 10);
      if (
        balancedScore > bestScore ||
        (balancedScore === bestScore && cluster.id.localeCompare(best.id) < 0)
      ) {
        best = cluster;
        bestScore = balancedScore;
      }
    }
    best.members.push(demand);
  }

  return clusters
    .filter((cluster) => cluster.members.length > 0)
    .map((cluster) => {
      const medoid = [...cluster.members].sort((a, b) => {
        const aScore = averageSimilarity(a, cluster.members);
        const bScore = averageSimilarity(b, cluster.members);
        return bScore - aScore || a.id.localeCompare(b.id);
      })[0];
      return {
        id: cluster.id,
        query: medoid.query,
        tokens: stockQueryTokens(medoid.query),
        demandIds: cluster.members.map((member) => member.id),
      };
    });
}

export async function matchStockCorpus(
  opts: MatchCorpusOptions,
): Promise<Map<string, StockSearchResult>> {
  // ── Corpus-backed path (round 8) ─────────────────────────────────────────
  // The pools were clustered and searched ONCE for the whole project. Assignment
  // therefore ranks across every bucket rather than the handful belonging to this
  // slice — the property whose loss made late scenes unmatchable.
  if (opts.corpus) return assignFromProjectCorpus(opts, opts.corpus);

  if (!opts.session) {
    throw new Error("matchStockCorpus needs a stock search session when no corpus is supplied.");
  }
  const session = opts.session;

  const buckets = clusterStockQueries(opts.demands);
  const providerQueries = buckets.map((bucket) =>
    opts.niche === "space" ? [bucket.query, "space astronomy cosmos"].join(" ") : bucket.query,
  );
  await Promise.all([
    prefetchStockProviderCache(session, "pexels", opts.orientation, providerQueries),
    prefetchStockProviderCache(session, "pixabay", opts.orientation, providerQueries),
    opts.niche === "space"
      ? prefetchStockProviderCache(
          session,
          "nasa",
          "any",
          buckets.flatMap((bucket) => expandNasaQueries(bucket.query).slice(0, 3)),
        )
      : Promise.resolve(),
  ]);

  const demandToBucket = new Map<string, StockQueryBucket>();
  for (const bucket of buckets) {
    for (const demandId of bucket.demandIds) demandToBucket.set(demandId, bucket);
  }

  const assignments = new Map<string, StockSearchResult>();
  const sourceUseCount = new Map<string, number>();
  const recentSources: string[] = [];
  // Ranking/assignment is pure CPU over already-fetched pools; timed separately
  // from provider HTTP so the breakdown shows which dominates.
  const profile = session.profile;
  const timeAssign = <T>(fn: () => T): T => (profile ? profile.timeSync("assignment", fn) : fn());

  if (opts.niche === "space") {
    const nasaPools = await loadNasaPools(opts, buckets);
    timeAssign(() =>
      assignFromPools({
        ...opts,
        buckets,
        demandToBucket,
        pools: nasaPools,
        assignments,
        sourceUseCount,
        recentSources,
        provider: "nasa",
      }),
    );
  }

  let missing = opts.demands.filter((demand) => !assignments.has(demand.id));
  if (missing.length > 0) {
    const pexelsBuckets = relevantBuckets(missing, demandToBucket);
    const pexelsPools = await loadProviderPools(
      opts,
      pexelsBuckets,
      "pexels",
      opts.niche === "space",
    );
    timeAssign(() =>
      assignFromPools({
        ...opts,
        buckets,
        demandToBucket,
        pools: pexelsPools,
        assignments,
        sourceUseCount,
        recentSources,
        provider: "pexels",
      }),
    );
  }

  missing = opts.demands.filter((demand) => !assignments.has(demand.id));
  if (missing.length > 0) {
    const pixabayBuckets = relevantBuckets(missing, demandToBucket);
    const pixabayPools = await loadProviderPools(
      opts,
      pixabayBuckets,
      "pixabay",
      opts.niche === "space",
    );
    timeAssign(() =>
      assignFromPools({
        ...opts,
        buckets,
        demandToBucket,
        pools: pixabayPools,
        assignments,
        sourceUseCount,
        recentSources,
        provider: "pixabay",
      }),
    );
  }

  console.info("[stock-corpus] assignment", {
    projectId: opts.projectId,
    demands: opts.demands.length,
    buckets: buckets.length,
    matched: assignments.size,
    unmatched: opts.demands.length - assignments.size,
    pexelsRequests: session.pexelsPool.requestCount,
    pexelsRequestLimit: session.pexelsPool.requestLimit,
    nasaHttp: session.nasaMetrics ?? null,
    nasaSearchCacheHits: session.usage.get("nasa")?.cacheHits ?? 0,
    providers: countProviders(assignments),
    sourceDuration: summarizeSelectedDurations(assignments),
  });
  return assignments;
}

async function loadNasaPools(
  opts: MatchCorpusOptions,
  buckets: StockQueryBucket[],
): Promise<Map<string, StockVideo[]>> {
  // Only reachable from the non-corpus path, which has already checked this.
  const session = opts.session!;
  const pools = new Map<string, StockVideo[]>();
  // NASA resolves metadata, manifests, and captions internally. Keeping bucket
  // searches serial bounds aggregate external concurrency to six.
  for (const bucket of buckets) {
    const candidates: StockVideo[] = [];
    for (const query of expandNasaQueries(bucket.query).slice(0, 3)) {
      const found = await searchProviderCandidatePool({
        provider: "nasa",
        query,
        orientation: opts.orientation,
        targetWidth: opts.targetWidth,
        seed: `${opts.projectId}:${bucket.id}:${query}`,
        session,
      }).catch((error) => {
        console.warn("[stock-corpus] NASA bucket search failed", {
          bucket: bucket.id,
          query,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      candidates.push(...found);
    }
    pools.set(bucket.id, dedupeVideos(candidates));
  }
  return pools;
}

async function loadProviderPools(
  opts: MatchCorpusOptions,
  buckets: StockQueryBucket[],
  provider: "pexels" | "pixabay",
  spaceBias: boolean,
): Promise<Map<string, StockVideo[]>> {
  // Only reachable from the non-corpus path, which has already checked this.
  const session = opts.session!;
  const pools = new Map<string, StockVideo[]>();
  await asyncPool(buckets, 6, async (bucket) => {
    const query = spaceBias ? `${bucket.query} space astronomy cosmos` : bucket.query;
    const candidates = await searchProviderCandidatePool({
      provider,
      query,
      orientation: opts.orientation,
      targetWidth: opts.targetWidth,
      seed: `${opts.projectId}:${bucket.id}`,
      session,
    });
    pools.set(bucket.id, candidates);
  });
  return pools;
}

function assignFromPools(
  opts: MatchCorpusOptions & {
    buckets: StockQueryBucket[];
    demandToBucket: Map<string, StockQueryBucket>;
    pools: Map<string, StockVideo[]>;
    assignments: Map<string, StockSearchResult>;
    sourceUseCount: Map<string, number>;
    recentSources: string[];
    provider: StockVideo["provider"];
  },
) {
  const pending = opts.demands
    .filter((demand) => !opts.assignments.has(demand.id))
    .map((demand) => {
      const ownBucket = opts.demandToBucket.get(demand.id);
      return {
        demand,
        candidates: candidateVideosForDemand(
          demand,
          opts.demandToBucket,
          opts.buckets,
          opts.pools,
        ).filter((video) => video.provider === opts.provider),
        primaryCandidateKeys: new Set(
          (ownBucket ? (opts.pools.get(ownBucket.id) ?? []) : [])
            .filter((video) => video.provider === opts.provider)
            .map((video) => `${video.provider}:${video.provider_clip_id}`),
        ),
      };
    });

  for (const { demand, candidates, primaryCandidateKeys } of pending) {
    const result = selectGlobalCandidate({
      demand,
      candidates,
      primaryCandidateKeys,
      targetWidth: opts.targetWidth,
      usedIds: opts.usedIds,
      sourceUseCount: opts.sourceUseCount,
      recentSources: opts.recentSources,
    });
    if (!result) continue;
    opts.usedIds.add(result.reservationKey);
    opts.assignments.set(demand.id, result);
    const sourceKey = `${result.pick.provider}:${result.pick.provider_clip_id}`;
    opts.sourceUseCount.set(sourceKey, (opts.sourceUseCount.get(sourceKey) ?? 0) + 1);
    opts.recentSources.push(sourceKey);
    if (opts.recentSources.length > RECENT_SOURCE_WINDOW) opts.recentSources.shift();
  }
}

function selectGlobalCandidate(opts: {
  demand: StockDemand;
  candidates: StockVideo[];
  primaryCandidateKeys: Set<string>;
  targetWidth: number;
  usedIds: Set<string>;
  sourceUseCount: Map<string, number>;
  recentSources: string[];
}): StockSearchResult | null {
  const options = opts.candidates.flatMap((video) => {
    const sourceKey = `${video.provider}:${video.provider_clip_id}`;
    if (
      video.provider === "nasa" &&
      (opts.sourceUseCount.get(sourceKey) ?? 0) >= MAX_NASA_WINDOWS_PER_ASSET
    ) {
      return [];
    }
    if (opts.recentSources.includes(sourceKey)) return [];
    if (video.files.length === 0) return [];
    if (video.provider === "nasa" && nasaRelevanceScore(opts.demand.query, video) < MIN_RELEVANCE) {
      return [];
    }
    const starts =
      video.provider === "nasa"
        ? buildNasaSourceWindows(
            video,
            opts.demand.minDurationSec,
            opts.demand.seed,
            MAX_NASA_WINDOWS_PER_ASSET,
          )
        : [0];
    return starts
      .map((inPoint) => ({
        video,
        inPoint,
        isPrimary: opts.primaryCandidateKeys.has(sourceKey),
        reservationKey: stockReservationKey(video.provider, video.provider_clip_id, inPoint),
      }))
      .filter(({ reservationKey }) => !opts.usedIds.has(reservationKey));
  });

  if (options.length === 0) return null;

  // Lower bound. This path had only the UPPER bound below, so nothing stopped a
  // source shorter than the scene from winning — it renders as a freeze frame
  // (tpad clones the last frame to fill the slot), silently. Same semantics as
  // selectStockCandidate: prefer sources that are long enough, fall back only
  // when none is, because a freeze frame still beats an unmatched scene.
  const longEnough = options.filter((option) =>
    meetsMinimumSourceDuration(option.video, opts.demand.minDurationSec),
  );
  const durationEligible = longEnough.length > 0 ? longEnough : options;

  // Round 6, Issue 1: prefer sources within the scene's duration budget so a
  // multi-minute clip is not downloaded for a few seconds of footage. Fall back
  // to the full option set only when nothing fits the budget. Applied INSIDE the
  // lower bound — the budget is an optimisation, the floor is correctness.
  const budgetedOptions = durationEligible.filter((option) =>
    withinSourceDurationBudget(option.video, opts.demand.minDurationSec),
  );
  const rankable = budgetedOptions.length > 0 ? budgetedOptions : durationEligible;
  rankable.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const aRelevance = candidateRelevance(opts.demand.query, a.video);
    const bRelevance = candidateRelevance(opts.demand.query, b.video);
    if (aRelevance !== bRelevance) return bRelevance - aRelevance;
    return (
      stableHash(
        `${opts.demand.seed}:${a.video.provider}:${a.video.provider_clip_id}:${a.inPoint}`,
      ) -
      stableHash(`${opts.demand.seed}:${b.video.provider}:${b.video.provider_clip_id}:${b.inPoint}`)
    );
  });

  const selected = rankable[0];

  // A silent freeze is worse than a logged one. If nothing was long enough, say
  // so here, at selection time, with the numbers needed to judge it. The worker
  // logs the same event again against the real downloaded file, which is the
  // authoritative measurement — this one catches the cases the provider's own
  // metadata already admits to.
  if (longEnough.length === 0) {
    console.warn("[stock-corpus] no source long enough — scene will freeze-frame", {
      demandId: opts.demand.id,
      query: opts.demand.query,
      requiredDurationSec: Number(opts.demand.minDurationSec.toFixed(3)),
      provider: selected.video.provider,
      providerClipId: selected.video.provider_clip_id,
      sourceDurationSec: Number(selected.video.duration_sec.toFixed(3)),
      shortfallSec: Number(
        Math.max(0, opts.demand.minDurationSec - selected.video.duration_sec).toFixed(3),
      ),
      candidatesConsidered: options.length,
    });
  }

  // Byte-aware: skips renditions whose provider-reported size already exceeds
  // the worker's MAX_CLIP_BYTES, which the duration budget above cannot catch.
  const chosenFile = selectRenditionForTarget(selected.video.files, opts.targetWidth)!;
  return {
    pick: selected.video,
    chosenFile,
    candidates: opts.candidates,
    inPoint: selected.inPoint,
    reservationKey: selected.reservationKey,
    fallbackUrls: fallbackRenditions(selected.video.files, chosenFile),
  };
}

// ─── Corpus-backed assignment with graded degradation (round 8) ──────────────

/**
 * Assigns every demand from the WHOLE project corpus.
 *
 * Three tiers, tried strictly in order, and only ever falling to the next when
 * the one above is exhausted:
 *
 *   1. unique          — a source not used anywhere in this project
 *   2. alternate-window— a different, non-overlapping in-point of a used source
 *   3. distant-reuse   — the same window again, as far from its other uses as
 *                        the timeline allows, and never adjacent
 *
 * Failing 145 scenes because 5 could not be unique is the wrong trade: a project
 * with three distant repeats beats a project that does not exist. Every descent
 * is reported through onFallback so degradation is visible, never silent.
 */
function assignFromProjectCorpus(
  opts: MatchCorpusOptions,
  corpus: Array<StockQueryBucket & { candidates: StockVideo[] }>,
): Map<string, StockSearchResult> {
  const assignments = new Map<string, StockSearchResult>();
  const sourceUsage: SourceUsage = opts.sourceUsage ?? new Map();
  const recentSources: string[] = [];

  const buckets: StockQueryBucket[] = corpus.map(({ id, query, tokens, demandIds }) => ({
    id,
    query,
    tokens,
    demandIds,
  }));
  const pools = new Map<string, StockVideo[]>(corpus.map((b) => [b.id, b.candidates]));

  const demandToBucket = new Map<string, StockQueryBucket>();
  for (const bucket of buckets) {
    for (const demandId of bucket.demandIds) demandToBucket.set(demandId, bucket);
  }
  // A demand the persisted clustering does not know about (a scene added after
  // the corpus was built) still needs a home: give it the closest bucket by
  // token overlap rather than dropping it.
  for (const demand of opts.demands) {
    if (demandToBucket.has(demand.id) || buckets.length === 0) continue;
    const tokens = stockQueryTokens(demand.query);
    const nearest = [...buckets].sort(
      (a, b) => jaccard(tokens, b.tokens) - jaccard(tokens, a.tokens) || a.id.localeCompare(b.id),
    )[0];
    demandToBucket.set(demand.id, nearest);
  }

  const tierCounts: Record<AssignmentTier, number> = {
    unique: 0,
    "alternate-window": 0,
    "distant-reuse": 0,
  };

  for (const demand of opts.demands) {
    const candidates = candidateVideosForDemand(demand, demandToBucket, buckets, pools);
    const ownBucket = demandToBucket.get(demand.id);
    const primaryCandidateKeys = new Set(
      (ownBucket ? (pools.get(ownBucket.id) ?? []) : []).map(
        (video) => `${video.provider}:${video.provider_clip_id}`,
      ),
    );

    const selected = selectWithDegradation({
      demand,
      candidates,
      primaryCandidateKeys,
      targetWidth: opts.targetWidth,
      usedIds: opts.usedIds,
      sourceUsage,
      recentSources,
    });
    if (!selected) continue;

    const { result, tier, reason, sceneDistance } = selected;
    opts.usedIds.add(result.reservationKey);
    assignments.set(demand.id, { ...result, tier });

    const sourceKey = `${result.pick.provider}:${result.pick.provider_clip_id}`;
    const usage = sourceUsage.get(sourceKey) ?? { windows: new Set<number>(), sceneIndexes: [] };
    usage.windows.add(windowIndexFor(result.inPoint, demand.minDurationSec));
    if (demand.sceneIndex != null) usage.sceneIndexes.push(demand.sceneIndex);
    sourceUsage.set(sourceKey, usage);

    recentSources.push(sourceKey);
    if (recentSources.length > RECENT_SOURCE_WINDOW) recentSources.shift();

    tierCounts[tier] += 1;
    if (tier !== "unique") {
      opts.onFallback?.({ demandId: demand.id, tier, reason, sourceKey, sceneDistance });
      console.warn("[stock-corpus] scene matched below the unique tier", {
        projectId: opts.projectId,
        sceneId: demand.id,
        sceneIndex: demand.sceneIndex ?? null,
        tier,
        reason,
        sourceKey,
        inPointSec: Number(result.inPoint.toFixed(3)),
        sceneDistance,
      });
    }
  }

  console.info("[stock-corpus] corpus assignment", {
    projectId: opts.projectId,
    demands: opts.demands.length,
    matched: assignments.size,
    unmatched: opts.demands.length - assignments.size,
    buckets: buckets.length,
    corpusCandidates: corpus.reduce((sum, b) => sum + b.candidates.length, 0),
    tiers: tierCounts,
    providers: countProviders(assignments),
    sourceDuration: summarizeSelectedDurations(assignments),
  });
  return assignments;
}

/** Which non-overlapping window of a source an in-point falls in. */
function windowIndexFor(inPoint: number, minDurationSec: number): number {
  const span = Math.max(1, minDurationSec);
  return Math.floor(inPoint / span);
}

type TieredSelection = {
  result: StockSearchResult;
  tier: AssignmentTier;
  reason: string;
  sceneDistance: number | null;
};

function selectWithDegradation(opts: {
  demand: StockDemand;
  candidates: StockVideo[];
  primaryCandidateKeys: Set<string>;
  targetWidth: number;
  usedIds: Set<string>;
  sourceUsage: SourceUsage;
  recentSources: string[];
}): TieredSelection | null {
  // Tier 1: an untouched source. The normal case, and the only one that needs no
  // explanation in the logs.
  const unique = selectGlobalCandidate({
    demand: opts.demand,
    candidates: opts.candidates.filter(
      (video) => !opts.sourceUsage.has(`${video.provider}:${video.provider_clip_id}`),
    ),
    primaryCandidateKeys: opts.primaryCandidateKeys,
    targetWidth: opts.targetWidth,
    usedIds: opts.usedIds,
    sourceUseCount: new Map(),
    recentSources: opts.recentSources,
  });
  if (unique)
    return { result: unique, tier: "unique", reason: "unused source", sceneDistance: null };

  // Tier 2: a different moment of a source already in the project. Visually a
  // different shot, so it costs far less than a repeat.
  const alternate = selectAlternateWindow(opts);
  if (alternate) return alternate;

  // Tier 3: an outright repeat, placed as far from its other uses as possible.
  return selectDistantReuse(opts);
}

/** Ranks candidates the way tier 1 does, so degraded picks are still relevant. */
function rankForDemand(demand: StockDemand, videos: StockVideo[]): StockVideo[] {
  return [...videos].sort(
    (a, b) =>
      candidateRelevance(demand.query, b) - candidateRelevance(demand.query, a) ||
      stableHash(`${demand.seed}:${a.provider}:${a.provider_clip_id}`) -
        stableHash(`${demand.seed}:${b.provider}:${b.provider_clip_id}`),
  );
}

function buildResult(
  video: StockVideo,
  inPoint: number,
  targetWidth: number,
  reservationKey: string,
  candidates: StockVideo[],
): StockSearchResult | null {
  const chosenFile = selectRenditionForTarget(video.files, targetWidth);
  if (!chosenFile) return null;
  return {
    pick: video,
    chosenFile,
    candidates,
    inPoint,
    reservationKey,
    fallbackUrls: fallbackRenditions(video.files, chosenFile),
  };
}

function selectAlternateWindow(opts: {
  demand: StockDemand;
  candidates: StockVideo[];
  targetWidth: number;
  usedIds: Set<string>;
  sourceUsage: SourceUsage;
}): TieredSelection | null {
  const span = Math.max(1, opts.demand.minDurationSec);
  for (const video of rankForDemand(opts.demand, opts.candidates)) {
    const sourceKey = `${video.provider}:${video.provider_clip_id}`;
    const usage = opts.sourceUsage.get(sourceKey);
    if (!usage) continue; // tier 1 already had its chance at unused sources
    // A window only exists if the source is genuinely long enough to hold one
    // that does not overlap what is already in use.
    if (video.duration_known === false) continue;
    const totalWindows = Math.floor(video.duration_sec / span);
    for (let window = 0; window < totalWindows; window++) {
      if (usage.windows.has(window)) continue;
      const inPoint = window * span;
      const reservationKey = `${sourceKey}:w${window}`;
      if (opts.usedIds.has(reservationKey)) continue;
      const distance = nearestSceneDistance(usage.sceneIndexes, opts.demand.sceneIndex);
      // A different moment of the same clip still looks like the same location;
      // keep it off adjacent scenes.
      if (distance != null && distance < NEVER_REUSE_WITHIN) continue;
      const result = buildResult(video, inPoint, opts.targetWidth, reservationKey, opts.candidates);
      if (!result) continue;
      return {
        result,
        tier: "alternate-window",
        reason: `no unused source remained; took window ${window} of ${totalWindows}`,
        sceneDistance: distance,
      };
    }
  }
  return null;
}

function selectDistantReuse(opts: {
  demand: StockDemand;
  candidates: StockVideo[];
  targetWidth: number;
  usedIds: Set<string>;
  sourceUsage: SourceUsage;
}): TieredSelection | null {
  type Option = { video: StockVideo; distance: number; relevance: number };
  const options: Option[] = [];

  for (const video of opts.candidates) {
    const sourceKey = `${video.provider}:${video.provider_clip_id}`;
    const usage = opts.sourceUsage.get(sourceKey);
    if (!usage) continue;
    const distance = nearestSceneDistance(usage.sceneIndexes, opts.demand.sceneIndex);
    // Unknown positions cannot be shown to be far apart, so they are not eligible
    // for a tier whose entire justification is distance.
    if (distance == null) continue;
    if (distance < NEVER_REUSE_WITHIN) continue;
    options.push({ video, distance, relevance: candidateRelevance(opts.demand.query, video) });
  }
  if (options.length === 0) return null;

  // Distance first — that is the whole point of the tier — then relevance, then
  // a seeded tie-break so the choice is deterministic.
  options.sort(
    (a, b) =>
      b.distance - a.distance ||
      b.relevance - a.relevance ||
      stableHash(`${opts.demand.seed}:${a.video.provider_clip_id}`) -
        stableHash(`${opts.demand.seed}:${b.video.provider_clip_id}`),
  );

  const best = options[0];
  const sourceKey = `${best.video.provider}:${best.video.provider_clip_id}`;
  const usage = opts.sourceUsage.get(sourceKey)!;
  const span = Math.max(1, opts.demand.minDurationSec);
  const window = [...usage.windows][0] ?? 0;
  const result = buildResult(
    best.video,
    window * span,
    opts.targetWidth,
    `${sourceKey}:reuse${opts.demand.sceneIndex ?? assignments_reuse_counter++}`,
    opts.candidates,
  );
  if (!result) return null;
  return {
    result,
    tier: "distant-reuse",
    reason:
      best.distance >= MIN_REUSE_SCENE_DISTANCE
        ? `no unique source or free window remained; reused a source ${best.distance} scenes away`
        : `no unique source or free window remained; closest available reuse was ${best.distance} scenes away (below the ${MIN_REUSE_SCENE_DISTANCE}-scene preference)`,
    sceneDistance: best.distance,
  };
}

/** Counter of last resort for demands with no timeline position. */
let assignments_reuse_counter = 0;

/** Distance from this scene to the nearest previous use, or null if unknowable. */
function nearestSceneDistance(sceneIndexes: number[], sceneIndex?: number): number | null {
  if (sceneIndex == null || sceneIndexes.length === 0) return null;
  return Math.min(...sceneIndexes.map((index) => Math.abs(index - sceneIndex)));
}

function candidateVideosForDemand(
  demand: StockDemand,
  demandToBucket: Map<string, StockQueryBucket>,
  buckets: StockQueryBucket[],
  pools: Map<string, StockVideo[]>,
): StockVideo[] {
  const own = demandToBucket.get(demand.id);
  if (!own) return [];
  const orderedBuckets = [own, ...adjacentBuckets(own, buckets)];
  return dedupeVideos(orderedBuckets.flatMap((bucket) => pools.get(bucket.id) ?? []));
}

function adjacentBuckets(
  bucket: StockQueryBucket,
  buckets: StockQueryBucket[],
): StockQueryBucket[] {
  return buckets
    .filter((candidate) => candidate.id !== bucket.id)
    .sort(
      (a, b) =>
        jaccard(bucket.tokens, b.tokens) - jaccard(bucket.tokens, a.tokens) ||
        a.id.localeCompare(b.id),
    );
}

function relevantBuckets(
  demands: StockDemand[],
  demandToBucket: Map<string, StockQueryBucket>,
): StockQueryBucket[] {
  const seen = new Set<string>();
  return demands.flatMap((demand) => {
    const bucket = demandToBucket.get(demand.id);
    if (!bucket || seen.has(bucket.id)) return [];
    seen.add(bucket.id);
    return [bucket];
  });
}

function candidateRelevance(query: string, video: StockVideo): number {
  if (video.provider === "nasa") return scoreNasaCandidate(query, video);
  const metadata = [video.title ?? "", ...(video.keywords ?? [])].join(" ");
  const queryTerms = stockQueryTokens(query);
  if (!metadata || queryTerms.length === 0) return 0;
  const metadataTerms = new Set(stockQueryTokens(metadata));
  return queryTerms.filter((term) => metadataTerms.has(term)).length / queryTerms.length;
}

function averageSimilarity(demand: StockDemand, members: StockDemand[]): number {
  const tokens = stockQueryTokens(demand.query);
  return (
    members.reduce((sum, member) => sum + jaccard(tokens, stockQueryTokens(member.query)), 0) /
    Math.max(1, members.length)
  );
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / union.size;
}

function dedupeVideos(videos: StockVideo[]): StockVideo[] {
  const seen = new Set<string>();
  return videos.filter((video) => {
    const key = `${video.provider}:${video.provider_clip_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Distribution of the source-clip durations actually selected, so a matcher that
// keeps choosing multi-minute sources for short scenes is visible in the logs
// rather than only discoverable from FFmpeg input dumps (round 6, Issue 2b).
function summarizeSelectedDurations(assignments: Map<string, StockSearchResult>) {
  const durations = [...assignments.values()]
    .map((result) => result.pick.duration_sec)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return { count: 0 };
  const median = durations[Math.floor(durations.length / 2)];
  const overBudget = durations.filter((value) => value > 120).length;
  return {
    count: durations.length,
    minSec: Math.round(durations[0]),
    medianSec: Math.round(median),
    maxSec: Math.round(durations[durations.length - 1]),
    overTwoMinutes: overBudget,
  };
}

function countProviders(assignments: Map<string, StockSearchResult>) {
  const counts: Record<string, number> = {};
  for (const result of assignments.values()) {
    counts[result.pick.provider] = (counts[result.pick.provider] ?? 0) + 1;
  }
  return counts;
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function asyncPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()),
  );
}
