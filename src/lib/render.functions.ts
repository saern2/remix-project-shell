import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertMaintenanceAllows } from "@/lib/maintenance.server";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });
const JobIdInput = z.object({ jobId: z.string().uuid() });

const WORKER_JOBS_PATH = "/jobs";
const AUDIO_SIGNED_TTL = 60 * 60 * 6; // 6 hours
const OUTPUT_UPLOAD_TTL = 60 * 60 * 6;
const OUTPUT_PLAYBACK_TTL = 60 * 60 * 24;

/**
 * Turns the worker's chunk-health record into one sentence a user can act on.
 *
 * Returns null when the render is healthy, so the notice clears itself as soon
 * as progress resumes rather than lingering after a chunk recovers.
 */
function describeStall(
  stalled: boolean,
  health: {
    state?: string;
    phase?: string;
    chunkIndex?: number | null;
    chunksTotal?: number | null;
    elapsedMs?: number;
    attempt?: number;
    maxAttempts?: number;
  } | null,
): string | null {
  if (!stalled || !health) return null;
  // chunkIndex is 0-based internally; users count segments from 1.
  const segment =
    health.chunkIndex != null
      ? `Segment ${health.chunkIndex + 1}${health.chunksTotal ? ` of ${health.chunksTotal}` : ""}`
      : "A segment";
  const minutes = health.elapsedMs ? Math.max(1, Math.round(health.elapsedMs / 60000)) : null;

  if (health.state === "retrying") {
    const attempt =
      health.attempt && health.maxAttempts
        ? ` (attempt ${health.attempt} of ${health.maxAttempts})`
        : "";
    return `${segment} timed out and is being retried${attempt}. Rendering will continue automatically.`;
  }
  const forLong = minutes ? ` for ${minutes} minute${minutes === 1 ? "" : "s"}` : "";
  const during = health.phase ? ` while ${health.phase}` : "";
  return `${segment} has been running${forLong}${during}. It will be retried automatically if it does not finish.`;
}

/** Narrows a jsonb column to the string[] the worker payload expects. */
function toFallbackUrls(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((url): url is string => typeof url === "string") : [];
}

/**
 * Render-job statuses that mean "this render is over". A worker 404 for a job in
 * one of these is expected: the worker cleans up after itself.
 */
const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Project statuses that mean the user is no longer waiting on this render. */
const TERMINAL_PROJECT_STATUSES = new Set(["completed", "failed", "cancelled", "ready"]);

function workerBase(): string {
  const url = process.env.RENDER_WORKER_URL;
  if (!url) throw new Error("RENDER_WORKER_URL is not configured.");
  return url.replace(/\/+$/, "");
}
function workerKey(): string {
  const key = process.env.RENDER_WORKER_API_KEY;
  if (!key) throw new Error("RENDER_WORKER_API_KEY is not configured.");
  return key;
}

/**
 * The user-facing message when the worker refuses a job submission.
 *
 * Exported so it can be pinned directly: this string is written into
 * render_jobs.error, where it outlives the request and is read by someone who
 * cannot act on a status code or a stack. The worker's body belongs in the
 * server log, never here.
 */
export function renderSubmitFailureMessage(status: number): string {
  return status === 404
    ? "The render service is unavailable right now. Please try again in a moment."
    : `The render could not be started (HTTP ${status}). Please try again.`;
}

/**
 * Create the render_jobs row, gather clips + audio signed URLs, request an
 * output upload URL, then POST /jobs on the render worker. Flips project.status
 * to "rendering".
 */
export const submitRenderJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const projectId = data.projectId;

    await assertMaintenanceAllows("start_render", userId);

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, status, user_id, aspect_ratio, clip_duration_seconds, niche")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");
    if (!["ready", "failed", "completed"].includes(project.status)) {
      throw new Error(`Project is not ready to render (status: ${project.status}).`);
    }

    // Load scenes in timeline order. The plain path requires selected_clips;
    // fixed-duration rendering uses render_clip_slices as the source of truth.
    const { data: scenes, error: scenesErr } = await supabase
      .from("scenes")
      .select(
        "id, idx, start_ts, end_ts, visual_query, selected_clips(in_point, out_point, clip_candidates(url, fallback_urls, provider, provider_clip_id))",
      )
      .eq("project_id", projectId)
      .order("idx", { ascending: true });
    if (scenesErr) throw new Error(scenesErr.message);
    if (!scenes || scenes.length === 0) throw new Error("No scenes found for this project.");

    type SceneRow = {
      id: string;
      idx: number;
      start_ts: number | string | null;
      end_ts: number | string | null;
      visual_query: string | null;
      selected_clips: {
        in_point: number;
        out_point: number;
        clip_candidates: {
          url: string;
          provider: string;
          provider_clip_id: string;
          fallback_urls?: unknown;
        };
      } | null;
    };
    const sceneRows = scenes as unknown as SceneRow[];

    const { data: asset, error: assetErr } = await supabase
      .from("audio_assets")
      .select("storage_path, duration_sec")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (assetErr) throw new Error(assetErr.message);
    if (!asset) throw new Error("No audio for this project.");

    const measuredAudioDuration = Number(asset.duration_sec);
    const narrationEnd = Math.max(...sceneRows.map((scene) => Number(scene.end_ts ?? 0)));
    const audioDuration =
      Number.isFinite(measuredAudioDuration) && measuredAudioDuration > 0
        ? Math.max(measuredAudioDuration, narrationEnd)
        : narrationEnd;

    const fixedDuration =
      project.clip_duration_seconds != null ? Number(project.clip_duration_seconds) : null;

    // ── Alternate candidates per scene ────────────────────────────────────
    // The worker has no database, so if a clip's source is dead at render time
    // the only alternatives it can try are the ones this payload carries.
    // fallback_urls are renditions of the SAME source and die with it; these
    // are the scene's next-best DIFFERENT sources, mirroring matching's own
    // degradation tiers. Two per clip: enough to survive a dead source, small
    // enough not to bloat a 600-clip payload.
    //
    // Best-effort by design — a project rendered fine before alternates
    // existed, and must not fail because this query did.
    const alternatesByScene = new Map<string, string[]>();
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: altRows } = await supabaseAdmin
        .from("clip_candidates")
        .select("scene_id, url, score, scenes!inner(project_id)")
        .eq("scenes.project_id", projectId)
        .order("score", { ascending: false })
        .limit(10000);
      for (const row of altRows ?? []) {
        const list = alternatesByScene.get(row.scene_id) ?? [];
        if (list.length < 6 && typeof row.url === "string") list.push(row.url);
        alternatesByScene.set(row.scene_id, list);
      }
    } catch (err) {
      console.warn("[render] alternate candidates unavailable", {
        projectId,
        error: (err as Error).message,
      });
    }
    const alternatesFor = (sceneId: string | undefined, primaryUrl: string): string[] =>
      sceneId
        ? (alternatesByScene.get(sceneId) ?? []).filter((url) => url !== primaryUrl).slice(0, 2)
        : [];

    // scene_id / provider_clip_id are diagnostic only: they let the worker name
    // the scene and source in its freeze-frame and in-point-guard warnings
    // instead of reporting a bare clip index.
    let clips: Array<{
      clip_url: string;
      start: number;
      end: number;
      scene_id?: string;
      provider_clip_id?: string | null;
      /** Smaller renditions of the same source, for oversize fall-through. */
      fallback_urls?: string[];
      /** The scene's next-best candidates, for dead-source fall-through. */
      alternate_urls?: string[];
    }>;
    const renderTransition = "hard-cut" as const;

    if (fixedDuration == null || !(fixedDuration > 0)) {
      const { buildSceneTimelineSlots } = await import("@/lib/clip-slices.server");
      const sceneById = new Map(sceneRows.map((scene) => [scene.id, scene]));
      clips = buildSceneTimelineSlots(sceneRows, audioDuration).map((slot) => {
        const scene = sceneById.get(slot.sceneId);
        if (!scene?.selected_clips?.clip_candidates?.url) {
          throw new Error(`Scene ${slot.sceneIdx + 1} has no selected clip.`);
        }
        const start = Number(scene.selected_clips.in_point);
        return {
          clip_url: scene.selected_clips.clip_candidates.url,
          start,
          end: start + slot.durationSeconds,
          scene_id: slot.sceneId,
          provider_clip_id: scene.selected_clips.clip_candidates.provider_clip_id ?? null,
          fallback_urls: toFallbackUrls(scene.selected_clips.clip_candidates.fallback_urls),
          alternate_urls: alternatesFor(slot.sceneId, scene.selected_clips.clip_candidates.url),
        };
      });
    } else {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { buildExpectedSliceSlots, describeMissingSlots, sliceKey, summarizeSliceCoverage } =
        await import("@/lib/clip-slices.server");

      const { data: existingSlices } = await supabaseAdmin
        .from("render_clip_slices")
        .select(
          "scene_id, slice_index, clip_url, fallback_urls, provider, provider_clip_id, in_point_seconds, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
        )
        .eq("project_id", projectId);

      const eligibleExistingSlices = existingSlices ?? [];
      const coverage = summarizeSliceCoverage(
        scenes,
        fixedDuration,
        eligibleExistingSlices,
        audioDuration,
      );
      const sliceCache = new Map(
        eligibleExistingSlices.map((row) => [sliceKey(row.scene_id, row.slice_index), row]),
      );
      const cacheComplete =
        coverage.missingSlots.length === 0 && coverage.actualCount === coverage.expectedCount;

      if (cacheComplete) {
        clips = buildExpectedSliceSlots(sceneRows, fixedDuration, audioDuration).map((slot) => {
          const cached = sliceCache.get(sliceKey(slot.sceneId, slot.sliceIndex));
          if (!cached) {
            throw new Error(
              `Missing fixed-duration clip for scene ${slot.sceneIdx + 1}, slice ${slot.sliceIndex + 1}.`,
            );
          }
          const start = Number(cached.in_point_seconds);
          return {
            clip_url: cached.clip_url,
            start,
            end: start + slot.durationSeconds,
            scene_id: slot.sceneId,
            provider_clip_id: cached.provider_clip_id ?? null,
            fallback_urls: toFallbackUrls(cached.fallback_urls),
            alternate_urls: alternatesFor(slot.sceneId, cached.clip_url),
          };
        });
        if (clips.length === 0) throw new Error("No clips could be prepared for rendering.");

        console.info("[submitRenderJob:fixed-duration-cache]", {
          projectId,
          expectedSlices: coverage.expectedCount,
          cachedSlices: coverage.actualCount,
        });
      } else {
        console.warn("[submitRenderJob:fixed-duration-cache-miss]", {
          projectId,
          expectedSlices: coverage.expectedCount,
          cachedSlices: coverage.actualCount,
          missing: describeMissingSlots(coverage.missingSlots),
        });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Load any previously persisted slices for this project
        const { data: existingSlices } = await supabaseAdmin
          .from("render_clip_slices")
          .select(
            "scene_id, slice_index, clip_url, fallback_urls, provider, provider_clip_id, in_point_seconds, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
          )
          .eq("project_id", projectId);

        // Build a lookup map: `${scene_id}:${slice_index}` -> slice row
        const sliceCache = new Map<
          string,
          {
            clip_url: string;
            provider: string;
            provider_clip_id: string | null;
            in_point_seconds: number;
            thumbnail_url: string | null;
          }
        >();
        const eligibleFallbackSlices = existingSlices ?? [];
        for (const row of eligibleFallbackSlices) {
          sliceCache.set(`${row.scene_id}:${row.slice_index}`, {
            clip_url: row.clip_url,
            provider: row.provider,
            provider_clip_id: row.provider_clip_id ?? null,
            in_point_seconds: Number(row.in_point_seconds),
            thumbnail_url: row.thumbnail_url ?? null,
          });
        }

        const {
          searchStockFootage,
          stockReservationKey,
          orientationForAspect,
          targetWidthForAspect,
        } = await import("@/lib/stock.server");
        const orientation = orientationForAspect(project.aspect_ratio ?? "9:16");
        const targetWidth = targetWidthForAspect(project.aspect_ratio ?? "9:16");

        // Project-wide dedup set, seeded with the clips already selected AND existing slice rows.
        const usedIds = new Set<string>();
        for (const scene of sceneRows) {
          const selection = scene.selected_clips;
          if (!selection?.clip_candidates?.provider_clip_id) continue;
          usedIds.add(
            stockReservationKey(
              selection.clip_candidates.provider as "pexels" | "pixabay" | "nasa",
              selection.clip_candidates.provider_clip_id,
              Number(selection.in_point),
            ),
          );
        }
        for (const row of eligibleFallbackSlices) {
          if (!row.provider_clip_id) continue;
          usedIds.add(
            stockReservationKey(
              row.provider as "pexels" | "pixabay" | "nasa",
              row.provider_clip_id,
              Number(row.in_point_seconds),
            ),
          );
        }
        const expectedSlots = buildExpectedSliceSlots(sceneRows, fixedDuration, audioDuration);
        const sceneById = new Map(sceneRows.map((scene) => [scene.id, scene]));

        // Build new slice rows to insert (only for slots not already cached)
        const newSliceRows: Array<{
          project_id: string;
          scene_id: string;
          slice_index: number;
          clip_url: string;
          provider: string;
          provider_clip_id: string | null;
          in_point_seconds: number;
          duration_seconds: number;
          timeline_start_seconds: number;
          timeline_end_seconds: number;
          thumbnail_url: string | null;
        }> = [];

        clips = [];
        for (const slot of expectedSlots) {
          const scene = sceneById.get(slot.sceneId);
          if (!scene) {
            throw new Error(`Scene ${slot.sceneIdx + 1} is missing from the render timeline.`);
          }
          const cacheKey = `${slot.sceneId}:${slot.sliceIndex}`;
          const cached = sliceCache.get(cacheKey);

          let url: string;
          let provider = "pexels";
          let providerClipId: string | null = null;
          let inPoint = 0;
          let thumbnailUrl: string | null = null;

          if (cached) {
            // Reuse persisted assignment â€” no API call needed
            url = cached.clip_url;
            provider = cached.provider;
            providerClipId = cached.provider_clip_id;
            inPoint = cached.in_point_seconds;
            thumbnailUrl = cached.thumbnail_url;
          } else {
            // Search for a new clip
            let found: string | null = null;
            if (scene.visual_query) {
              const result = await searchStockFootage({
                query: scene.visual_query,
                orientation,
                minDurationSec: fixedDuration, // always request full fixedDuration
                targetWidth,
                usedIds: [...usedIds],
                seed: `${projectId}:${slot.sceneId}:${slot.sliceIndex}`,
                niche: project.niche,
              });
              if (result) {
                found = result.chosenFile.url;
                provider = result.pick.provider;
                providerClipId = result.pick.provider_clip_id;
                inPoint = result.inPoint;
                thumbnailUrl = result.pick.thumbnail_url ?? null;
                usedIds.add(result.reservationKey);
              }
            }
            const selectedUrl = scene.selected_clips?.clip_candidates?.url;
            const fallbackUrl = selectedUrl ?? null;
            if (!found && !fallbackUrl) {
              throw new Error(`Scene ${scene.idx + 1} has no selected clip fallback.`);
            }
            url = found ?? fallbackUrl!;
            if (!found && scene.selected_clips) {
              provider = scene.selected_clips.clip_candidates.provider;
              providerClipId = scene.selected_clips.clip_candidates.provider_clip_id;
              inPoint = Number(scene.selected_clips.in_point);
            }

            // Queue this new assignment for persistence
          }

          newSliceRows.push({
            project_id: projectId,
            scene_id: slot.sceneId,
            slice_index: slot.sliceIndex,
            clip_url: url,
            provider,
            provider_clip_id: providerClipId,
            in_point_seconds: inPoint,
            duration_seconds: slot.durationSeconds,
            timeline_start_seconds: slot.timelineStart,
            timeline_end_seconds: slot.timelineEnd,
            thumbnail_url: thumbnailUrl,
          });
          clips.push({
            clip_url: url,
            start: inPoint,
            end: inPoint + slot.durationSeconds,
          });
        }
        if (clips.length === 0) throw new Error("No clips could be prepared for rendering.");

        if (newSliceRows.length > 0) {
          await supabaseAdmin.from("render_clip_slices").upsert(newSliceRows, {
            onConflict: "project_id,scene_id,slice_index",
          });
        }

        const { data: finalSlices } = await supabaseAdmin
          .from("render_clip_slices")
          .select(
            "scene_id, slice_index, clip_url, fallback_urls, provider, provider_clip_id, in_point_seconds, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
          )
          .eq("project_id", projectId);
        const finalCoverage = summarizeSliceCoverage(
          scenes,
          fixedDuration,
          finalSlices ?? [],
          audioDuration,
        );
        if (
          finalCoverage.missingSlots.length > 0 ||
          finalCoverage.actualCount !== finalCoverage.expectedCount
        ) {
          throw new Error(
            `Fixed-duration footage cache incomplete after fallback search: expected ${finalCoverage.expectedCount} slices, prepared ${finalCoverage.actualCount}. Missing ${describeMissingSlots(finalCoverage.missingSlots)}.`,
          );
        }

        const finalCache = new Map(
          (finalSlices ?? []).map((row) => [sliceKey(row.scene_id, row.slice_index), row]),
        );
        clips = buildExpectedSliceSlots(sceneRows, fixedDuration, audioDuration).map((slot) => {
          const row = finalCache.get(sliceKey(slot.sceneId, slot.sliceIndex));
          if (!row) {
            throw new Error(
              `Missing fixed-duration clip for scene ${slot.sceneIdx + 1}, slice ${slot.sliceIndex + 1}.`,
            );
          }
          const start = Number(row.in_point_seconds);
          return {
            clip_url: row.clip_url,
            start,
            end: start + slot.durationSeconds,
            scene_id: slot.sceneId,
            provider_clip_id: row.provider_clip_id ?? null,
            fallback_urls: toFallbackUrls(row.fallback_urls),
            alternate_urls: alternatesFor(slot.sceneId, row.clip_url),
          };
        });
      }
    }

    const totalVisualDuration = clips.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
    if (Math.abs(totalVisualDuration - audioDuration) > 0.05) {
      throw new Error(
        `Render timeline duration mismatch: visual ${totalVisualDuration.toFixed(2)}s vs audio ${audioDuration.toFixed(2)}s.`,
      );
    }

    // Signed audio URL.
    const { data: audioSigned, error: audioErr } = await supabase.storage
      .from("audio")
      .createSignedUrl(asset.storage_path, AUDIO_SIGNED_TTL);
    if (audioErr || !audioSigned?.signedUrl) {
      throw new Error(audioErr?.message ?? "Could not sign audio URL.");
    }

    // Aspect ratio -> dimensions.
    // DB stores 'landscape' | 'portrait' | 'square' (human-readable).
    // Legacy fallback: accept old '16:9' / '9:16' / '1:1' values too.
    const ratio = project.aspect_ratio ?? "portrait";
    const dims =
      ratio === "landscape" || ratio === "16:9"
        ? { width: 1920, height: 1080 }
        : ratio === "square" || ratio === "1:1"
          ? { width: 1080, height: 1080 }
          : { width: 1080, height: 1920 }; // 'portrait' | '9:16' | anything else

    // Load admin client for privileged writes (render_jobs insert + signed upload URL).
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const settings = {
      ...dims,
      fps: 30,
      transition: renderTransition,
      transition_duration: 0.5,
      format: "mp4" as const,
    };

    const { data: jobRow, error: jobErr } = await supabaseAdmin
      .from("render_jobs")
      .insert({
        project_id: projectId,
        status: "queued",
        progress_pct: 0,
        settings,
      })
      .select("id")
      .single();
    if (jobErr || !jobRow) throw new Error(jobErr?.message ?? "Failed to create render job.");

    const outputPath = `${projectId}/${jobRow.id}.mp4`;
    const { data: uploadSigned, error: uploadErr } = await supabaseAdmin.storage
      .from("render-outputs")
      .createSignedUploadUrl(outputPath);
    if (uploadErr || !uploadSigned?.signedUrl) {
      throw new Error(uploadErr?.message ?? "Could not create output upload URL.");
    }

    const body = {
      job_id: jobRow.id,
      // Lets the worker enforce per-user fairness. Admission counts projects,
      // which is right for capacity and wrong for fairness — without an owner
      // one account submitting five projects fills every slot and blocks
      // everyone else. Not used for authorisation: the worker only ever
      // compares it to other owner ids.
      owner_id: userId,
      clips,
      audio_url: audioSigned.signedUrl,
      ...dims,
      fps: 30,
      transition: renderTransition,
      transition_duration: 0.5,
      format: "mp4",
      output_upload_url: uploadSigned.signedUrl,
    };

    const res = await fetch(`${workerBase()}${WORKER_JOBS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": workerKey(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Same rule as the poll path: the worker's body is diagnostic, not a user
      // message. It goes to the server log; the row and the thrown error carry
      // plain language only.
      const text = await res.text().catch(() => "");
      console.error("[render] worker rejected job submission", {
        jobId: jobRow.id,
        status: res.status,
        body: text.slice(0, 500),
      });
      const msg = renderSubmitFailureMessage(res.status);
      await supabaseAdmin
        .from("render_jobs")
        .update({ status: "failed", error: msg, completed_at: new Date().toISOString() })
        .eq("id", jobRow.id);
      throw new Error(msg);
    }

    await supabaseAdmin
      .from("projects")
      .update({ status: "rendering", error_message: null })
      .eq("id", projectId);
    await supabaseAdmin
      .from("render_jobs")
      .update({ started_at: new Date().toISOString() })
      .eq("id", jobRow.id);

    return { ok: true as const, jobId: jobRow.id };
  });

/**
 * Poll a render job on the worker, mirror status/progress/output/error into
 * render_jobs, and move project.status through rendering -> completed / failed.
 * Returns a summary the client can render.
 */
export const pollRenderJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => JobIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: job, error: jobErr } = await supabase
      .from("render_jobs")
      .select(
        "id, project_id, status, progress_pct, output_url, error, chunks_total, chunks_completed, projects!inner(user_id)",
      )
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    if (!job) {
      return {
        status: "not_found",
        progress_pct: 0,
        output_url: null,
        error: "This render job no longer exists.",
        chunks_total: null,
        chunks_completed: null,
      };
    }
    const projectUserId = (job as unknown as { projects: { user_id: string } }).projects.user_id;
    if (projectUserId !== userId) throw new Error("Forbidden.");

    // Short-circuit terminal states.
    // For completed jobs, always re-sign the playback URL from the known storage
    // path rather than returning whatever is stored â€” the stored value may be a
    // pre-signed upload URL (written by the worker) or an expired playback URL.
    if (job.status === "completed" || job.status === "failed") {
      let outputUrl = job.output_url;
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      if (job.status === "completed") {
        const storagePath = `${job.project_id}/${job.id}.mp4`;
        const { data: signed } = await supabaseAdmin.storage
          .from("render-outputs")
          .createSignedUrl(storagePath, OUTPUT_PLAYBACK_TTL);
        if (signed?.signedUrl) {
          outputUrl = signed.signedUrl;
          // Persist the fresh playback URL so subsequent page loads don't need to re-sign
          await supabaseAdmin
            .from("render_jobs")
            .update({ output_url: outputUrl })
            .eq("id", job.id);
        }
      }
      await supabaseAdmin
        .from("projects")
        .update(
          job.status === "completed"
            ? { status: "completed", error_message: null }
            : { status: "failed", error_message: job.error ?? "Render failed." },
        )
        .eq("id", job.project_id);
      return {
        status: job.status,
        progress_pct: job.progress_pct,
        output_url: outputUrl,
        error: job.error,
        chunks_total: job.chunks_total ?? null,
        chunks_completed: job.chunks_completed ?? null,
      };
    }

    const res = await fetch(`${workerBase()}${WORKER_JOBS_PATH}/${job.id}`, {
      method: "GET",
      headers: { "X-Api-Key": workerKey() },
    });

    // ── 404 is terminal, not an error (round 8, Problem 1) ────────────────────
    // A cancelled render removes its jobs from the worker. The app kept polling
    // and surfaced `Render worker poll failed (404): {"error":"Job not found"}`
    // to a user who had just cancelled on purpose. Both sides were behaving
    // correctly; only the client's reading of 404 was wrong.
    //
    // The worker not knowing a job means one of two things, and they are not the
    // same event: either we already know the render is over — expected, say
    // nothing — or we believed it was still running and it has vanished, which
    // is a real failure that deserves plain language, not raw JSON.
    if (res.status === 404) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: current } = await supabaseAdmin
        .from("projects")
        .select("status")
        .eq("id", job.project_id)
        .maybeSingle();

      const settled =
        TERMINAL_RENDER_STATUSES.has(job.status) ||
        (current?.status != null && TERMINAL_PROJECT_STATUSES.has(current.status));

      if (settled) {
        // Expected. Report the state we already hold so the client stops polling
        // without showing anything.
        return {
          status: job.status === "cancelled" ? "failed" : job.status,
          progress_pct: job.progress_pct,
          output_url: job.output_url,
          error: job.error,
          stall_notice: null,
          chunks_total: job.chunks_total ?? null,
          chunks_completed: job.chunks_completed ?? null,
        };
      }

      const message =
        "The render stopped unexpectedly and is no longer running. Please start it again.";
      await supabaseAdmin
        .from("render_jobs")
        .update({
          status: "failed",
          error: message,
          stall_notice: null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      await supabaseAdmin
        .from("projects")
        .update({ status: "failed", error_message: message })
        .eq("id", job.project_id);

      console.warn("[render-poll] worker no longer knows this job", {
        jobId: job.id,
        projectId: job.project_id,
        jobStatus: job.status,
        projectStatus: current?.status ?? null,
      });

      return {
        status: "failed",
        progress_pct: job.progress_pct,
        output_url: null,
        error: message,
        stall_notice: null,
        chunks_total: job.chunks_total ?? null,
        chunks_completed: job.chunks_completed ?? null,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Logged in full; the user gets a sentence, not a payload.
      console.warn("[render-poll] worker poll failed", {
        jobId: job.id,
        status: res.status,
        body: text.slice(0, 500),
      });
      throw new Error(
        `The render worker could not be reached (HTTP ${res.status}). Rendering will retry automatically.`,
      );
    }
    const payload = (await res.json()) as {
      status?: string;
      progress_pct?: number;
      output_url?: string | null;
      error?: string | null;
      chunks_total?: number | null;
      chunks_completed?: number | null;
      queue_position?: number | null;
      queue_estimate_seconds?: number | null;
      stitch_state?: string | null;
      stitches_ahead?: number | null;
      chunk_state?: string | null;
      chunks_ahead?: number | null;
      stalled?: boolean;
      health?: {
        state?: string;
        phase?: string;
        chunkIndex?: number | null;
        chunksTotal?: number | null;
        elapsedMs?: number;
        attempt?: number;
        maxAttempts?: number;
      } | null;
    };

    const rawStatus = (payload.status ?? "queued").toLowerCase();
    const allowed = ["queued", "downloading", "rendering", "completed", "failed"] as const;
    const status = (allowed as readonly string[]).includes(rawStatus) ? rawStatus : "rendering";
    const progress = Math.max(0, Math.min(100, Math.round(payload.progress_pct ?? 0)));
    const outputUrl = payload.output_url ?? null;
    const error = payload.error ?? null;
    const chunksTotal = payload.chunks_total ?? null;
    const chunksCompleted = payload.chunks_completed ?? null;
    // Non-terminal warning: the render is still running, but a chunk is past
    // half its watchdog budget or is being retried. Round 7, Problem 3 — the
    // deployed hang showed 12/13 with no indication anything was wrong.
    const stallNotice = describeStall(payload.stalled === true, payload.health ?? null);
    // A project waiting for a render slot is not stalled and is not failing —
    // it is third in line. Kept in its own columns rather than folded into
    // stall_notice, which the UI renders as a warning.
    const queuePosition =
      typeof payload.queue_position === "number" && payload.queue_position > 0
        ? payload.queue_position
        : null;
    const queueEstimateSeconds =
      queuePosition != null && typeof payload.queue_estimate_seconds === "number"
        ? payload.queue_estimate_seconds
        : null;
    // The stitch window: all chunks rendered, video not yet delivered. Values
    // are constrained in the DB, so an unrecognised state from a mismatched
    // worker version degrades to "no notice" rather than a failed UPDATE.
    const stitchState =
      payload.stitch_state === "waiting" ||
      payload.stitch_state === "combining" ||
      payload.stitch_state === "uploading"
        ? payload.stitch_state
        : null;
    const stitchesAhead =
      stitchState === "waiting" && typeof payload.stitches_ahead === "number"
        ? payload.stitches_ahead
        : null;
    // The mirror image at the other end of the render: admitted, but no chunk
    // worker free yet. Same degrade-to-null rule for an unrecognised value.
    const chunkState =
      payload.chunk_state === "waiting" || payload.chunk_state === "encoding"
        ? payload.chunk_state
        : null;
    const chunksAhead =
      chunkState === "waiting" && typeof payload.chunks_ahead === "number"
        ? payload.chunks_ahead
        : null;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const jobUpdate: {
      status: string;
      progress_pct: number;
      error: string | null;
      stall_notice: string | null;
      completed_at?: string;
      output_url?: string | null;
      chunks_total?: number | null;
      chunks_completed?: number | null;
      queue_position?: number | null;
      queue_estimate_seconds?: number | null;
      stitch_state?: string | null;
      stitches_ahead?: number | null;
      chunk_state?: string | null;
      chunks_ahead?: number | null;
    } = {
      status,
      progress_pct: progress,
      error,
      stall_notice: stallNotice,
      chunks_total: chunksTotal,
      chunks_completed: chunksCompleted,
      queue_position: queuePosition,
      queue_estimate_seconds: queueEstimateSeconds,
      stitch_state: stitchState,
      stitches_ahead: stitchesAhead,
      chunk_state: chunkState,
      chunks_ahead: chunksAhead,
    };
    if (status === "completed") {
      jobUpdate.completed_at = new Date().toISOString();
      jobUpdate.progress_pct = 100;
      jobUpdate.stall_notice = null;
      jobUpdate.queue_position = null;
      jobUpdate.queue_estimate_seconds = null;
      jobUpdate.chunk_state = null;
      jobUpdate.chunks_ahead = null;
      jobUpdate.stitch_state = null;
      jobUpdate.stitches_ahead = null;
      if (chunksTotal != null) jobUpdate.chunks_completed = chunksTotal;
    }
    if (status === "failed") {
      jobUpdate.completed_at = new Date().toISOString();
    }

    // Resign the playback URL from our known storage path so a private bucket still works.
    let playbackUrl: string | null = outputUrl;
    if (status === "completed") {
      const path = `${job.project_id}/${job.id}.mp4`;
      const { data: signed } = await supabaseAdmin.storage
        .from("render-outputs")
        .createSignedUrl(path, OUTPUT_PLAYBACK_TTL);
      if (signed?.signedUrl) playbackUrl = signed.signedUrl;
      jobUpdate.output_url = playbackUrl;
    }

    await supabaseAdmin.from("render_jobs").update(jobUpdate).eq("id", job.id);

    // Mirror to project.status.
    if (status === "completed") {
      await supabaseAdmin
        .from("projects")
        .update({ status: "completed", error_message: null })
        .eq("id", job.project_id);
    } else if (status === "failed") {
      await supabaseAdmin
        .from("projects")
        .update({ status: "failed", error_message: error ?? "Render failed." })
        .eq("id", job.project_id);
    } else {
      await supabaseAdmin.from("projects").update({ status: "rendering" }).eq("id", job.project_id);
    }

    return {
      status,
      progress_pct: progress,
      output_url: playbackUrl,
      error,
      chunks_total: chunksTotal,
      chunks_completed:
        status === "completed" && chunksTotal != null ? chunksTotal : chunksCompleted,
      queue_position: queuePosition,
      queue_estimate_seconds: queueEstimateSeconds,
      stitch_state: stitchState,
      stitches_ahead: stitchesAhead,
      chunk_state: chunkState,
      chunks_ahead: chunksAhead,
    };
  });

// Silence unused ttl warning if compiler flags it.
void OUTPUT_UPLOAD_TTL;

const ACTIVE_RENDER_STATUSES = [
  "queued",
  "downloading",
  "rendering",
  "stitching",
  "uploading",
] as const;

/**
 * Cancel a queued or active render job.
 * - Verifies ownership via render_jobs â†’ projects join
 * - Calls POST /jobs/:id/cancel on the render worker
 * - Updates render_jobs.status = 'cancelled' (only if still active)
 * - Updates projects.status = 'failed', error_message = 'Render was cancelled.'
 */
export const cancelRenderJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => JobIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Cancelling is blocked too. It looks harmless, but it writes to
    // render_jobs and projects and calls the worker — all of which is exactly
    // what a freeze exists to stop. The render is paused, not lost, so there is
    // nothing to escape from.
    await assertMaintenanceAllows("cancel_render", userId);

    // Verify ownership
    const { data: job, error: jobErr } = await supabase
      .from("render_jobs")
      .select("id, project_id, status, projects!inner(user_id)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    if (!job) throw new Error("Render job not found.");
    const ownerUserId = (job as unknown as { projects: { user_id: string } }).projects.user_id;
    if (ownerUserId !== userId) throw new Error("Forbidden.");

    // Call worker cancel endpoint
    const res = await fetch(`${workerBase()}/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: { "X-Api-Key": workerKey() },
    });
    // 404 means the worker has already forgotten this job — it finished, was
    // already cancelled, or was reaped. Cancelling something already gone is the
    // outcome the caller wanted, so fall through and settle the DB rows.
    if (!res.ok && res.status !== 404) {
      throw new Error(
        "The render could not be cancelled. It may still be running; please try again.",
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = new Date().toISOString();

    // Only update if still in an active status (race: job may have completed)
    const { error: cancelWriteError } = await supabaseAdmin
      .from("render_jobs")
      .update({ status: "cancelled", completed_at: now })
      .eq("id", job.id)
      .in("status", ACTIVE_RENDER_STATUSES);
    // Checked, not swallowed. This write silently violated a check constraint
    // that did not list 'cancelled', so every cancel left the job row claiming
    // to be rendering. An unchecked write is how that stayed invisible.
    if (cancelWriteError) {
      console.error("[render] could not mark job cancelled", {
        jobId: job.id,
        code: cancelWriteError.code,
        message: cancelWriteError.message,
      });
      throw new Error("The render was stopped but its status could not be saved.");
    }

    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: "Render was cancelled." })
      .eq("id", job.project_id);

    return { ok: true as const, jobId: job.id };
  });
