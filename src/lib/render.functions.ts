import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });
const JobIdInput = z.object({ jobId: z.string().uuid() });

const WORKER_JOBS_PATH = "/jobs";
const AUDIO_SIGNED_TTL = 60 * 60 * 6; // 6 hours
const OUTPUT_UPLOAD_TTL = 60 * 60 * 6;
const OUTPUT_PLAYBACK_TTL = 60 * 60 * 24;

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

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, status, user_id, aspect_ratio, clip_duration_seconds")
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
        "id, idx, start_ts, end_ts, visual_query, selected_clips(in_point, out_point, clip_candidates(url, provider_clip_id))",
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
        clip_candidates: { url: string; provider_clip_id: string };
      } | null;
    };
    const sceneRows = scenes as unknown as SceneRow[];

    const fixedDuration =
      project.clip_duration_seconds != null ? Number(project.clip_duration_seconds) : null;

    let clips: Array<{ clip_url: string; start: number; end: number }>;

    if (fixedDuration == null || !(fixedDuration > 0)) {
      // Default behavior: exactly one clip per scene, natural sentence length.
      clips = sceneRows.map((s) => {
        if (!s.selected_clips?.clip_candidates?.url) {
          throw new Error(`Scene ${s.idx + 1} has no selected clip.`);
        }
        return {
          clip_url: s.selected_clips.clip_candidates.url,
          start: Number(s.selected_clips.in_point),
          end: Number(s.selected_clips.out_point),
        };
      });
    } else {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { buildExpectedSliceSlots, describeMissingSlots, sliceKey, summarizeSliceCoverage } =
        await import("@/lib/clip-slices.server");

      const { data: existingSlices } = await supabaseAdmin
        .from("render_clip_slices")
        .select("scene_id, slice_index, clip_url, provider_clip_id, duration_seconds")
        .eq("project_id", projectId);

      const coverage = summarizeSliceCoverage(scenes, fixedDuration, existingSlices ?? []);
      const sliceCache = new Map(
        (existingSlices ?? []).map((row) => [sliceKey(row.scene_id, row.slice_index), row]),
      );
      const cacheComplete =
        coverage.missingSlots.length === 0 && coverage.actualCount === coverage.expectedCount;

      if (cacheComplete) {
        clips = buildExpectedSliceSlots(sceneRows, fixedDuration).map((slot) => {
          const cached = sliceCache.get(sliceKey(slot.sceneId, slot.sliceIndex));
          if (!cached) {
            throw new Error(
              `Missing fixed-duration clip for scene ${slot.sceneIdx + 1}, slice ${slot.sliceIndex + 1}.`,
            );
          }
          return { clip_url: cached.clip_url, start: 0, end: fixedDuration };
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
          .select("scene_id, slice_index, clip_url, provider_clip_id, duration_seconds")
          .eq("project_id", projectId);

        // Build a lookup map: `${scene_id}:${slice_index}` -> slice row
        const sliceCache = new Map<
          string,
          { clip_url: string; provider_clip_id: string | null; duration_seconds: number }
        >();
        for (const row of existingSlices ?? []) {
          sliceCache.set(`${row.scene_id}:${row.slice_index}`, {
            clip_url: row.clip_url,
            provider_clip_id: row.provider_clip_id ?? null,
            duration_seconds: Number(row.duration_seconds),
          });
        }

        const { searchStockFootage, orientationForAspect, targetWidthForAspect } =
          await import("@/lib/stock.server");
        const orientation = orientationForAspect(project.aspect_ratio ?? "9:16");
        const targetWidth = targetWidthForAspect(project.aspect_ratio ?? "9:16");

        // Project-wide dedup set, seeded with the clips already selected AND existing slice rows.
        const usedIds = new Set<string>([
          ...sceneRows
            .map((s) => s.selected_clips?.clip_candidates?.provider_clip_id)
            .filter(Boolean),
          ...(existingSlices ?? []).map((r) => r.provider_clip_id).filter((x): x is string => !!x),
        ]);

        // Build new slice rows to insert (only for slots not already cached)
        const newSliceRows: Array<{
          project_id: string;
          scene_id: string;
          slice_index: number;
          clip_url: string;
          provider_clip_id: string | null;
          duration_seconds: number;
        }> = [];

        clips = [];
        for (const scene of sceneRows) {
          const sceneStart = Number(scene.start_ts ?? 0);
          const sceneEnd = Number(scene.end_ts ?? 0);
          const total = Math.max(0, sceneEnd - sceneStart);
          if (total <= 0) continue;

          // Every slot is exactly fixedDuration seconds — even if the scene voiceover
          // is shorter. The video plays the full fixedDuration; audio continues into
          // the next scene while this visual is still showing. This is intentional
          // (Option A): uniform clip length takes priority over voiceover-visual sync.
          const slots = Math.max(1, Math.ceil(total / fixedDuration));

          for (let slotIdx = 0; slotIdx < slots; slotIdx++) {
            const cacheKey = `${scene.id}:${slotIdx}`;
            const cached = sliceCache.get(cacheKey);

            let url: string;
            let providerClipId: string | null = null;

            if (cached) {
              // Reuse persisted assignment — no API call needed
              url = cached.clip_url;
              providerClipId = cached.provider_clip_id;
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
                });
                if (result) {
                  found = result.chosenFile.url;
                  providerClipId = result.pick.provider_clip_id;
                  usedIds.add(result.pick.provider_clip_id);
                }
              }
              const fallbackUrl = scene.selected_clips?.clip_candidates?.url;
              if (!found && !fallbackUrl) {
                throw new Error(`Scene ${scene.idx + 1} has no selected clip fallback.`);
              }
              url = found ?? fallbackUrl!;

              // Queue this new assignment for persistence
              newSliceRows.push({
                project_id: projectId,
                scene_id: scene.id as string,
                slice_index: slotIdx,
                clip_url: url,
                provider_clip_id: providerClipId,
                duration_seconds: fixedDuration,
              });
            }

            // Always use the full fixedDuration — never a sub-duration remainder.
            clips.push({ clip_url: url, start: 0, end: fixedDuration });
          }
        }
        if (clips.length === 0) throw new Error("No clips could be prepared for rendering.");

        if (newSliceRows.length > 0) {
          await supabaseAdmin.from("render_clip_slices").upsert(newSliceRows, {
            onConflict: "project_id,scene_id,slice_index",
          });
        }
      }
    }

    // Signed audio URL.
    const { data: asset, error: assetErr } = await supabase
      .from("audio_assets")
      .select("storage_path")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (assetErr) throw new Error(assetErr.message);
    if (!asset) throw new Error("No audio for this project.");

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
      transition: "crossfade" as const,
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
      clips,
      audio_url: audioSigned.signedUrl,
      ...dims,
      fps: 30,
      transition: "crossfade",
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
      const text = await res.text().catch(() => "");
      const msg = `Render worker rejected job (${res.status}): ${text.slice(0, 300)}`;
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
    if (!job) throw new Error("Render job not found.");
    const projectUserId = (job as unknown as { projects: { user_id: string } }).projects.user_id;
    if (projectUserId !== userId) throw new Error("Forbidden.");

    // Short-circuit terminal states.
    // For completed jobs, always re-sign the playback URL from the known storage
    // path rather than returning whatever is stored — the stored value may be a
    // pre-signed upload URL (written by the worker) or an expired playback URL.
    if (job.status === "completed" || job.status === "failed") {
      let outputUrl = job.output_url;
      if (job.status === "completed") {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Render worker poll failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const payload = (await res.json()) as {
      status?: string;
      progress_pct?: number;
      output_url?: string | null;
      error?: string | null;
      chunks_total?: number | null;
      chunks_completed?: number | null;
    };

    const rawStatus = (payload.status ?? "queued").toLowerCase();
    const allowed = ["queued", "downloading", "rendering", "completed", "failed"] as const;
    const status = (allowed as readonly string[]).includes(rawStatus) ? rawStatus : "rendering";
    const progress = Math.max(0, Math.min(100, Math.round(payload.progress_pct ?? 0)));
    const outputUrl = payload.output_url ?? null;
    const error = payload.error ?? null;
    const chunksTotal = payload.chunks_total ?? null;
    const chunksCompleted = payload.chunks_completed ?? null;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const jobUpdate: {
      status: string;
      progress_pct: number;
      error: string | null;
      completed_at?: string;
      output_url?: string | null;
      chunks_total?: number | null;
      chunks_completed?: number | null;
    } = {
      status,
      progress_pct: progress,
      error,
      chunks_total: chunksTotal,
      chunks_completed: chunksCompleted,
    };
    if (status === "completed") {
      jobUpdate.completed_at = new Date().toISOString();
      jobUpdate.progress_pct = 100;
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
 * - Verifies ownership via render_jobs → projects join
 * - Calls POST /jobs/:id/cancel on the render worker
 * - Updates render_jobs.status = 'cancelled' (only if still active)
 * - Updates projects.status = 'failed', error_message = 'Render was cancelled.'
 */
export const cancelRenderJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => JobIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Worker cancel failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = new Date().toISOString();

    // Only update if still in an active status (race: job may have completed)
    await supabaseAdmin
      .from("render_jobs")
      .update({ status: "cancelled", completed_at: now })
      .eq("id", job.id)
      .in("status", ACTIVE_RENDER_STATUSES);

    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: "Render was cancelled." })
      .eq("id", job.project_id);

    return { ok: true as const, jobId: job.id };
  });
