import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });

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
      const message = err instanceof Error ? err.message : "Failed to start pipeline.";
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("projects")
        .update({ status: "failed", error_message: message })
        .eq("id", projectId);
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
  }

  const { data: asset } = await supabaseAdmin
    .from("audio_assets")
    .select("id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

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
    const { error: sErr } = await supabaseAdmin.from("scenes").insert(sceneRows);
    if (sErr) throw new Error(sErr.message);
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
    if (!project) throw new Error("Project not found.");
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

    await supabaseAdmin
      .from("projects")
      .update({ status: "generating_scenes", error_message: null })
      .eq("id", projectId);
    return { status: "generating_scenes", error_message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription step failed.";
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: message })
      .eq("id", projectId);
    return { status: "failed", error_message: message };
  }
}

async function advanceFromGeneratingScenes(projectId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    const { data: scenes, error } = await supabaseAdmin
      .from("scenes")
      .select("id, idx, text")
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
    const category = (projectRow?.category ?? null) as "war" | "crime" | null;

    const { generateVisualQueries } = await import("@/lib/visual-queries.server");
    const queries = await generateVisualQueries(
      scenes.map((s) => s.text),
      category,
    );

    for (let i = 0; i < scenes.length; i++) {
      const { error: uErr } = await supabaseAdmin
        .from("scenes")
        .update({ visual_query: queries[i], status: "query_ready" })
        .eq("id", scenes[i].id);
      if (uErr) throw new Error(uErr.message);
    }

    await supabaseAdmin
      .from("projects")
      .update({ status: "matching_footage", error_message: null })
      .eq("id", projectId);
    return { status: "matching_footage", error_message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Visual query generation failed.";
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: message })
      .eq("id", projectId);
    return { status: "failed", error_message: message };
  }
}

async function advanceFromMatchingFootage(projectId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    const { data: project, error: pErr } = await supabaseAdmin
      .from("projects")
      .select("id, aspect_ratio, clip_duration_seconds, niche")
      .eq("id", projectId)
      .single();
    if (pErr || !project) throw new Error(pErr?.message ?? "Project not found.");

    const { data: scenes, error } = await supabaseAdmin
      .from("scenes")
      .select("id, idx, text, start_ts, end_ts, visual_query")
      .eq("project_id", projectId)
      .order("idx", { ascending: true });
    if (error) throw new Error(error.message);
    if (!scenes || scenes.length === 0) {
      await supabaseAdmin.from("projects").update({ status: "ready" }).eq("id", projectId);
      return { status: "ready", error_message: null };
    }

    const { searchStockFootage, orientationForAspect, targetWidthForAspect } =
      await import("@/lib/stock.server");
    const orientation = orientationForAspect(project.aspect_ratio);
    const targetWidth = targetWidthForAspect(project.aspect_ratio);
    const projectNiche = project.niche;

    const fixedDuration =
      project.clip_duration_seconds != null ? Number(project.clip_duration_seconds) : null;

    if (fixedDuration != null && fixedDuration > 0) {
      const {
        asyncPool,
        buildExpectedSliceSlots,
        describeMissingSlots,
        fixedSceneDuration,
        sliceKey,
        summarizeSliceCoverage,
      } = await import("@/lib/clip-slices.server");

      const { data: existingSlices } = await supabaseAdmin
        .from("render_clip_slices")
        .select(
          "scene_id, slice_index, clip_url, provider_clip_id, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
        )
        .eq("project_id", projectId);

      const startedAt = Date.now();
      const expectedSlots = buildExpectedSliceSlots(scenes, fixedDuration);
      const sliceCache = new Map<
        string,
        {
          clip_url: string;
          provider_clip_id: string | null;
          duration_seconds: number;
          timeline_start_seconds: number;
          timeline_end_seconds: number;
          thumbnail_url: string | null;
        }
      >();
      for (const row of existingSlices ?? []) {
        sliceCache.set(sliceKey(row.scene_id, row.slice_index), {
          clip_url: row.clip_url,
          provider_clip_id: row.provider_clip_id ?? null,
          duration_seconds: Number(row.duration_seconds),
          timeline_start_seconds: Number(row.timeline_start_seconds),
          timeline_end_seconds: Number(row.timeline_end_seconds),
          thumbnail_url: row.thumbnail_url ?? null,
        });
      }

      const usedIds = new Set<string>(
        (existingSlices ?? []).map((r) => r.provider_clip_id).filter((x): x is string => !!x),
      );
      const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
      const pendingSlots = expectedSlots.filter(
        (slot) => !sliceCache.has(sliceKey(slot.sceneId, slot.sliceIndex)),
      );
      const newSliceRows: Array<{
        project_id: string;
        scene_id: string;
        slice_index: number;
        clip_url: string;
        provider_clip_id: string | null;
        provider: "pexels" | "pixabay" | "nasa";
        duration_seconds: number;
        timeline_start_seconds: number;
        timeline_end_seconds: number;
        thumbnail_url: string | null;
      }> = [];
      const unmatchedSlots: typeof pendingSlots = [];
      const FIXED_DURATION_CONCURRENCY = 4;

      await asyncPool(pendingSlots, FIXED_DURATION_CONCURRENCY, async (slot) => {
        const scene = sceneById.get(slot.sceneId);
        if (!scene?.visual_query) {
          unmatchedSlots.push(slot);
          return;
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await searchStockFootage({
            query: scene.visual_query,
            orientation,
            minDurationSec: slot.durationSeconds,
            targetWidth,
            usedIds: [...usedIds],
            seed: `${projectId}:${slot.sceneId}:${slot.sliceIndex}`,
            niche: project.niche,
          });
          if (!result) {
            unmatchedSlots.push(slot);
            return;
          }

          const providerClipId = result.pick.provider_clip_id;
          if (usedIds.has(providerClipId) && attempt === 0) continue;

          usedIds.add(providerClipId);
          const row = {
            project_id: projectId,
            scene_id: slot.sceneId,
            slice_index: slot.sliceIndex,
            clip_url: result.chosenFile.url,
            provider_clip_id: providerClipId,
            provider: result.pick.provider,
            duration_seconds: slot.durationSeconds,
            timeline_start_seconds: slot.timelineStart,
            timeline_end_seconds: slot.timelineEnd,
            thumbnail_url: result.pick.thumbnail_url ?? null,
          };
          newSliceRows.push(row);
          const { provider: _provider, ...sliceRow } = row;
          void _provider;
          await supabaseAdmin
            .from("render_clip_slices")
            .upsert(sliceRow, { onConflict: "project_id,scene_id,slice_index" });
          return;
        }

        unmatchedSlots.push(slot);
      });

      if (unmatchedSlots.length > 0) {
        throw new Error(
          `Could not match stock footage for ${unmatchedSlots.length} fixed-duration slot(s): ${describeMissingSlots(unmatchedSlots)}. Try a different category or clip duration, then retry matching.`,
        );
      }

      const { data: finalSlices } = await supabaseAdmin
        .from("render_clip_slices")
        .select(
          "scene_id, slice_index, clip_url, provider_clip_id, duration_seconds, timeline_start_seconds, timeline_end_seconds, thumbnail_url",
        )
        .eq("project_id", projectId);
      const allRows = finalSlices ?? [];
      const coverage = summarizeSliceCoverage(scenes, fixedDuration, allRows);
      if (coverage.missingSlots.length > 0 || coverage.actualCount !== coverage.expectedCount) {
        throw new Error(
          `Fixed-duration footage matching incomplete: expected ${coverage.expectedCount} slices, prepared ${coverage.actualCount}. Missing ${describeMissingSlots(coverage.missingSlots)}.`,
        );
      }

      const { data: selectedRows } = await supabaseAdmin
        .from("selected_clips")
        .select("scene_id")
        .in(
          "scene_id",
          scenes.map((s) => s.id),
        );
      const selectedSceneIds = new Set((selectedRows ?? []).map((row) => row.scene_id));

      for (const scene of scenes) {
        if (selectedSceneIds.has(scene.id)) {
          await supabaseAdmin.from("scenes").update({ status: "selected" }).eq("id", scene.id);
          continue;
        }

        const firstSlot = allRows
          .filter((row) => row.scene_id === scene.id)
          .sort((a, b) => a.slice_index - b.slice_index)[0];
        if (!firstSlot) continue;
        const firstSlotKey = sliceKey(scene.id, firstSlot.slice_index);
        const firstSlotProvider =
          newSliceRows.find((row) => sliceKey(row.scene_id, row.slice_index) === firstSlotKey)
            ?.provider ?? "pexels";

        const { data: candidate } = await supabaseAdmin
          .from("clip_candidates")
          .insert({
            scene_id: scene.id,
            provider: firstSlotProvider,
            provider_clip_id: firstSlot.provider_clip_id ?? `slot-${scene.id}-0`,
            url: firstSlot.clip_url,
            thumbnail_url: firstSlot.thumbnail_url ?? null,
            width: targetWidth,
            height: Math.round(targetWidth * (orientation === "portrait" ? 16 / 9 : 9 / 16)),
            duration_sec: Number(firstSlot.duration_seconds),
          })
          .select("id")
          .maybeSingle();

        if (candidate?.id) {
          await supabaseAdmin.from("selected_clips").upsert(
            {
              scene_id: scene.id,
              clip_candidate_id: candidate.id,
              in_point: 0,
              out_point: Math.min(
                Number(firstSlot.duration_seconds),
                Math.max(fixedSceneDuration(scene), 1),
              ),
            },
            { onConflict: "scene_id" },
          );
          await supabaseAdmin.from("scenes").update({ status: "selected" }).eq("id", scene.id);
        }
      }

      console.info("[matching_footage:fixed-duration]", {
        projectId,
        scenes: scenes.length,
        expectedSlices: coverage.expectedCount,
        cachedSlices: sliceCache.size,
        searchedSlices: newSliceRows.length,
        concurrency: FIXED_DURATION_CONCURRENCY,
        elapsedMs: Date.now() - startedAt,
      });

      await supabaseAdmin
        .from("projects")
        .update({ status: "ready", error_message: null })
        .eq("id", projectId);
      return { status: "ready", error_message: null };
    }

    // ── Plain path (no fixed duration) — unchanged ────────────────────────
    // Existing selections (idempotent re-runs). Skip scenes already selected.
    const { data: existingSel } = await supabaseAdmin
      .from("selected_clips")
      .select("scene_id, clip_candidates!inner(provider_clip_id)")
      .in(
        "scene_id",
        scenes.map((s) => s.id),
      );
    const alreadySelected = new Set((existingSel ?? []).map((r) => r.scene_id));
    const usedIds: string[] = (existingSel ?? [])
      .map(
        (r) =>
          (r as { clip_candidates: { provider_clip_id: string } | null }).clip_candidates
            ?.provider_clip_id,
      )
      .filter((x): x is string => !!x);

    const CONCURRENCY = 5;
    const pending = scenes.filter((s) => !alreadySelected.has(s.id));

    async function processScene(scene: NonNullable<typeof scenes>[number]) {
      const query = scene.visual_query;
      if (!query) {
        await supabaseAdmin.from("scenes").update({ status: "failed" }).eq("id", scene.id);
        return;
      }
      const minDuration = Math.max(1, Math.ceil(Number(scene.end_ts) - Number(scene.start_ts)));
      const result = await searchStockFootage({
        query,
        orientation,
        minDurationSec: minDuration,
        targetWidth,
        usedIds: [...usedIds],
        niche: projectNiche,
      });
      if (!result) {
        await supabaseAdmin.from("scenes").update({ status: "failed" }).eq("id", scene.id);
        return;
      }

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
      const { error: sErr } = await supabaseAdmin.from("selected_clips").upsert(
        {
          scene_id: scene.id,
          clip_candidate_id: candidate.id,
          in_point: 0,
          out_point: Math.min(pick.duration_sec, Math.max(sceneDuration, 1)),
        },
        { onConflict: "scene_id" },
      );
      if (sErr) throw new Error(sErr.message);

      await supabaseAdmin.from("scenes").update({ status: "selected" }).eq("id", scene.id);
      usedIds.push(pick.provider_clip_id);
    }

    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((s) => processScene(s)));
    }

    await supabaseAdmin
      .from("projects")
      .update({ status: "ready", error_message: null })
      .eq("id", projectId);
    return { status: "ready", error_message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stock footage matching failed.";
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: message })
      .eq("id", projectId);
    return { status: "failed", error_message: message };
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
        in_point: 0,
        out_point: Math.min(pick.duration_sec, Math.max(sceneDuration, 1)),
      },
      { onConflict: "scene_id" },
    );
    if (upErr) throw new Error(upErr.message);

    return { ok: true };
  });
