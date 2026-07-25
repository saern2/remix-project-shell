import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });

/**
 * Delete a project and its associated storage objects.
 *
 * Order of operations:
 * 1. Verify caller owns the project.
 * 2. Remove the audio file(s) referenced by audio_assets.storage_path.
 * 3. Remove any rendered outputs under render-outputs/{projectId}/.
 * 4. Only then delete the projects row (DB cascades handle related rows).
 *
 * If any storage cleanup step fails, we abort BEFORE deleting the DB row so
 * files are never orphaned silently.
 */
export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { projectId } = data;

    // 1. Ownership check.
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");

    // 2. Gather audio storage paths.
    const { data: audioAssets, error: audioErr } = await supabase
      .from("audio_assets")
      .select("storage_path")
      .eq("project_id", projectId);
    if (audioErr) throw new Error(`Failed to load audio assets: ${audioErr.message}`);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const audioPaths = (audioAssets ?? [])
      .map((a) => a.storage_path)
      .filter((p): p is string => !!p);

    if (audioPaths.length > 0) {
      const { error: rmAudioErr } = await supabaseAdmin.storage
        .from("audio")
        .remove(audioPaths);
      if (rmAudioErr) {
        throw new Error(`Failed to remove audio files: ${rmAudioErr.message}`);
      }
    }

    // 3. Remove any render outputs under render-outputs/{projectId}/.
    const { data: outputList, error: listErr } = await supabaseAdmin.storage
      .from("render-outputs")
      .list(projectId, { limit: 1000 });
    if (listErr) {
      throw new Error(`Failed to list render outputs: ${listErr.message}`);
    }
    const outputPaths = (outputList ?? [])
      .filter((f) => f.name && !f.name.startsWith("."))
      .map((f) => `${projectId}/${f.name}`);
    if (outputPaths.length > 0) {
      const { error: rmOutErr } = await supabaseAdmin.storage
        .from("render-outputs")
        .remove(outputPaths);
      if (rmOutErr) {
        throw new Error(`Failed to remove render outputs: ${rmOutErr.message}`);
      }
    }

    // 4. Delete the project row (DB cascades handle related rows).
    const { error: delErr } = await supabase
      .from("projects")
      .delete()
      .eq("id", projectId);
    if (delErr) throw new Error(`Failed to delete project: ${delErr.message}`);

    return { ok: true as const };
  });
