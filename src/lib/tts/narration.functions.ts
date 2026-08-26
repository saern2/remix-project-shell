/**
 * Server functions for server-side narration (Round B).
 *
 * Three thin verbs around the pure logic in narration.ts:
 *
 *   submitNarrationJob — signed upload URL + POST to the tts-worker. The
 *     sentence array is computed app-side (script-input.ts owns sanitisation
 *     and splitting); the worker performs zero text processing.
 *   pollNarrationJob — reads the worker, applies narrationPollVerdict, and
 *     writes honest failures onto the project. Transport errors are thrown
 *     as transient (the client poll retries); they never fail a project.
 *   completeNarration — the idempotent handoff: audio_assets row, status
 *     generating_narration -> 'uploading', and the reconstructed timed
 *     sentences for the client's unchanged persistScriptTranscript call.
 *     Runs equally from the creating tab or a fresh one (tab-close
 *     survival): everything it needs rides the worker job, nothing rode
 *     the tab.
 *
 * persistScriptTranscript is deliberately NOT called from here — it stays
 * byte-untouched (Round B hard constraint), and the client calls it exactly
 * as the browser path does.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertNarrationArithmetic,
  buildSampleSpans,
  narrationJobId,
  narrationPollVerdict,
  narrationStoragePath,
  NarrationWorkerPayload,
  SERVER_TTS_VOICE_IDS,
  spansDurationSec,
  spansToTimedSentences,
} from "@/lib/tts/narration";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });

const SubmitInput = z.object({
  projectId: z.string().uuid(),
  sentences: z.array(z.string().min(1)).min(1),
  voice: z.enum(SERVER_TTS_VOICE_IDS),
  fullText: z.string().min(1),
});

function ttsWorkerBase(): string {
  const url = process.env.TTS_WORKER_URL;
  if (!url) throw new Error("TTS_WORKER_URL is not configured.");
  return url.replace(/\/+$/, "");
}
function ttsWorkerKey(): string {
  const key = process.env.TTS_WORKER_API_KEY;
  if (!key) throw new Error("TTS_WORKER_API_KEY is not configured.");
  return key;
}

/** Ownership + status read, shared by all three verbs. */
async function loadOwnProject(supabase: unknown, userId: string, projectId: string) {
  const client = supabase as {
    from(table: string): {
      select(cols: string): {
        eq(col: string, v: string): { maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }> };
      };
    };
  };
  const { data, error } = await client
    .from("projects")
    .select("id, status, user_id, updated_at")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const project = data as { id: string; status: string; user_id: string; updated_at: string } | null;
  if (!project) throw new Error("Project not found.");
  if (project.user_id !== userId) throw new Error("Forbidden.");
  return project;
}

/** Marks the project failed with a message a person can act on. */
async function failProject(projectId: string, message: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("projects")
    .update({ status: "failed", error_message: message })
    .eq("id", projectId)
    .eq("status", "generating_narration");
}

export const submitNarrationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SubmitInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const project = await loadOwnProject(supabase, userId, data.projectId);
    if (project.status !== "generating_narration") {
      throw new Error(`Project is not awaiting narration (status: ${project.status}).`);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const path = narrationStoragePath(data.projectId);
    // upsert: a legitimate resubmit (network doubt, double-click) must not
    // die on "object already exists" — the worker dedupes the job itself.
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from("audio")
      .createSignedUploadUrl(path, { upsert: true });
    if (signErr || !signed?.signedUrl) {
      throw new Error(signErr?.message ?? "Could not create the narration upload URL.");
    }

    const res = await fetch(`${ttsWorkerBase()}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": ttsWorkerKey() },
      body: JSON.stringify({
        job_id: narrationJobId(data.projectId),
        sentences: data.sentences,
        voice: data.voice,
        full_text: data.fullText,
        upload_url: signed.signedUrl,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[narration] worker rejected job submission", {
        projectId: data.projectId,
        status: res.status,
        body: text.slice(0, 300),
      });
      throw new Error(
        "The narration service could not accept this job right now. Please try again in a moment.",
      );
    }
    return { ok: true as const, jobId: narrationJobId(data.projectId) };
  });

export const pollNarrationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const project = await loadOwnProject(supabase, userId, data.projectId);

    let worker: { kind: "ok"; payload: NarrationWorkerPayload } | { kind: "not-found" };
    if (project.status !== "generating_narration") {
      // moved-on needs no worker read at all
      worker = { kind: "not-found" };
    } else {
      const res = await fetch(
        `${ttsWorkerBase()}/jobs/${narrationJobId(data.projectId)}`,
        { headers: { "X-Api-Key": ttsWorkerKey() } },
      );
      if (res.status === 404) {
        worker = { kind: "not-found" };
      } else if (!res.ok) {
        // Transport/server trouble is transient: the client poll retries.
        // A network blip must never fail a project.
        const text = await res.text().catch(() => "");
        console.warn("[narration] worker poll failed", {
          projectId: data.projectId,
          status: res.status,
          body: text.slice(0, 300),
        });
        throw new Error(
          `The narration service could not be reached (HTTP ${res.status}). Checking again automatically.`,
        );
      } else {
        worker = { kind: "ok", payload: (await res.json()) as NarrationWorkerPayload };
      }
    }

    const verdict = narrationPollVerdict({
      projectStatus: project.status,
      stateEnteredAtIso: project.updated_at,
      nowMs: Date.now(),
      worker,
    });

    if (verdict.action === "fail") {
      await failProject(data.projectId, verdict.message);
      return { status: "failed" as const, error: verdict.message };
    }
    if (verdict.action === "moved-on") return { status: "moved-on" as const };
    if (verdict.action === "complete") return { status: "completed" as const };
    return {
      status: "waiting" as const,
      worker_status: verdict.payload.status,
      queue_position: verdict.payload.queue_position ?? null,
      progress_pct: verdict.payload.progress_pct ?? null,
    };
  });

export const completeNarration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const project = await loadOwnProject(supabase, userId, data.projectId);

    // Idempotent: a second caller (creating tab + reopened tab) finds the
    // status already flipped and simply reports it; the client then lets the
    // normal pipeline UI take over.
    if (project.status !== "generating_narration") {
      return { status: "already-handed-off" as const, projectStatus: project.status };
    }

    const res = await fetch(
      `${ttsWorkerBase()}/jobs/${narrationJobId(data.projectId)}`,
      { headers: { "X-Api-Key": ttsWorkerKey() } },
    );
    if (!res.ok) {
      throw new Error(
        `The narration service could not be reached (HTTP ${res.status}). Please try again.`,
      );
    }
    const payload = (await res.json()) as NarrationWorkerPayload;
    if (payload.status !== "completed") {
      throw new Error(`The narration is not finished yet (status: ${payload.status}).`);
    }
    if (
      !Array.isArray(payload.sentences) ||
      !Array.isArray(payload.sample_counts) ||
      typeof payload.wav_bytes !== "number" ||
      typeof payload.full_text !== "string" ||
      typeof payload.voice !== "string"
    ) {
      throw new Error(
        "The narration finished but its result could not be read. Please try again.",
      );
    }

    // Reconstruct timings in samples; the arithmetic gate proves the file in
    // storage IS the audio these counts describe, before anything persists.
    const spans = buildSampleSpans(payload.sentences, payload.sample_counts);
    assertNarrationArithmetic(payload.wav_bytes, spans);
    const timedSentences = spansToTimedSentences(spans);
    const durationSec = spansDurationSec(spans);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const storagePath = narrationStoragePath(data.projectId);

    // THE FLIP IS THE MUTEX. Two tabs (the creating one and a reopened one)
    // can both reach here; the conditional update admits exactly one — the
    // loser's update matches zero rows and it reports already-handed-off.
    // Flip-first is also crash-honest: a winner that dies before the asset
    // insert leaves the project in 'uploading' with no audio, which the next
    // persistScriptTranscript call fails LOUDLY ("No audio uploaded") — an
    // honest failure, never a silent strand. 'uploading' is also what makes
    // the unchanged persistScriptTranscript accept the project (its gate).
    const { data: flipped, error: flipErr } = await supabaseAdmin
      .from("projects")
      .update({ status: "uploading" })
      .eq("id", data.projectId)
      .eq("status", "generating_narration")
      .select("id");
    if (flipErr) throw new Error(flipErr.message);
    if (!flipped || flipped.length === 0) {
      return { status: "already-handed-off" as const, projectStatus: "uploading" };
    }

    const { error: assetErr } = await supabaseAdmin.from("audio_assets").insert({
      project_id: data.projectId,
      storage_path: storagePath,
      filename: "narration.wav",
      file_size_bytes: payload.wav_bytes,
      mime_type: "audio/wav",
      duration_sec: durationSec,
    });
    if (assetErr) throw new Error(assetErr.message);

    return {
      status: "ready-to-persist" as const,
      fullText: payload.full_text,
      voice: payload.voice,
      durationSec,
      sentences: timedSentences,
    };
  });
