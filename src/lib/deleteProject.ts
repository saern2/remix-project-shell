import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertMaintenanceAllows } from "@/lib/maintenance.server";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });

const ACTIVE_STATUSES = ["queued", "downloading", "rendering"] as const;

/**
 * Permanently delete a project and all its associated Storage objects.
 * Order: cancel active render → delete audio Storage → delete render Storage → delete DB row
 * Storage errors are logged but do NOT halt the operation (DB delete always runs).
 */
export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const projectId = data.projectId;

    await assertMaintenanceAllows("delete_project", userId);

    // Verify ownership (REQ 4.2)
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, name, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Block service-role pipeline callbacks before any child rows or files disappear.
    const { error: cancelPipelineError } = await supabaseAdmin
      .from("projects")
      .update({ pipeline_cancel_requested_at: new Date().toISOString() })
      .eq("id", projectId);
    if (cancelPipelineError) {
      throw new Error("Could not stop project processing. Please try deleting again.");
    }

    // Cancel any active render job first (REQ 4.3)
    const { data: activeJob } = await supabaseAdmin
      .from("render_jobs")
      .select("id, status")
      .eq("project_id", projectId)
      .in("status", ACTIVE_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeJob) {
      try {
        const { cancelRenderJob } = await import("@/lib/render.functions");
        await cancelRenderJob({ data: { jobId: activeJob.id } });
      } catch (err) {
        console.error("[deleteProject] cancel failed:", (err as Error).message);
        // Do not abort — proceed to cleanup
      }
    }

    // Storage cleanup: audio assets (REQ 4.4)
    const { data: audioAssets } = await supabaseAdmin
      .from("audio_assets")
      .select("storage_path")
      .eq("project_id", projectId);
    const audioPaths = (audioAssets ?? []).map((a) => a.storage_path).filter(Boolean);
    if (audioPaths.length > 0) {
      const { error: audioErr } = await supabaseAdmin.storage.from("audio").remove(audioPaths);
      if (audioErr) console.error("[deleteProject] audio Storage error:", audioErr.message);
    }

    // Storage cleanup: render outputs (REQ 4.5)
    const { data: renderJobs } = await supabaseAdmin
      .from("render_jobs")
      .select("id")
      .eq("project_id", projectId);
    const renderPaths = (renderJobs ?? []).map((j) => `${projectId}/${j.id}.mp4`);
    if (renderPaths.length > 0) {
      const { error: renderErr } = await supabaseAdmin.storage
        .from("render-outputs")
        .remove(renderPaths);
      if (renderErr) console.error("[deleteProject] render Storage error:", renderErr.message);
    }

    // DB delete — cascades to all child rows via ON DELETE CASCADE (REQ 4.7)
    const { error: delErr } = await supabaseAdmin.from("projects").delete().eq("id", projectId);
    if (delErr) throw new Error(delErr.message);

    return { ok: true as const, projectId };
  });
