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
      .select("id, status, user_id, aspect_ratio")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");
    if (!["ready", "failed", "completed"].includes(project.status)) {
      throw new Error(`Project is not ready to render (status: ${project.status}).`);
    }

    // Load scenes in timeline order + their selected clip.
    const { data: scenes, error: scenesErr } = await supabase
      .from("scenes")
      .select(
        "id, idx, selected_clips!inner(in_point, out_point, clip_candidates!inner(url))",
      )
      .eq("project_id", projectId)
      .order("idx", { ascending: true });
    if (scenesErr) throw new Error(scenesErr.message);
    if (!scenes || scenes.length === 0) throw new Error("No scenes with clips selected.");

    type SceneRow = {
      idx: number;
      selected_clips: {
        in_point: number;
        out_point: number;
        clip_candidates: { url: string };
      };
    };
    const clips = (scenes as unknown as SceneRow[]).map((s) => ({
      clip_url: s.selected_clips.clip_candidates.url,
      start: Number(s.selected_clips.in_point),
      end: Number(s.selected_clips.out_point),
    }));

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
    const ratio = project.aspect_ratio ?? "9:16";
    const dims = ratio === "16:9"
      ? { width: 1920, height: 1080 }
      : ratio === "1:1"
        ? { width: 1080, height: 1080 }
        : { width: 1080, height: 1920 };

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
      .select("id, project_id, status, progress_pct, output_url, error, chunks_total, chunks_completed, projects!inner(user_id)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    if (!job) throw new Error("Render job not found.");
    const projectUserId = (job as unknown as { projects: { user_id: string } }).projects.user_id;
    if (projectUserId !== userId) throw new Error("Forbidden.");

    // Short-circuit terminal states.
    if (job.status === "completed" || job.status === "failed") {
      return {
        status: job.status,
        progress_pct: job.progress_pct,
        output_url: job.output_url,
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
      await supabaseAdmin
        .from("projects")
        .update({ status: "rendering" })
        .eq("id", job.project_id);
    }

    return {
      status,
      progress_pct: progress,
      output_url: playbackUrl,
      error,
      chunks_total: chunksTotal,
      chunks_completed: status === "completed" && chunksTotal != null ? chunksTotal : chunksCompleted,
    };
  });

// Silence unused ttl warning if compiler flags it.
void OUTPUT_UPLOAD_TTL;
