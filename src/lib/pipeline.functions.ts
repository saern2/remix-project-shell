import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  createMatchingBudget,
  matchingSliceSize,
  matchingTimeBudgetMs,
} from "@/lib/matching-budget";
import { createMatchingProfile } from "@/lib/matching-profile";
import type { StockSearchSession } from "@/lib/stock.server";
import type { AssignmentTier } from "@/lib/stock-corpus.server";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });

// Round 6, Issue 6 / Issue B: bound the matching_footage stage so no single poll
// invocation runs long enough to saturate the serverless runtime, and prevent
// concurrent polls from starting duplicate work.
//
// Work per invocation is bounded by WALL-CLOCK TIME, not a scene count. A fixed
// 25-scene batch measured 38-44s in production and blocked unrelated requests
// (isAdmin peaked at 17,235ms while matching ran; auth calls that did not overlap
// a long match stayed at a 1.5s median). See matching-budget.ts.
//
// MATCHING_LOCK_TTL_MS — how long a claimed lock is honoured before it is treated
//   as stale (holder crashed). Must comfortably exceed one invocation's budget.
const MATCHING_LOCK_TTL_MS = 90_000;

/**
 * Atomically claim the per-project matching lock. Returns true if this poll now
 * owns the lock, false if a peer holds a fresh one (in which case the caller
 * should return status matching_footage and let the peer finish). The UPDATE is
 * a single atomic row operation, so exactly one of two racing polls wins.
 */
async function claimMatchingLock(projectId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const staleBefore = new Date(Date.now() - MATCHING_LOCK_TTL_MS).toISOString();
  // Cancellation is intentionally NOT filtered here: a cancelled project should
  // still claim the lock, enter the handler, and hit assertPipelineWritable, which
  // returns `cancelled` and releases the lock — rather than being reported as
  // matching_footage for a poll cycle.
  const { data, error } = await supabaseAdmin
    .from("projects")
    .update({ matching_lock_at: new Date().toISOString() })
    .eq("id", projectId)
    .or(`matching_lock_at.is.null,matching_lock_at.lt.${staleBefore}`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

async function releaseMatchingLock(projectId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("projects")
    .update({ matching_lock_at: null })
    .eq("id", projectId)
    .then(undefined, () => undefined);
}

class PipelineStoppedError extends Error {
  constructor() {
    super("Project processing stopped because the project was deleted.");
    this.name = "PipelineStoppedError";
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "23503";
}

function isPipelineStopped(error: unknown): boolean {
  return error instanceof PipelineStoppedError || isForeignKeyViolation(error);
}

function throwPipelineWriteError(error: unknown, fallback: string): void {
  if (isForeignKeyViolation(error)) throw new PipelineStoppedError();
  if (error && typeof error === "object" && "message" in error) {
    throw new Error(String(error.message));
  }
  if (error) throw new Error(fallback);
}

async function assertPipelineWritable(projectId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, pipeline_cancel_requested_at")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.pipeline_cancel_requested_at) throw new PipelineStoppedError();
}

async function markProjectFailed(projectId: string, message: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("projects")
    .update({ status: "failed", error_message: message })
    .eq("id", projectId)
    .is("pipeline_cancel_requested_at", null);
}

function providerBreakdown(rows: Array<{ provider?: string | null }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const provider = row.provider ?? "unknown";
    counts[provider] = (counts[provider] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * Kick off the pipeline for a project that has an uploaded audio asset.
 * - Fetches the project's audio asset (RLS scopes this to the caller)
 * - Requests a signed download URL for the audio (60 minutes)
 * - Submits transcription to the ASR provider (AssemblyAI)
 * - Stores the provider job id and flips status to "transcribing"
 */
export const startPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const projectId = data.projectId;

    const { data: project, error: projectErr } = await supabase
      .from("projects")
      .select("id, status, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectErr) throw new Error(projectErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");

    // Idempotent: allow re-triggering only from draft/failed/uploading.
    if (!["draft", "failed", "uploading", "uploaded"].includes(project.status)) {
      return { ok: true, status: project.status };
    }

    const { data: asset, error: assetErr } = await supabase
      .from("audio_assets")
      .select("id, storage_path")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (assetErr) throw new Error(assetErr.message);
    if (!asset) throw new Error("No audio uploaded for this project.");

    const { data: signed, error: signedErr } = await supabase.storage
      .from("audio")
      .createSignedUrl(asset.storage_path, 60 * 60);
    if (signedErr || !signed?.signedUrl) {
      throw new Error(signedErr?.message ?? "Could not create signed download URL.");
    }

    try {
      const { transcribeAudio } = await import("@/lib/asr.server");
      const result = await transcribeAudio(signed.signedUrl);

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      if (result.mode === "async") {
        // AssemblyAI-style: hand off to the poll loop.
        const { error: updErr } = await supabaseAdmin
          .from("projects")
          .update({
            status: "transcribing",
            provider_job_id: result.jobId,
            error_message: null,
          })
          .eq("id", projectId);
        if (updErr) throw new Error(updErr.message);
        return { ok: true, status: "transcribing" };
      }

      // Sync path (Deepgram): persist transcript + scenes now, jump ahead.
      await persistTranscriptAndScenes(projectId, {
        provider: result.provider,
        full_text: result.full_text,
        language: result.language,
        words: result.words,
        sentences: result.sentences,
        duration_sec: result.duration_sec,
      });

      await assertPipelineWritable(projectId);
      const { error: updErr } = await supabaseAdmin
        .from("projects")
        .update({
          status: "generating_scenes",
          provider_job_id: null,
          error_message: null,
        })
        .eq("id", projectId);
      if (updErr) throw new Error(updErr.message);
      return { ok: true, status: "generating_scenes" };
    } catch (err) {
      if (isPipelineStopped(err)) {
        console.info("[pipeline] project deleted while starting", { projectId });
        throw new Error("Project processing stopped because the project was deleted.");
      }
      const message = err instanceof Error ? err.message : "Failed to start pipeline.";
      await markProjectFailed(projectId, message);
      throw new Error(message);
    }
  });

/**
 * Persist a completed ASR result: update audio duration, insert transcript
 * row, insert scene rows. Shared by the sync Deepgram path in startPipeline
 * and the async AssemblyAI path in advanceFromTranscribing.
 */
async function persistTranscriptAndScenes(
  projectId: string,
  completed: {
    provider: string;
    full_text: string;
    language: string | null;
    words: Array<{ text: string; start_ms: number; end_ms: number; confidence?: number }>;
    sentences: Array<{ text: string; start_ms: number; end_ms: number }>;
    duration_sec: number | null;
  },
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await assertPipelineWritable(projectId);

  // Unconditionally clear any prior scenes for this project before
  // re-inserting. clip_candidates and selected_clips cascade off scenes,
  // so this also cleans up partial matching data from a failed attempt.
  // No-op on a fresh project.
  {
    const { error: delErr } = await supabaseAdmin
      .from("scenes")
      .delete()
      .eq("project_id", projectId);
    if (delErr) throw new Error(delErr.message);

    // The corpus is clustered against a specific set of scenes and stores their
    // ids. Regenerating scenes invalidates it entirely — keeping it would leave
    // buckets pointing at rows that no longer exist, so assignment would fall
    // back to nearest-bucket for every scene and quietly lose its clustering.
    const { clearProjectCorpus } = await import("@/lib/stock-corpus-store.server");
    await clearProjectCorpus(projectId);
    // The in-process matching cache holds the scene skeleton, the visual queries
    // and the corpus — all three describe the scenes that were just deleted.
    const { invalidateMatchingCache } = await import("@/lib/matching-cache.server");
    invalidateMatchingCache(projectId);
  }

  const { data: asset } = await supabaseAdmin
    .from("audio_assets")
    .select("id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  await assertPipelineWritable(projectId);

  if (asset?.id && typeof completed.duration_sec === "number") {
    await supabaseAdmin
      .from("audio_assets")
      .update({ duration_sec: completed.duration_sec })
      .eq("id", asset.id);
  }

  const { data: transcript, error: tErr } = await supabaseAdmin
    .from("transcripts")
    .insert({
      project_id: projectId,
      audio_asset_id: asset?.id ?? null,
      provider: completed.provider,
      full_text: completed.full_text,
      language: completed.language,
      word_timestamps: completed.words as unknown as never,
    })
    .select("id")
    .single();
  if (isForeignKeyViolation(tErr)) throw new PipelineStoppedError();
  if (tErr || !transcript) throw new Error(tErr?.message ?? "Failed to save transcript.");

  const sentences = completed.sentences.length
    ? completed.sentences
    : [
        {
          text: completed.full_text,
          start_ms: completed.words[0]?.start_ms ?? 0,
          end_ms: completed.words.at(-1)?.end_ms ?? 0,
        },
      ];

  const sceneRows = sentences.map((s, idx) => ({
    project_id: projectId,
    transcript_id: transcript.id,
    idx,
    text: s.text,
    start_ts: s.start_ms / 1000,
    end_ts: s.end_ms / 1000,
    status: "pending",
  }));
  if (sceneRows.length) {
    await assertPipelineWritable(projectId);
    const { error: sErr } = await supabaseAdmin.from("scenes").insert(sceneRows);
    throwPipelineWriteError(sErr, "Failed to save scenes.");
  }
}

/**
 * Drive the pipeline forward one step. Safe to call repeatedly:
 * - transcribing: poll ASR; on completion save transcript + scenes and advance
 * - generating_scenes: generate visual queries and advance to ready
 * - other states: return current state unchanged
 */
export const pollPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const projectId = data.projectId;

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, status, user_id, provider_job_id, error_message")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) {
      return {
        status: "not_found",
        error_message: "This project no longer exists.",
      };
    }
    if (project.user_id !== userId) throw new Error("Forbidden.");

    if (project.status === "transcribing") {
      return await advanceFromTranscribing(projectId, project.provider_job_id);
    }
    if (project.status === "generating_scenes") {
      return await advanceFromGeneratingScenes(projectId);
    }
    if (project.status === "matching_footage") {
      return await advanceFromMatchingFootage(projectId);
    }

    return {
      status: project.status,
      error_message: project.error_message,
    };
  });

async function advanceFromTranscribing(projectId: string, providerJobId: string | null) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (!providerJobId) {
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: "Missing transcription job id." })
      .eq("id", projectId);
    return { status: "failed", error_message: "Missing transcription job id." };
  }

  try {
    const { getAsrProvider } = await import("@/lib/asr.server");
    const provider = getAsrProvider();
    const result = await provider.poll(providerJobId);

    if (result.state !== "completed") {
      if (result.state === "failed") {
        await supabaseAdmin
          .from("projects")
          .update({ status: "failed", error_message: `Transcription failed: ${result.error}` })
          .eq("id", projectId);
        return { status: "failed", error_message: result.error };
      }
      return { status: "transcribing", error_message: null };
    }

    await persistTranscriptAndScenes(projectId, {
      provider: provider.name,
      full_text: result.full_text,
      language: result.language,
      words: result.words,
      sentences: result.sentences,
      duration_sec: result.duration_sec,
    });

    await assertPipelineWritable(projectId);
    await supabaseAdmin
      .from("projects")
      .update({ status: "generating_scenes", error_message: null })
      .eq("id", projectId);
    return { status: "generating_scenes", error_message: null };
  } catch (err) {
    if (isPipelineStopped(err)) {
      console.info("[pipeline] project deleted during transcription", { projectId });
      return { status: "cancelled", error_message: null };
    }
    const message = err instanceof Error ? err.message : "Transcription step failed.";
    await markProjectFailed(projectId, message);
    return { status: "failed", error_message: message };
  }
}

async function advanceFromGeneratingScenes(projectId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    await assertPipelineWritable(projectId);
    const { data: scenes, error } = await supabaseAdmin
      .from("scenes")
      .select("id, project_id, transcript_id, idx, text, start_ts, end_ts, created_at")
      .eq("project_id", projectId)
      .order("idx", { ascending: true });
    if (error) throw new Error(error.message);
    if (!scenes || scenes.length === 0) {
      await supabaseAdmin.from("projects").update({ status: "ready" }).eq("id", projectId);
      return { status: "ready", error_message: null };
    }

    const { data: projectRow } = await supabaseAdmin
      .from("projects")
      .select("category")
      .eq("id", projectId)
      .maybeSingle();
    const category = (projectRow?.category ?? null) as "war" | "crime" | "space" | null;

    const { generateVisualQueries } = await import("@/lib/visual-queries.server");
    const queries = await generateVisualQueries(
      scenes.map((s) => s.text),
      category,
    );

    await assertPipelineWritable(projectId);
    const sceneUpdates = scenes.map((scene, index) => ({
      ...scene,
      visual_query: queries[index],
      status: "query_ready",
    }));
    const { error: updateError } = await supabaseAdmin
      .from("scenes")
      .upsert(sceneUpdates, { onConflict: "id" });
    if (isForeignKeyViolation(updateError)) throw new PipelineStoppedError();
    if (updateError) throw new Error(updateError.message);

    await assertPipelineWritable(projectId);
    await supabaseAdmin
      .from("projects")
      .update({ status: "matching_footage", error_message: null })
      .eq("id", projectId);
    return { status: "matching_footage", error_message: null };
  } catch (err) {
    if (isPipelineStopped(err)) {
      console.info("[pipeline] project deleted during visual-query generation", { projectId });
      return { status: "cancelled", error_message: null };
    }
    const message = err instanceof Error ? err.message : "Visual query generation failed.";
    await markProjectFailed(projectId, message);
    return { status: "failed", error_message: message };
  }
}

/** A scene that had to be matched below the unique tier. */
type FallbackEvent = {
  demandId: string;
  tier: AssignmentTier;
  reason: string;
  sourceKey: string;
  sceneDistance: number | null;
};

/**
 * How many scenes may go unmatched before the project is failed.
 *
 * One unmatched scene used to fail a 145-scene project outright. With the
 * last-resort tier in place an unmatched scene means the corpus held nothing
 * renderable for it at all, which is rare enough that a handful is worth
 * shipping around rather than throwing 144 good scenes away.
 *
 * The floor of 2 is the hard promise: a single scene NEVER fails a project, at
 * any project size. MATCHING_MAX_UNMATCHED_FRACTION overrides the 10%.
 */
/**
 * Consecutive invocations that may match nothing before the stage gives up.
 *
 * The 524-scene deadlock needed no bug at all to recur — only a pending set that
 * cannot be satisfied and an unmatched count below the failure threshold. Three
 * idle rounds is enough to distinguish "the budget ran out before this slice
 * finished" from "this will never progress", without ending a slow but healthy
 * run.
 */
export function maxIdleMatchingRounds(): number {
  const configured = Number(process.env.MATCHING_MAX_IDLE_ROUNDS ?? 3);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

/**
 * What to do when matching has stopped making progress.
 *
 * Completing with a few unmatched scenes beats a project that polls forever:
 * the render tolerates gaps far better than a user tolerates a spinner that
 * never resolves. Past the same threshold that governs a normal failure, the
 * corpus is broken rather than merely thin, and failing says so.
 */
/**
 * Work an invocation completed, by phase.
 *
 * The watchdog is driven by this whole object rather than by one counter. The
 * first version counted only scenes assigned, which meant every corpus-building
 * invocation looked idle — assignment does not begin until the corpus is
 * complete, by design, so `scenesMatched` is legitimately 0 for the entire build
 * phase. A 145-scene project needing ~12 invocations to build its corpus was
 * killed after 3 while making perfectly steady progress.
 *
 * Any future phase that does real work while assigning no scenes must add its
 * counter here. Nothing else changes: idleness is "every counter is zero", so a
 * new phase is protected the moment it reports anything at all.
 */
export type MatchingProgress = {
  /** Scenes or slots assigned a clip this invocation. */
  scenesMatched: number;
  /** Corpus cells searched and persisted this invocation. */
  corpusCellsBuilt: number;
};

/**
 * Whether an invocation advanced nothing at all.
 *
 * Deliberately "every counter is zero" rather than a check against named fields
 * — that is what makes a new phase safe by default rather than one forgotten
 * edit away from being mistaken for a stall.
 */
export function isIdleInvocation(progress: Record<string, number>): boolean {
  const values = Object.values(progress);
  if (values.length === 0) return true;
  return values.every((value) => !Number.isFinite(value) || value <= 0);
}

/** Names the counters that advanced, so a log line can say what reset the count. */
export function describeProgress(progress: Record<string, number>): string[] {
  return Object.entries(progress)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([name, value]) => `${name}=${value}`);
}

/**
 * What to do when matching has genuinely stopped making progress.
 *
 * `dominantReason` comes from the per-scene reason breakdown, so the message
 * describes what actually happened. The first version always blamed the corpus
 * for failing to supply footage — which was wrong, and misleading, in the one
 * case it ever fired on.
 */
export function idleTerminalDecision(opts: {
  totalScenes: number;
  unmatchedScenes: number;
  dominantReason?: string | null;
}): {
  action: "complete" | "fail";
  reason: string;
} {
  const threshold = unmatchedSceneFailureThreshold(opts.totalScenes);
  const because = opts.dominantReason ? ` Most common reason: ${opts.dominantReason}.` : "";
  if (opts.unmatchedScenes < threshold) {
    return {
      action: "complete",
      reason: `matching stopped making progress with ${opts.unmatchedScenes} of ${opts.totalScenes} scene(s) unmatched, which is below the ${threshold}-scene failure threshold.${because}`,
    };
  }
  return {
    action: "fail",
    reason: `Matching stopped making progress with ${opts.unmatchedScenes} of ${opts.totalScenes} scene(s) still unmatched.${because} Retry matching; if it recurs, contact support with the project id.`,
  };
}

/**
 * The rows a slice writes, built from its assignments.
 *
 * Extracted and pure because this is the ONLY place batching can change
 * behaviour. The writes themselves are the same three tables they always were;
 * what batching newly introduces is a mapping — candidate ids come back from one
 * insert and have to be attached to the right scenes. Getting that wrong would
 * silently pair a scene with another scene's clip, which no integration test
 * would notice and no user would report as anything but "the video is wrong".
 *
 * Same inputs produce byte-identical rows to the per-scene version.
 */
export type SliceAssignment = {
  sceneId: string;
  /** end_ts - start_ts, or the timeline slot's duration when one exists. */
  visualDurationSec: number;
  provider: string;
  providerClipId: string;
  url: string;
  fallbackUrls: string[];
  thumbnailUrl: string | null;
  width: number;
  height: number;
  sourceDurationSec: number;
  inPoint: number;
};

export function buildCandidateRows(assignments: SliceAssignment[]) {
  return assignments.map((a) => ({
    scene_id: a.sceneId,
    provider: a.provider,
    provider_clip_id: a.providerClipId,
    url: a.url,
    fallback_urls: a.fallbackUrls,
    thumbnail_url: a.thumbnailUrl,
    width: a.width,
    height: a.height,
    duration_sec: a.sourceDurationSec,
  }));
}

export function buildSelectionRows(
  assignments: SliceAssignment[],
  candidateIdBySceneId: Map<string, string>,
) {
  return assignments.flatMap((a) => {
    const candidateId = candidateIdBySceneId.get(a.sceneId);
    if (!candidateId) return [];
    return [
      {
        scene_id: a.sceneId,
        clip_candidate_id: candidateId,
        in_point: a.inPoint,
        // Identical expression to the per-scene version it replaced.
        out_point: a.inPoint + Math.max(a.visualDurationSec, 1),
      },
    ];
  });
}

/**
 * Splits ids for a PostgREST `.in()` filter, which travels in the URL.
 *
 * At 37 characters per UUID, 600 ids is a 22 KB request line — past the common
 * 8 KB default and past Cloudflare's 16 KB. 100 keeps every request under 4 KB
 * with room to spare.
 */
export const IN_FILTER_CHUNK_SIZE = 100;

export function chunked<T>(items: T[], size: number = IN_FILTER_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function unmatchedSceneFailureThreshold(totalScenes: number): number {
  const configured = Number(process.env.MATCHING_MAX_UNMATCHED_FRACTION ?? 0.1);
  const fraction = Number.isFinite(configured) && configured > 0 ? configured : 0.1;
  return Math.max(2, Math.ceil(totalScenes * fraction));
}

/**
 * Reconstructs project-wide source usage from what is already persisted.
 *
 * The degradation tiers need to know, for the WHOLE project, which sources are
 * spoken for, which of their windows are taken, and where on the timeline they
 * sit. Slices only ever see their own scenes, so this is rebuilt from the
 * durable rows on every invocation.
 */
function buildSourceUsage(
  rows: Array<{
    provider: string;
    providerClipId: string | null;
    inPoint: number;
    sceneIndex: number | undefined;
    minDurationSec: number;
  }>,
): Map<string, { windows: Set<number>; sceneIndexes: number[] }> {
  const usage = new Map<string, { windows: Set<number>; sceneIndexes: number[] }>();
  for (const row of rows) {
    if (!row.providerClipId) continue;
    const key = `${row.provider}:${row.providerClipId}`;
    const entry = usage.get(key) ?? { windows: new Set<number>(), sceneIndexes: [] };
    const span = Math.max(1, row.minDurationSec);
    entry.windows.add(Math.floor(Math.max(0, row.inPoint) / span));
    if (row.sceneIndex != null) entry.sceneIndexes.push(row.sceneIndex);
    usage.set(key, entry);
  }
  return usage;
}

async function advanceFromMatchingFootage(projectId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let stockSession: StockSearchSession | null = null;

  // Budget covers the WHOLE invocation, including setup (session creation,
  // cache prefetch, project/scene/selection reads). The first deployed version
  // started the clock at the slice loop, leaving setup unbudgeted — a 12s budget
  // produced 15-19s invocations in production.
  const budgetMs = matchingTimeBudgetMs();
  const sliceSize = matchingSliceSize();
  const budget = createMatchingBudget({ budgetMs });
  const profile = createMatchingProfile();
  // Seed the buckets that matter so the poll payload always carries the same
  // shape, even for an invocation that did no work of that kind.
  for (const bucket of [
    "sceneRead",
    "selectionRead",
    "cacheRead",
    "providerSearch",
    "assignment",
    "dbWrite",
    "projectRead",
    "corpusLoad",
  ]) {
    profile.add(bucket, 0);
  }
  // Cache counters, seeded so a zero is reported as a zero rather than as an
  // absent field. These are how the round-8 setup cost is verified from the
  // client: on a warm process every assignment invocation should report all
  // three as 1, and sceneReadRows as 0.
  for (const counter of [
    "sceneCacheHit",
    "visualQueryCacheHit",
    "corpusCacheHit",
    "sceneReadRows",
    "fallbackAlternateWindow",
    "fallbackDistantReuse",
    "fallbackLastResort",
  ]) {
    profile.count(counter, 0);
  }

  const TIER_COUNTERS: Record<AssignmentTier, string | null> = {
    unique: null,
    "alternate-window": "fallbackAlternateWindow",
    "distant-reuse": "fallbackDistantReuse",
    "last-resort": "fallbackLastResort",
  };

  /**
   * Counts a degraded assignment and writes the decision to the log.
   *
   * Both matching paths funnel through here so a tier can never be counted as a
   * different one — the previous form was a ternary that silently folded
   * last-resort into distant-reuse, which would have hidden exactly the events
   * most worth seeing.
   */
  const recordFallback = (event: FallbackEvent) => {
    const counter = TIER_COUNTERS[event.tier];
    if (counter) profile.count(counter);
    console.info("[matching_footage] scene matched below the unique tier", {
      projectId,
      sceneId: event.demandId,
      tier: event.tier,
      reason: event.reason,
      sourceKey: event.sourceKey,
      sceneDistance: event.sceneDistance,
    });
  };

  /**
   * Per-invocation timing breakdown, returned to the CLIENT as well as logged.
   *
   * Round 6: the operator polls this endpoint from a browser and cannot reach
   * server logs, so the breakdown that identifies where an invocation's time
   * went has to travel in the response body to be observable at all. It is
   * diagnostic only — the client ignores it and reads `status`.
   *
   * Excludes the stock session flush, which runs in `finally` after the value is
   * built; `elapsedMs` is the time known at return.
   */
  const matchingTelemetry = (fields: { scenesProcessed: number; remaining: number }) => ({
    ...fields,
    budgetMs,
    sliceSize,
    elapsedMs: budget.elapsedMs(),
    ...budget.stats(),
    ...profile.summary(),
  });

  /**
   * Explains, per pending scene, why it was not matched this invocation.
   *
   * The 524-scene deadlock cost hours because the logs could not distinguish
   * "tried and failed" from "never tried". Those are opposite problems — one is
   * a supply issue, the other a work-list issue — and the log said the same
   * thing for both. This names which it was, for every scene still outstanding.
   *
   * Capped, because a stuck 524-scene project would otherwise write hundreds of
   * lines per poll; the reason COUNTS are always complete even when the id list
   * is truncated.
   */
  const explainPending = (opts: {
    label: string;
    pendingIds: string[];
    attemptedIds: Set<string>;
    unmatchedIds: Set<string>;
    hasVisualQuery: (sceneId: string) => boolean;
    inCorpus: (sceneId: string) => boolean;
  }) => {
    const reasons = new Map<string, string[]>();
    const add = (reason: string, sceneId: string) => {
      const list = reasons.get(reason) ?? [];
      list.push(sceneId);
      reasons.set(reason, list);
    };

    for (const sceneId of opts.pendingIds) {
      if (!opts.hasVisualQuery(sceneId)) {
        add("no visual_query — the scene was never given a search query", sceneId);
      } else if (!opts.inCorpus(sceneId)) {
        // The tail case: clustered before this scene existed, so it belongs to
        // no bucket and has no candidate pool to draw from.
        add("not in any corpus bucket — clustering predates this scene", sceneId);
      } else if (opts.unmatchedIds.has(sceneId)) {
        add("attempted, but no tier could supply a renderable clip", sceneId);
      } else if (!opts.attemptedIds.has(sceneId)) {
        add("NEVER ATTEMPTED — pending, in the corpus, but not reached this invocation", sceneId);
      } else {
        add("attempted and assigned, but the write did not settle", sceneId);
      }
    }

    if (reasons.size === 0) return;
    dominantPendingReason =
      [...reasons.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? null;
    console.info(`[${opts.label}] why pending scenes are still pending`, {
      projectId,
      pending: opts.pendingIds.length,
      breakdown: Object.fromEntries(
        [...reasons].map(([reason, ids]) => [
          reason,
          { count: ids.length, sample: ids.slice(0, 10) },
        ]),
      ),
    });
  };

  /**
   * Records whether this invocation matched anything, and stops the stage when
   * several in a row have not.
   *
   * Called on every path that would otherwise return matching_footage. Returns a
   * terminal result when the stage must end, or null to keep polling.
   *
   * This is the guarantee that was missing: every exit from matching_footage now
   * reaches ready or failed. A project can no longer poll forever because the
   * pending set and the completion check disagree — whatever the reason for the
   * disagreement.
   */
  /**
   * The reason most pending scenes gave last time explainPending ran. Feeds the
   * terminal message so it describes what actually happened rather than assuming.
   */
  let dominantPendingReason: string | null = null;

  const noteProgress = async (opts: {
    progress: MatchingProgress;
    unmatchedScenes: number;
    totalScenes: number;
    priorIdleRounds: number;
    label: string;
  }): Promise<{ status: string; error_message: string | null } | null> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const advanced = describeProgress(opts.progress);
    const limit = maxIdleMatchingRounds();

    if (!isIdleInvocation(opts.progress)) {
      // Always logged, whether or not the counter needed resetting, so a
      // misfiring watchdog is visible from one invocation rather than only from
      // a failed project.
      console.info(`[${opts.label}] invocation made progress`, {
        projectId,
        advanced,
        idleRoundsBefore: opts.priorIdleRounds,
        idleRoundsAfter: 0,
        idleLimit: limit,
      });
      if (opts.priorIdleRounds !== 0) {
        await supabaseAdmin
          .from("projects")
          .update({ matching_idle_rounds: 0 })
          .eq("id", projectId);
      }
      return null;
    }

    const idleRounds = opts.priorIdleRounds + 1;
    await supabaseAdmin
      .from("projects")
      .update({ matching_idle_rounds: idleRounds })
      .eq("id", projectId);

    console.warn(`[${opts.label}] invocation advanced nothing`, {
      projectId,
      progress: opts.progress,
      idleRoundsBefore: opts.priorIdleRounds,
      idleRoundsAfter: idleRounds,
      idleLimit: limit,
      unmatchedScenes: opts.unmatchedScenes,
      totalScenes: opts.totalScenes,
      dominantPendingReason,
    });
    if (idleRounds < limit) return null;

    const decision = idleTerminalDecision({
      totalScenes: opts.totalScenes,
      unmatchedScenes: opts.unmatchedScenes,
      dominantReason: dominantPendingReason,
    });
    console.error(`[${opts.label}] giving up after ${idleRounds} idle invocations`, {
      projectId,
      action: decision.action,
      reason: decision.reason,
      unmatchedScenes: opts.unmatchedScenes,
      totalScenes: opts.totalScenes,
    });

    if (decision.action === "complete") {
      await supabaseAdmin
        .from("projects")
        .update({ status: "ready", error_message: null, matching_idle_rounds: 0 })
        .eq("id", projectId);
      return { status: "ready", error_message: null };
    }
    await markProjectFailed(projectId, decision.reason);
    await supabaseAdmin.from("projects").update({ matching_idle_rounds: 0 }).eq("id", projectId);
    return { status: "failed", error_message: decision.reason };
  };

  // Single-flight guard: if a peer poll is already matching this project, do not
  // start duplicate work — return matching_footage so the client keeps polling.
  let lockHeld = false;
  try {
    lockHeld = await claimMatchingLock(projectId);
  } catch (err) {
    if (isPipelineStopped(err)) return { status: "cancelled", error_message: null };
    throw err;
  }
  if (!lockHeld) {
    // Returns BEFORE the progress watchdog, deliberately. This invocation did no
    // work because a peer is doing it — that is the single-flight guard working,
    // not a stall. Counting it would let a busy project with overlapping polls
    // accumulate idle rounds while another invocation is actively matching.
    console.info("[matching_footage] peer holds the lock; no work attempted", { projectId });

    // Doing no work is not the same as knowing nothing. A second viewer's polls
    // all land here, and this used to be the only thing they got back:
    // scenesProcessed 0, remaining -1 — every real number absent. The counts
    // are one cheap read away, from the same reader the progress panel uses,
    // so a viewer who is not driving the work still sees it moving.
    // remaining stays -1: it means "this invocation did not compute it", and
    // renderers must treat it as unknown, never as zero — `progress` is the
    // field that carries the real numbers.
    let progress = null;
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { readProjectMatchingCounts } = await import("@/lib/matching-counts.server");
      progress = await readProjectMatchingCounts(supabaseAdmin, { id: projectId });
    } catch (err) {
      // Progress reporting must never break the single-flight guard; a peer is
      // matching and this response's job is only to keep the client polling.
      console.warn("[matching_footage] progress read failed on lock-not-held path", {
        projectId,
        error: (err as Error).message,
      });
    }
    return {
      status: "matching_footage",
      error_message: null,
      matching: { ...matchingTelemetry({ scenesProcessed: 0, remaining: -1 }), lockHeld: 0, progress },
    };
  }

  try {
    const {
      cacheScenes,
      cacheCompleteCorpus,
      getCachedCorpus,
      getCachedScenes,
      getCachedVisualQueries,
      mergeVisualQueries,
    } = await import("@/lib/matching-cache.server");

    /**
     * The cancel flag is read as part of the project row rather than by a
     * separate assertPipelineWritable() call. They hit the same table on the
     * same primary key one after the other; on a VPS talking to hosted Supabase
     * that second round trip cost as much as the read it duplicated.
     */
    const projectStartedAt = Date.now();
    const { data: project, error: pErr } = await supabaseAdmin
      .from("projects")
      .select(
        "id, aspect_ratio, clip_duration_seconds, niche, pipeline_cancel_requested_at, matching_idle_rounds",
      )
      .eq("id", projectId)
      .maybeSingle();
    profile.add("projectRead", Date.now() - projectStartedAt);
    if (pErr) throw new Error(pErr.message);
    if (!project || project.pipeline_cancel_requested_at) throw new PipelineStoppedError();

    // Timeline skeleton: every scene, but only the columns the timeline maths
    // needs. This one read CANNOT be narrowed to pending scenes — a slot's
    // boundaries come from the *adjacent* scene's start_ts, so a gap in the list
    // would silently shift every downstream timing. It is made cheap instead:
    // `text` (the narration body, by far the largest column on the table) is no
    // longer selected, visual_query is read separately, and the result is held in
    // the process cache because scenes cannot change while matching runs.
    const readScenes = async () => {
      // The scene COUNT is always read from the database, even on a cache hit.
      //
      // This is the split that produced the 524-scene deadlock. The pending set
      // was computed from a cached scene list while completion was judged
      // against the real table, and the two disagreed: matching had begun while
      // scene generation was still writing rows, so the process cached a short
      // list and every later invocation reused it. The unmatched scenes were the
      // contiguous tail — exactly the rows written after the snapshot.
      //
      // One HEAD count is a few milliseconds and makes the disagreement
      // impossible: a cached list that does not match the table is discarded.
      const startedAt = Date.now();
      const { count: sceneCount, error: countError } = await supabaseAdmin
        .from("scenes")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId);
      if (countError) throw new Error(countError.message);
      profile.add("sceneRead", Date.now() - startedAt);
      profile.count("sceneCountFromDb", sceneCount ?? 0);

      const cached = getCachedScenes(projectId);
      if (cached && cached.length === (sceneCount ?? -1)) {
        profile.count("sceneCacheHit");
        return cached;
      }
      if (cached) {
        console.warn("[matching_footage] cached scene list disagreed with the database", {
          projectId,
          cachedScenes: cached.length,
          databaseScenes: sceneCount ?? null,
        });
        profile.count("sceneCacheStale");
      }

      const readStartedAt = Date.now();
      const { data, error } = await supabaseAdmin
        .from("scenes")
        .select("id, idx, start_ts, end_ts")
        .eq("project_id", projectId)
        .order("idx", { ascending: true });
      profile.add("sceneRead", Date.now() - readStartedAt);
      if (error) throw new Error(error.message);

      // A short read is a truncated page, not a smaller project. Caching it
      // would reintroduce exactly the defect above.
      if (data && data.length !== (sceneCount ?? data.length)) {
        throw new Error(
          `Scene list truncated: read ${data.length} of ${sceneCount} scenes. The project is too large for a single query page.`,
        );
      }
      if (data && data.length > 0) cacheScenes(projectId, data);
      return data ?? [];
    };

    const readAudioAsset = async () => {
      const { data, error: audioAssetError } = await supabaseAdmin
        .from("audio_assets")
        .select("duration_sec")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (audioAssetError) throw new Error(audioAssetError.message);
      return data;
    };

    const fixedDuration =
      project.clip_duration_seconds != null ? Number(project.clip_duration_seconds) : null;

    /**
     * Slices already assigned. Started here rather than inside the fixed-duration
     * branch so it overlaps the scene and audio reads: it is the one setup read
     * that GROWS as matching progresses (~1,300 rows by the end of a 145-scene
     * project), and paying for it in parallel costs nothing extra.
     */
    const existingSlicesPromise =
      fixedDuration != null && fixedDuration > 0
        ? supabaseAdmin
            .from("render_clip_slices")
            .select(
              "scene_id, slice_index, clip_url, provider, provider_clip_id, in_point_seconds, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
            )
            .eq("project_id", projectId)
        : null;

    // Independent reads, so they go out together. Sequentially these were three
    // more round trips of pure latency on top of the project read.
    const [scenes, audioAsset] = await Promise.all([readScenes(), readAudioAsset()]);

    if (scenes.length === 0) {
      await supabaseAdmin.from("projects").update({ status: "ready" }).eq("id", projectId);
      return { status: "ready", error_message: null };
    }

    /**
     * Visual queries for exactly the scenes this invocation still has work for.
     *
     * Served from the process cache when possible: the first invocation reads
     * every scene's query to cluster the corpus, and every later invocation used
     * to re-read the queries for all remaining scenes — 1,305 rows across a
     * 145-scene run for data that never changes.
     */
    const loadVisualQueries = async (sceneIds: string[]): Promise<Map<string, string>> => {
      const queries = new Map<string, string>();
      if (sceneIds.length === 0) return queries;

      const cached = getCachedVisualQueries(projectId);
      if (cached) {
        const missing = sceneIds.filter((id) => !cached.has(id));
        if (missing.length === 0) {
          profile.count("visualQueryCacheHit");
          for (const id of sceneIds) {
            const query = cached.get(id);
            if (query) queries.set(id, query);
          }
          return queries;
        }
      }

      const startedAt = Date.now();
      // Chunked: the id list travels in the URL. At 37 characters per UUID, 600
      // scenes is a 22 KB request line — past the common 8 KB default and past
      // Cloudflare's 16 KB. The process cache usually spares us this query
      // entirely, but a server restart mid-run removes that protection, which is
      // exactly when the list is longest.
      let rowsRead = 0;
      for (const ids of chunked(sceneIds)) {
        const { data, error: queryError } = await supabaseAdmin
          .from("scenes")
          .select("id, visual_query")
          .in("id", ids);
        if (queryError) throw new Error(queryError.message);
        rowsRead += data?.length ?? 0;
        for (const row of data ?? []) {
          if (row.visual_query) queries.set(row.id, row.visual_query);
        }
      }
      profile.add("sceneRead", Date.now() - startedAt);
      profile.count("sceneReadRows", rowsRead);
      mergeVisualQueries(projectId, queries);
      return queries;
    };
    const narrationEnd = Math.max(...scenes.map((scene) => Number(scene.end_ts ?? 0)));
    const measuredAudioDuration = Number(audioAsset?.duration_sec);
    const audioDuration =
      Number.isFinite(measuredAudioDuration) && measuredAudioDuration > 0
        ? Math.max(measuredAudioDuration, narrationEnd)
        : narrationEnd;

    const {
      createStockSearchSession,
      stockReservationKey,
      orientationForAspect,
      targetWidthForAspect,
    } = await import("@/lib/stock.server");
    const orientation = orientationForAspect(project.aspect_ratio);
    const targetWidth = targetWidthForAspect(project.aspect_ratio);
    const projectNiche = project.niche;

    // ── Project-wide corpus phase (round 8) ──────────────────────────────────
    // Round 6 sliced matching AND, accidentally, clustering: each slice built its
    // own buckets and searched its own queries, so 145 scenes produced ~145
    // cluster queries (244 cache misses against 33 hits) and assignment could
    // only see its own slice's pools. Project-wide uniqueness then drained those
    // small pools until late scenes had nothing left — a 145-scene project
    // failing because 5 scenes could not be unique.
    //
    // The corpus is now clustered once over every scene and built incrementally
    // under the same time budget. Assignment does not begin until it is complete,
    // so it never runs against a partial pool.
    const { ensureProjectBuckets, loadProjectCorpus, pendingCorpusWork, buildCorpusCell } =
      await import("@/lib/stock-corpus-store.server");

    const corpusProviders: Array<"pexels" | "pixabay" | "nasa"> =
      projectNiche === "space" ? ["nasa", "pexels", "pixabay"] : ["pexels", "pixabay"];

    /** Every scene's visual query — read only when the corpus must be clustered. */
    const loadAllDemands = async () => {
      const startedAt = Date.now();
      const { data, error: queryError } = await supabaseAdmin
        .from("scenes")
        .select("id, idx, visual_query")
        .eq("project_id", projectId)
        .order("idx", { ascending: true });
      profile.add("sceneRead", Date.now() - startedAt);
      if (queryError) throw new Error(queryError.message);
      // This read already has every scene's query in hand. Handing it to the
      // cache means the per-slice reads below never have to happen at all.
      mergeVisualQueries(
        projectId,
        new Map(
          (data ?? []).flatMap((row) => (row.visual_query ? [[row.id, row.visual_query]] : [])),
        ),
      );
      return (data ?? []).flatMap((row) =>
        row.visual_query
          ? [
              {
                id: row.id,
                query: row.visual_query,
                minDurationSec: 1,
                seed: `${projectId}:${row.id}`,
                sceneIndex: row.idx,
              },
            ]
          : [],
      );
    };

    /**
     * Builds the corpus until it is complete or the budget runs out.
     * Returns null while still building — the caller must return
     * matching_footage and let the next invocation continue.
     */
    const prepareCorpus = async () => {
      // A COMPLETE corpus is immutable — the build phase is over and assignment
      // only reads it — so serving it from memory is safe, and it is the single
      // largest read in the invocation: ~37 buckets of distilled candidates,
      // fetched whole on every one of the ~30 assignment invocations.
      const memo = getCachedCorpus(projectId);
      if (memo) {
        profile.count("corpusCacheHit");
        return { corpus: memo, complete: true as const, remaining: 0, cellsBuilt: 0 };
      }

      const corpusStartedAt = Date.now();
      let corpus = await loadProjectCorpus(projectId);
      if (corpus.length === 0) {
        corpus = await ensureProjectBuckets(projectId, await loadAllDemands());
      }
      profile.add("corpusLoad", Date.now() - corpusStartedAt);

      // Counted and returned so the progress watchdog can see that the corpus
      // phase advanced even though no scene was assigned.
      let cellsBuilt = 0;
      let pending = pendingCorpusWork(corpus, corpusProviders);
      profile.count("corpusCellsPending", pending.length);
      if (pending.length === 0) {
        cacheCompleteCorpus(projectId, corpus);
        return { corpus, complete: true as const, remaining: 0, cellsBuilt: 0 };
      }

      stockSession = stockSession ?? (await createStockSearchSession(profile));
      const byId = new Map(corpus.map((bucket) => [bucket.id, bucket]));

      while (pending.length > 0 && budget.shouldStartAnotherSlice()) {
        const cellStartedAt = Date.now();
        const { bucket, provider, queryIndex } = pending[0];
        const updated = await buildCorpusCell({
          projectId,
          bucket: byId.get(bucket.id) ?? bucket,
          provider,
          queryIndex,
          orientation,
          targetWidth,
          niche: projectNiche,
          session: stockSession ?? undefined,
        });
        byId.set(updated.id, updated);
        cellsBuilt += 1;
        profile.count("corpusCellsBuilt");
        budget.recordSlice(Date.now() - cellStartedAt);
        pending = pendingCorpusWork([...byId.values()], corpusProviders);
      }

      const rebuilt = [...byId.values()];
      if (pending.length > 0) {
        // Deliberately NOT cached: a partial corpus in memory would let the next
        // invocation decide what work remains from a stale copy.
        return { corpus: rebuilt, complete: false as const, remaining: pending.length, cellsBuilt };
      }
      cacheCompleteCorpus(projectId, rebuilt);
      return { corpus: rebuilt, complete: true as const, remaining: 0, cellsBuilt };
    };

    if (fixedDuration != null && fixedDuration > 0) {
      const {
        asyncPool,
        buildExpectedSliceSlots,
        describeMissingSlots,
        fixedSceneDuration,
        sliceKey,
        summarizeSliceCoverage,
      } = await import("@/lib/clip-slices.server");

      // Issued alongside the scene and audio reads above; this is where it lands.
      const { data: existingSlices, error: slicesError } = await existingSlicesPromise!;
      if (slicesError) throw new Error(slicesError.message);
      const eligibleExistingSlices = existingSlices ?? [];

      const startedAt = Date.now();
      const expectedSlots = buildExpectedSliceSlots(scenes, fixedDuration, audioDuration);
      const sliceCache = new Map<
        string,
        {
          clip_url: string;
          provider: "pexels" | "pixabay" | "nasa";
          provider_clip_id: string | null;
          in_point_seconds: number;
          duration_seconds: number;
          timeline_start_seconds: number;
          timeline_end_seconds: number;
          thumbnail_url: string | null;
        }
      >();
      const expectedSlotOrder = new Map(
        expectedSlots.map((slot, index) => [sliceKey(slot.sceneId, slot.sliceIndex), index]),
      );
      const cachedReservations = new Set<string>();
      for (const row of [...eligibleExistingSlices].sort(
        (a, b) =>
          (expectedSlotOrder.get(sliceKey(a.scene_id, a.slice_index)) ?? Number.MAX_SAFE_INTEGER) -
          (expectedSlotOrder.get(sliceKey(b.scene_id, b.slice_index)) ?? Number.MAX_SAFE_INTEGER),
      )) {
        const reservation = row.provider_clip_id
          ? stockReservationKey(
              row.provider as "pexels" | "pixabay" | "nasa",
              row.provider_clip_id,
              Number(row.in_point_seconds),
            )
          : null;
        if (reservation && cachedReservations.has(reservation)) continue;
        if (reservation) cachedReservations.add(reservation);
        sliceCache.set(sliceKey(row.scene_id, row.slice_index), {
          clip_url: row.clip_url,
          provider: row.provider as "pexels" | "pixabay" | "nasa",
          provider_clip_id: row.provider_clip_id ?? null,
          in_point_seconds: Number(row.in_point_seconds),
          duration_seconds: Number(row.duration_seconds),
          timeline_start_seconds: Number(row.timeline_start_seconds),
          timeline_end_seconds: Number(row.timeline_end_seconds),
          thumbnail_url: row.thumbnail_url ?? null,
        });
      }

      const alignedCachedRows = expectedSlots.flatMap((slot) => {
        const cached = sliceCache.get(sliceKey(slot.sceneId, slot.sliceIndex));
        if (!cached) return [];
        cached.duration_seconds = slot.durationSeconds;
        cached.timeline_start_seconds = slot.timelineStart;
        cached.timeline_end_seconds = slot.timelineEnd;
        return [
          {
            project_id: projectId,
            scene_id: slot.sceneId,
            slice_index: slot.sliceIndex,
            clip_url: cached.clip_url,
            provider: cached.provider,
            provider_clip_id: cached.provider_clip_id,
            in_point_seconds: cached.in_point_seconds,
            duration_seconds: slot.durationSeconds,
            timeline_start_seconds: slot.timelineStart,
            timeline_end_seconds: slot.timelineEnd,
            thumbnail_url: cached.thumbnail_url,
          },
        ];
      });
      if (alignedCachedRows.length > 0) {
        const { error: alignedError } = await supabaseAdmin
          .from("render_clip_slices")
          .upsert(alignedCachedRows, {
            onConflict: "project_id,scene_id,slice_index",
          });
        throwPipelineWriteError(alignedError, "Failed to align cached footage slices.");
      }

      const usedIds = new Set<string>(
        [...sliceCache.values()].flatMap((row) =>
          row.provider_clip_id
            ? [stockReservationKey(row.provider, row.provider_clip_id, row.in_point_seconds)]
            : [],
        ),
      );
      const pendingSlots = expectedSlots.filter(
        (slot) => !sliceCache.has(sliceKey(slot.sceneId, slot.sliceIndex)),
      );
      // Only the scenes with unfilled slots, and only now that they are known.
      const visualQueryByScene = await loadVisualQueries([
        ...new Set(pendingSlots.map((slot) => slot.sceneId)),
      ]);
      const newSliceRows: Array<{
        project_id: string;
        scene_id: string;
        slice_index: number;
        clip_url: string;
        provider_clip_id: string | null;
        provider: "pexels" | "pixabay" | "nasa";
        in_point_seconds: number;
        duration_seconds: number;
        timeline_start_seconds: number;
        timeline_end_seconds: number;
        thumbnail_url: string | null;
      }> = [];
      const unmatchedSlots: typeof pendingSlots = [];
      const FIXED_DURATION_CONCURRENCY = 4;

      // Time-budgeted slice loop. matchStockCorpus cannot be preempted mid-call,
      // so the budget is checked between small slices rather than mid-flight.
      const { matchStockCorpus } = await import("@/lib/stock-corpus.server");
      let processedSlots = 0;

      // No session is created here. Once the corpus is complete, assignment is
      // pure CPU over pools already in hand, and building a session means loading
      // the provider key pool and flushing usage counters afterwards — round
      // trips an assignment-only invocation has no use for. prepareCorpus builds
      // one lazily if, and only if, there is still searching to do.

      // The corpus must be whole before a single scene is assigned.
      const corpusState = await prepareCorpus();
      if (!corpusState.complete) {
        await assertPipelineWritable(projectId);
        const telemetry = matchingTelemetry({
          scenesProcessed: 0,
          remaining: pendingSlots.length,
        });
        console.info("[matching_footage:fixed-duration] building corpus", {
          projectId,
          corpusBuckets: corpusState.corpus.length,
          corpusCellsRemaining: corpusState.remaining,
          ...telemetry,
        });
        // Every matching_footage exit passes through the progress watchdog, so a
        // stage that stops advancing terminates instead of polling forever.
        const terminal = await noteProgress({
          progress: { scenesMatched: 0, corpusCellsBuilt: corpusState.cellsBuilt },
          unmatchedScenes: pendingSlots.length,
          totalScenes: expectedSlots.length,
          priorIdleRounds: project.matching_idle_rounds ?? 0,
          label: "matching_footage:fixed-duration:corpus",
        });
        if (terminal) return terminal;
        return { status: "matching_footage", error_message: null, matching: telemetry };
      }

      // Timeline position for every scene, so the last-resort reuse tier can
      // maximise distance and refuse anything adjacent.
      const sceneIndexById = new Map(scenes.map((scene, index) => [scene.id, index]));
      const sourceUsage = buildSourceUsage(
        eligibleExistingSlices.map((row) => ({
          provider: row.provider as string,
          providerClipId: row.provider_clip_id,
          inPoint: Number(row.in_point_seconds),
          sceneIndex: sceneIndexById.get(row.scene_id),
          minDurationSec: Number(row.duration_seconds),
        })),
      );
      const fallbackEvents: FallbackEvent[] = [];

      while (processedSlots < pendingSlots.length && budget.shouldStartAnotherSlice()) {
        const sliceStartedAt = Date.now();
        const slice = pendingSlots.slice(processedSlots, processedSlots + sliceSize);
        const fixedAssignments = await matchStockCorpus({
          projectId,
          demands: slice.flatMap((slot) => {
            const visualQuery = visualQueryByScene.get(slot.sceneId);
            if (!visualQuery) return [];
            return [
              {
                id: sliceKey(slot.sceneId, slot.sliceIndex),
                query: visualQuery,
                minDurationSec: slot.durationSeconds,
                seed: `${projectId}:${slot.sceneId}:${slot.sliceIndex}`,
                sceneIndex: sceneIndexById.get(slot.sceneId),
              },
            ];
          }),
          orientation,
          targetWidth,
          niche: project.niche,
          usedIds,
          session: stockSession ?? undefined,
          corpus: corpusState.corpus,
          sourceUsage,
          onFallback: (event) => fallbackEvents.push(event),
        });

        await asyncPool(slice, FIXED_DURATION_CONCURRENCY, async (slot) => {
          const result = fixedAssignments.get(sliceKey(slot.sceneId, slot.sliceIndex));
          if (!result) {
            unmatchedSlots.push(slot);
            return;
          }
          const providerClipId = result.pick.provider_clip_id;
          const row = {
            project_id: projectId,
            scene_id: slot.sceneId,
            slice_index: slot.sliceIndex,
            clip_url: result.chosenFile.url,
            // Smaller renditions of the same source; the worker walks these when
            // the primary is rejected as oversized (round 7).
            fallback_urls: result.fallbackUrls,
            provider_clip_id: providerClipId,
            provider: result.pick.provider,
            in_point_seconds: result.inPoint,
            duration_seconds: slot.durationSeconds,
            timeline_start_seconds: slot.timelineStart,
            timeline_end_seconds: slot.timelineEnd,
            thumbnail_url: result.pick.thumbnail_url ?? null,
          };
          newSliceRows.push(row);
          const writeStartedAt = Date.now();
          const { error: sliceError } = await supabaseAdmin
            .from("render_clip_slices")
            .upsert(row, { onConflict: "project_id,scene_id,slice_index" });
          profile.add("dbWrite", Date.now() - writeStartedAt);
          profile.count("dbWriteSlices");
          throwPipelineWriteError(sliceError, "Failed to save a footage slice.");
        });

        for (const event of fallbackEvents.splice(0)) recordFallback(event);
        processedSlots += slice.length;
        budget.recordSlice(Date.now() - sliceStartedAt);
      }

      if (unmatchedSlots.length > 0) {
        // Reaching here means the corpus held nothing RENDERABLE for these
        // slots — four tiers have already declined, the last of which drops
        // every preference. A few such slots are not worth throwing the rest of
        // the project away for; a lot of them mean the corpus is broken.
        const threshold = unmatchedSceneFailureThreshold(expectedSlots.length);
        console.warn("[matching_footage:fixed-duration] slots left unmatched", {
          projectId,
          unmatchedSlots: unmatchedSlots.length,
          totalSlots: expectedSlots.length,
          failureThreshold: threshold,
          detail: describeMissingSlots(unmatchedSlots),
        });
        if (unmatchedSlots.length >= threshold) {
          throw new Error(
            `No stock footage at all could be found for ${unmatchedSlots.length} of ${expectedSlots.length} slot(s): ${describeMissingSlots(unmatchedSlots)}. Try a different category or clip duration, then retry matching.`,
          );
        }
      }

      // More slots remain — stay in matching_footage so the next poll continues.
      if (processedSlots < pendingSlots.length) {
        await assertPipelineWritable(projectId);
        const telemetry = matchingTelemetry({
          scenesProcessed: processedSlots,
          remaining: pendingSlots.length - processedSlots,
        });
        console.info("[matching_footage:fixed-duration] budget spent, more pending", {
          projectId,
          ...telemetry,
        });
        // Every matching_footage exit passes through the progress watchdog, so a
        // stage that stops advancing terminates instead of polling forever.
        const terminal = await noteProgress({
          progress: { scenesMatched: processedSlots, corpusCellsBuilt: corpusState.cellsBuilt },
          unmatchedScenes: pendingSlots.length - processedSlots,
          totalScenes: expectedSlots.length,
          priorIdleRounds: project.matching_idle_rounds ?? 0,
          label: "matching_footage:fixed-duration",
        });
        if (terminal) return terminal;
        return { status: "matching_footage", error_message: null, matching: telemetry };
      }

      console.info("[matching_footage:fixed-duration] final invocation", {
        projectId,
        ...matchingTelemetry({ scenesProcessed: processedSlots, remaining: 0 }),
      });

      const { data: finalSlices } = await supabaseAdmin
        .from("render_clip_slices")
        .select(
          "scene_id, slice_index, clip_url, provider, provider_clip_id, in_point_seconds, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
        )
        .eq("project_id", projectId);
      const allRows = finalSlices ?? [];
      const coverage = summarizeSliceCoverage(scenes, fixedDuration, allRows, audioDuration);
      if (coverage.missingSlots.length > 0 || coverage.actualCount !== coverage.expectedCount) {
        throw new Error(
          `Fixed-duration footage matching incomplete: expected ${coverage.expectedCount} slices, prepared ${coverage.actualCount}. Missing ${describeMissingSlots(coverage.missingSlots)}.`,
        );
      }

      const { data: selectedRows } = await supabaseAdmin
        .from("selected_clips")
        .select("scene_id, scenes!inner(project_id)")
        .eq("scenes.project_id", projectId);
      const selectedSceneIds = new Set((selectedRows ?? []).map((row) => row.scene_id));

      // Round 6: this used to be a per-scene loop of two or three sequential
      // round trips — 145 scenes meant up to ~435 serialised statements on the
      // final invocation, the one invocation that must also stay under budget.
      // Same writes, batched: one insert, one upsert, one status update.
      const firstSlotByScene = new Map<string, (typeof allRows)[number]>();
      for (const row of allRows) {
        const current = firstSlotByScene.get(row.scene_id);
        if (!current || row.slice_index < current.slice_index) {
          firstSlotByScene.set(row.scene_id, row);
        }
      }

      const scenesNeedingSelection = scenes.filter(
        (scene) => !selectedSceneIds.has(scene.id) && firstSlotByScene.has(scene.id),
      );
      const newlySelectedSceneIds: string[] = [];
      if (scenesNeedingSelection.length > 0) {
        const height = Math.round(targetWidth * (orientation === "portrait" ? 16 / 9 : 9 / 16));
        const { data: insertedCandidates } = await supabaseAdmin
          .from("clip_candidates")
          .insert(
            scenesNeedingSelection.map((scene) => {
              const firstSlot = firstSlotByScene.get(scene.id)!;
              return {
                scene_id: scene.id,
                provider: firstSlot.provider,
                provider_clip_id: firstSlot.provider_clip_id ?? `slot-${scene.id}-0`,
                url: firstSlot.clip_url,
                thumbnail_url: firstSlot.thumbnail_url ?? null,
                width: targetWidth,
                height,
                duration_sec: Number(firstSlot.duration_seconds),
              };
            }),
          )
          .select("id, scene_id");

        const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
        const selectionRows = (insertedCandidates ?? []).flatMap((candidate) => {
          const scene = sceneById.get(candidate.scene_id);
          const firstSlot = firstSlotByScene.get(candidate.scene_id);
          if (!scene || !firstSlot) return [];
          const inPoint = Number(firstSlot.in_point_seconds);
          return [
            {
              scene_id: scene.id,
              clip_candidate_id: candidate.id,
              in_point: inPoint,
              out_point:
                inPoint +
                Math.min(
                  Number(firstSlot.duration_seconds),
                  Math.max(fixedSceneDuration(scene), 1),
                ),
            },
          ];
        });
        newlySelectedSceneIds.push(...selectionRows.map((row) => row.scene_id));
        if (selectionRows.length > 0) {
          const { error: selectionError } = await supabaseAdmin
            .from("selected_clips")
            .upsert(selectionRows, { onConflict: "scene_id" });
          throwPipelineWriteError(selectionError, "Failed to save selected clips.");
        }
      }

      const sceneIdsToMarkSelected = [
        ...new Set([
          ...scenes.filter((scene) => selectedSceneIds.has(scene.id)).map((scene) => scene.id),
          ...newlySelectedSceneIds,
        ]),
      ];
      // Same URL-length reason as loadVisualQueries above.
      for (const ids of chunked(sceneIdsToMarkSelected)) {
        const { error } = await supabaseAdmin
          .from("scenes")
          .update({ status: "selected" })
          .in("id", ids);
        if (error) throw new Error(error.message);
      }

      console.info("[matching_footage:fixed-duration]", {
        projectId,
        scenes: scenes.length,
        expectedSlices: coverage.expectedCount,
        cachedSlices: sliceCache.size,
        searchedSlices: newSliceRows.length,
        providers: providerBreakdown(allRows),
        distinctProviderClipIds: new Set(
          allRows.map((row) => `${row.provider}:${row.provider_clip_id ?? "unknown"}`),
        ).size,
        distinctSourceMoments: new Set(
          allRows.map(
            (row) =>
              `${row.provider}:${row.provider_clip_id ?? "unknown"}:${Number(row.in_point_seconds)}`,
          ),
        ).size,
        concurrency: FIXED_DURATION_CONCURRENCY,
        elapsedMs: Date.now() - startedAt,
        budgetMs,
        ...budget.stats(),
        ...profile.summary(),
      });

      await assertPipelineWritable(projectId);
      await supabaseAdmin
        .from("projects")
        .update({ status: "ready", error_message: null })
        .eq("id", projectId);
      return {
        status: "ready",
        error_message: null,
        matching: matchingTelemetry({ scenesProcessed: processedSlots, remaining: 0 }),
      };
    }
    // Plain path (no fixed duration).
    // Existing selections (idempotent re-runs). Skip scenes already selected.
    // Project-scoped via the scenes join rather than an IN list of every scene
    // id — the id list was the request payload, and it grew with the project.
    // This read stays project-wide on purpose: it is what seeds `usedIds`, and
    // clip uniqueness is a whole-project invariant, not a per-slice one.
    const selectionReadStartedAt = Date.now();
    const { data: existingSel } = await supabaseAdmin
      .from("selected_clips")
      .select(
        "scene_id, in_point, clip_candidates!inner(provider, provider_clip_id), scenes!inner(project_id)",
      )
      .eq("scenes.project_id", projectId);
    profile.add("selectionRead", Date.now() - selectionReadStartedAt);
    const eligibleExistingSelections = existingSel ?? [];
    const sceneOrder = new Map(scenes.map((scene, index) => [scene.id, index]));
    const alreadySelected = new Set<string>();
    const usedIds = new Set<string>();
    for (const row of [...eligibleExistingSelections].sort(
      (a, b) =>
        (sceneOrder.get(a.scene_id) ?? Number.MAX_SAFE_INTEGER) -
        (sceneOrder.get(b.scene_id) ?? Number.MAX_SAFE_INTEGER),
    )) {
      const selection = row as {
        in_point: number;
        clip_candidates: {
          provider: "pexels" | "pixabay" | "nasa";
          provider_clip_id: string;
        } | null;
      };
      const providerClipId = (
        row as {
          clip_candidates: { provider: string; provider_clip_id: string } | null;
        }
      ).clip_candidates?.provider_clip_id;
      if (!providerClipId || !selection.clip_candidates) continue;
      const reservation = stockReservationKey(
        selection.clip_candidates.provider,
        providerClipId,
        Number(selection.in_point),
      );
      // The scene is SELECTED either way — it has a row in selected_clips, which
      // is what "already matched" means. Only the reservation is skipped when a
      // duplicate, so uniqueness accounting stays right.
      //
      // Previously the `continue` skipped alreadySelected too, so a scene whose
      // clip collided with an earlier one was pending forever: re-matched every
      // invocation, re-writing the same colliding selection, never progressing.
      // That is the second way this stage could spin without advancing.
      alreadySelected.add(row.scene_id);
      if (usedIds.has(reservation)) continue;
      usedIds.add(reservation);
    }

    const { buildSceneTimelineSlots } = await import("@/lib/clip-slices.server");
    const timelineSlots = new Map(
      buildSceneTimelineSlots(scenes, audioDuration).map((slot) => [slot.sceneId, slot]),
    );
    const CONCURRENCY = 5;
    const pending = scenes.filter((s) => !alreadySelected.has(s.id));
    // Only the scenes still to match — filtered in the query, so this shrinks
    // with every invocation rather than re-reading the whole project's queries.
    const visualQueryByScene = await loadVisualQueries(pending.map((scene) => scene.id));
    const unmatchedSceneIds = new Set<string>();
    const { matchStockCorpus } = await import("@/lib/stock-corpus.server");

    /**
     * Persists a whole slice in three statements instead of three per scene.
     *
     * WHY. Measured on a 286-scene production run: dbWriteMs 40,970-55,408 per
     * invocation against elapsedMs ~11,000, with providerSearchMs 0 and
     * assignmentMs 0. Assignment was not searching or computing — it was
     * waiting on writes, ~3s per scene, three sequential round trips each at
     * concurrency 5. Batching turns 45 round trips per slice into 3.
     *
     * WHAT DOES NOT CHANGE. Which clip each scene gets, and every value written
     * for it. The assignments come from matchStockCorpus exactly as before and
     * are only regrouped for transport — same rows, same order, fewer requests.
     * The write ORDER is also preserved (candidate, then selection, then
     * status), so a failure part-way leaves the same state it always did.
     */
    async function persistSlice(
      sliceScenes: NonNullable<typeof scenes>,
      plainAssignments: Awaited<ReturnType<typeof matchStockCorpus>>,
    ) {
      const writeStartedAt = Date.now();

      const matched: Array<{
        scene: (typeof sliceScenes)[number];
        result: NonNullable<ReturnType<typeof plainAssignments.get>>;
      }> = [];
      const failedSceneIds: string[] = [];

      for (const scene of sliceScenes) {
        const result = plainAssignments.get(scene.id);
        if (!result) {
          failedSceneIds.push(scene.id);
          unmatchedSceneIds.add(scene.id);
          continue;
        }
        matched.push({ scene, result });
      }

      if (failedSceneIds.length > 0) {
        for (const ids of chunked(failedSceneIds)) {
          const { error } = await supabaseAdmin
            .from("scenes")
            .update({ status: "failed" })
            .in("id", ids);
          if (error) throw new Error(error.message);
        }
      }

      if (matched.length > 0) {
        // 1 of 3: every candidate for the slice. scene_id comes back so the
        // generated ids can be matched to their scenes — one scene per row
        // within a slice, so the mapping is unambiguous.
        const sliceAssignments: SliceAssignment[] = matched.map(({ scene, result }) => ({
          sceneId: scene.id,
          visualDurationSec:
            timelineSlots.get(scene.id)?.durationSeconds ??
            Math.max(0, Number(scene.end_ts) - Number(scene.start_ts)),
          provider: result.pick.provider,
          providerClipId: result.pick.provider_clip_id,
          url: result.chosenFile.url,
          fallbackUrls: result.fallbackUrls,
          thumbnailUrl: result.pick.thumbnail_url,
          width: result.chosenFile.width,
          height: result.chosenFile.height,
          sourceDurationSec: result.pick.duration_sec,
          inPoint: result.inPoint,
        }));

        const { data: candidates, error: cErr } = await supabaseAdmin
          .from("clip_candidates")
          .insert(buildCandidateRows(sliceAssignments))
          .select("id, scene_id");
        if (cErr || !candidates) throw new Error(cErr?.message ?? "Failed to save candidates.");

        const candidateBySceneId = new Map(candidates.map((row) => [row.scene_id, row.id]));

        // 2 of 3: the selections, which are what the render actually reads.
        const selectionRows = buildSelectionRows(sliceAssignments, candidateBySceneId);
        // A candidate that came back without its scene would silently drop a
        // selection, which is the shape of bug this batching could introduce.
        if (selectionRows.length !== matched.length) {
          throw new Error(
            `Candidate insert returned ${candidates.length} rows for ${matched.length} scenes; refusing to write a partial slice.`,
          );
        }

        const { error: sErr } = await supabaseAdmin
          .from("selected_clips")
          .upsert(selectionRows, { onConflict: "scene_id" });
        if (sErr) throw new Error(sErr.message);

        // 3 of 3: mark them selected.
        for (const ids of chunked(matched.map(({ scene }) => scene.id))) {
          const { error } = await supabaseAdmin
            .from("scenes")
            .update({ status: "selected" })
            .in("id", ids);
          if (error) throw new Error(error.message);
        }
      }

      profile.add("dbWrite", Date.now() - writeStartedAt);
      profile.count("dbWriteScenes", sliceScenes.length);
      profile.count(
        "dbWriteStatements",
        (failedSceneIds.length > 0 ? 1 : 0) + (matched.length > 0 ? 3 : 0),
      );
    }

    const { asyncPool } = await import("@/lib/clip-slices.server");
    const startedAt = Date.now();

    // Time-budgeted slice loop (see fixed-duration path above for rationale).
    let processedScenes = 0;

    // Session created lazily by prepareCorpus — see the fixed-duration path.
    const corpusState = await prepareCorpus();
    if (!corpusState.complete) {
      await assertPipelineWritable(projectId);
      const telemetry = matchingTelemetry({ scenesProcessed: 0, remaining: pending.length });
      console.info("[matching_footage:plain] building corpus", {
        projectId,
        corpusBuckets: corpusState.corpus.length,
        corpusCellsRemaining: corpusState.remaining,
        ...telemetry,
      });
      // Every matching_footage exit passes through the progress watchdog, so a
      // stage that stops advancing terminates instead of polling forever.
      const terminal = await noteProgress({
        progress: { scenesMatched: 0, corpusCellsBuilt: corpusState.cellsBuilt },
        unmatchedScenes: pending.length,
        totalScenes: scenes.length,
        priorIdleRounds: project.matching_idle_rounds ?? 0,
        label: "matching_footage:plain:corpus",
      });
      if (terminal) return terminal;
      return { status: "matching_footage", error_message: null, matching: telemetry };
    }

    const sceneIndexById = new Map(scenes.map((scene, index) => [scene.id, index]));
    const sourceUsage = buildSourceUsage(
      eligibleExistingSelections.flatMap((row) => {
        const candidate = (
          row as { clip_candidates: { provider: string; provider_clip_id: string } | null }
        ).clip_candidates;
        if (!candidate) return [];
        return [
          {
            provider: candidate.provider,
            providerClipId: candidate.provider_clip_id,
            inPoint: Number((row as { in_point: number }).in_point),
            sceneIndex: sceneIndexById.get(row.scene_id),
            minDurationSec: 1,
          },
        ];
      }),
    );
    const fallbackEvents: FallbackEvent[] = [];

    while (processedScenes < pending.length && budget.shouldStartAnotherSlice()) {
      const sliceStartedAt = Date.now();
      const slice = pending.slice(processedScenes, processedScenes + sliceSize);
      const plainAssignments = await matchStockCorpus({
        projectId,
        demands: slice.flatMap((scene) => {
          const visualQuery = visualQueryByScene.get(scene.id);
          if (!visualQuery) return [];
          const visualDuration =
            timelineSlots.get(scene.id)?.durationSeconds ??
            Math.max(0, Number(scene.end_ts) - Number(scene.start_ts));
          return [
            {
              id: scene.id,
              query: visualQuery,
              minDurationSec: Math.max(1, Math.ceil(visualDuration)),
              seed: `${projectId}:${scene.id}`,
              sceneIndex: sceneIndexById.get(scene.id),
            },
          ];
        }),
        orientation,
        targetWidth,
        niche: projectNiche,
        usedIds,
        session: stockSession ?? undefined,
        corpus: corpusState.corpus,
        sourceUsage,
        onFallback: (event) => fallbackEvents.push(event),
      });

      await persistSlice(slice, plainAssignments);
      for (const event of fallbackEvents.splice(0)) recordFallback(event);
      processedScenes += slice.length;
      budget.recordSlice(Date.now() - sliceStartedAt);
    }

    {
      const corpusDemandIds = new Set(corpusState.corpus.flatMap((bucket) => bucket.demandIds));
      explainPending({
        label: "matching_footage:plain",
        pendingIds: pending.slice(processedScenes).map((scene) => scene.id),
        attemptedIds: new Set(pending.slice(0, processedScenes).map((scene) => scene.id)),
        unmatchedIds: unmatchedSceneIds,
        hasVisualQuery: (id) => visualQueryByScene.has(id),
        inCorpus: (id) => corpusDemandIds.has(id),
      });
    }

    if (unmatchedSceneIds.size > 0) {
      // Not a uniqueness failure: a scene only lands here when the corpus holds
      // nothing RENDERABLE for it under any of the four tiers — the last of
      // which takes any clip with a usable rendition. One such scene must never
      // cost the project; enough of them means the corpus itself is broken.
      const threshold = unmatchedSceneFailureThreshold(scenes.length);
      console.warn("[matching_footage:plain] scenes left unmatched", {
        projectId,
        unmatchedScenes: unmatchedSceneIds.size,
        totalScenes: scenes.length,
        failureThreshold: threshold,
        sceneIds: [...unmatchedSceneIds].slice(0, 20),
      });
      if (unmatchedSceneIds.size >= threshold) {
        throw new Error(
          projectNiche === "space"
            ? `NASA, Pexels, and Pixabay returned no usable footage for ${unmatchedSceneIds.size} of ${scenes.length} scene(s). Retry matching; if this continues, ask the operator to verify provider availability.`
            : `Pexels and Pixabay returned no usable footage for ${unmatchedSceneIds.size} of ${scenes.length} scene(s). Retry matching; if this continues, ask the operator to verify provider availability.`,
        );
      }
    }

    // More scenes remain — stay in matching_footage so the next poll continues.
    if (processedScenes < pending.length) {
      await assertPipelineWritable(projectId);
      const telemetry = matchingTelemetry({
        scenesProcessed: processedScenes,
        remaining: pending.length - processedScenes,
      });
      console.info("[matching_footage:plain] budget spent, more pending", {
        projectId,
        ...telemetry,
      });
      // Every matching_footage exit passes through the progress watchdog, so a
      // stage that stops advancing terminates instead of polling forever.
      const terminal = await noteProgress({
        progress: { scenesMatched: processedScenes, corpusCellsBuilt: corpusState.cellsBuilt },
        unmatchedScenes: pending.length - processedScenes,
        totalScenes: scenes.length,
        priorIdleRounds: project.matching_idle_rounds ?? 0,
        label: "matching_footage:plain",
      });
      if (terminal) return terminal;
      return { status: "matching_footage", error_message: null, matching: telemetry };
    }

    const { data: completedSelections } = await supabaseAdmin
      .from("selected_clips")
      .select(
        "in_point, clip_candidates!inner(provider, provider_clip_id), scenes!inner(project_id)",
      )
      .eq("scenes.project_id", projectId);
    const selectionEvidence = (completedSelections ?? []).map((row) => {
      const candidate = (
        row as unknown as {
          in_point: number;
          clip_candidates: { provider: string; provider_clip_id: string };
        }
      ).clip_candidates;
      return { ...candidate, in_point: Number(row.in_point) };
    });
    console.info("[matching_footage:plain]", {
      projectId,
      scenes: scenes.length,
      cachedSelections: alreadySelected.size,
      searchedScenes: pending.length,
      providers: providerBreakdown(selectionEvidence),
      distinctProviderClipIds: new Set(
        selectionEvidence.map((row) => `${row.provider}:${row.provider_clip_id}`),
      ).size,
      distinctSourceMoments: new Set(
        selectionEvidence.map((row) => `${row.provider}:${row.provider_clip_id}:${row.in_point}`),
      ).size,
      concurrency: CONCURRENCY,
      elapsedMs: Date.now() - startedAt,
      budgetMs,
      ...budget.stats(),
      ...profile.summary(),
    });

    await assertPipelineWritable(projectId);
    await supabaseAdmin
      .from("projects")
      .update({ status: "ready", error_message: null })
      .eq("id", projectId);
    return {
      status: "ready",
      error_message: null,
      matching: matchingTelemetry({ scenesProcessed: processedScenes, remaining: 0 }),
    };
  } catch (err) {
    if (isPipelineStopped(err)) {
      console.info("[pipeline] project deleted during footage matching", { projectId });
      return { status: "cancelled", error_message: null };
    }
    const message = err instanceof Error ? err.message : "Stock footage matching failed.";
    await markProjectFailed(projectId, message);
    return { status: "failed", error_message: message };
  } finally {
    if (stockSession) {
      const { flushStockSearchSession } = await import("@/lib/stock.server");
      await flushStockSearchSession(stockSession).catch((error) => {
        console.warn("[stock] stage cache flush failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (lockHeld) await releaseMatchingLock(projectId);
  }
}

// Swap the selected clip for a single scene: search again, excluding all
// clip candidates already tried for this scene so the result is different.
const SwapInput = z.object({ sceneId: z.string().uuid() });

export const swapSceneClip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SwapInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Load scene + project (RLS scoped)
    const { data: scene, error: sErr } = await supabase
      .from("scenes")
      .select(
        "id, project_id, text, start_ts, end_ts, visual_query, projects!inner(user_id, aspect_ratio, niche)",
      )
      .eq("id", data.sceneId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!scene) throw new Error("Scene not found.");
    const project = (
      scene as unknown as { projects: { user_id: string; aspect_ratio: string; niche: string } }
    ).projects;
    if (project.user_id !== userId) throw new Error("Forbidden.");
    if (!scene.visual_query) throw new Error("Scene has no visual query.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Exclude every candidate already tried for this scene
    const { data: prior } = await supabaseAdmin
      .from("clip_candidates")
      .select("provider_clip_id")
      .eq("scene_id", scene.id);
    const usedIds = (prior ?? []).map((r) => r.provider_clip_id);

    const { searchStockFootage, orientationForAspect, targetWidthForAspect } =
      await import("@/lib/stock.server");
    const minDuration = Math.max(1, Math.ceil(Number(scene.end_ts) - Number(scene.start_ts)));
    const result = await searchStockFootage({
      query: scene.visual_query,
      orientation: orientationForAspect(project.aspect_ratio),
      minDurationSec: minDuration,
      targetWidth: targetWidthForAspect(project.aspect_ratio),
      usedIds,
      seed: `${scene.project_id}:${scene.id}:swap:${usedIds.length}`,
      niche: project.niche,
    });
    if (!result) throw new Error("No alternate clips available for this scene.");
    const { pick, chosenFile } = result;

    const { data: candidate, error: cErr } = await supabaseAdmin
      .from("clip_candidates")
      .insert({
        scene_id: scene.id,
        provider: pick.provider,
        provider_clip_id: pick.provider_clip_id,
        url: chosenFile.url,
        thumbnail_url: pick.thumbnail_url,
        width: chosenFile.width,
        height: chosenFile.height,
        duration_sec: pick.duration_sec,
      })
      .select("id")
      .single();
    if (cErr || !candidate) throw new Error(cErr?.message ?? "Failed to save candidate.");

    const sceneDuration = Number(scene.end_ts) - Number(scene.start_ts);
    const { error: upErr } = await supabaseAdmin.from("selected_clips").upsert(
      {
        scene_id: scene.id,
        clip_candidate_id: candidate.id,
        in_point: result.inPoint,
        out_point: result.inPoint + Math.min(pick.duration_sec, Math.max(sceneDuration, 1)),
      },
      { onConflict: "scene_id" },
    );
    if (upErr) throw new Error(upErr.message);

    return { ok: true };
  });
