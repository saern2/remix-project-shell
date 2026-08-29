/**
 * Server functions for motion explainers (Round D, Item 4).
 *
 * KEY STORAGE (D5): the user's provider key is AES-256-GCM encrypted HERE,
 * with MOTION_KEY_ENCRYPTION_SECRET from the app's server env, before it
 * touches the service-role-only user_provider_keys table. It is decrypted
 * exactly once per submission and sent inside the authenticated app→worker
 * POST; the worker re-encrypts with its own secret before Redis. The
 * browser never sees a saved key again — only {saved, tail}. Never logged:
 * no console path in this file carries the plaintext.
 *
 * CEILING SHARING (Item 4): a motion submission creates an ordinary
 * render_jobs row (status 'queued', settings.mode 'motion'), so Round A's
 * in-flight count includes motion jobs with render-inflight.ts untouched —
 * and this file runs the same count before submitting, so the bound holds
 * in both directions.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  keyTail,
  MOTION_MODELS,
  motionJobId,
  motionPollVerdict,
  motionStoragePath,
  type MotionWorkerPayload,
} from "@/lib/motion/motion";
import {
  INFLIGHT_RENDER_STATUSES,
  INFLIGHT_STALE_AFTER_HOURS,
  inflightRefusalMessage,
  maxInflightProjects,
  shouldRefuseSubmission,
} from "@/lib/render-inflight";
import { isProjectLimitError, PROJECT_LIMIT_MESSAGE } from "@/lib/project-limit";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });
const SaveKeyInput = z.object({ key: z.string().min(12).max(400) });
const SubmitInput = z.object({
  name: z.string().max(200),
  brief: z.string().min(10).max(20_000),
  model: z.enum(MOTION_MODELS.map((m) => m.id) as [string, ...string[]]),
});

function motionWorkerBase(): string {
  const url = process.env.MOTION_WORKER_URL;
  if (!url) throw new Error("MOTION_WORKER_URL is not configured.");
  return url.replace(/\/+$/, "");
}
function motionWorkerKey(): string {
  const key = process.env.MOTION_WORKER_API_KEY;
  if (!key) throw new Error("MOTION_WORKER_API_KEY is not configured.");
  return key;
}

// ── App-side key crypto (Web Crypto — available in the Workers runtime) ────
async function aesKey(): Promise<CryptoKey> {
  const secret = process.env.MOTION_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error("MOTION_KEY_ENCRYPTION_SECRET is not configured.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function fromBase64(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
}

export async function encryptProviderKey(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return toBase64(out);
}

export async function decryptProviderKey(encoded: string): Promise<string> {
  const raw = fromBase64(encoded);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) },
    await aesKey(),
    raw.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

export const saveProviderKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveKeyInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const trimmed = data.key.trim();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("user_provider_keys").upsert(
      {
        user_id: userId,
        ciphertext: await encryptProviderKey(trimmed),
        key_tail: keyTail(trimmed),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error("Your key could not be saved. Please try again.");
    return { saved: true as const, tail: keyTail(trimmed) };
  });

export const getProviderKeyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("user_provider_keys")
      .select("key_tail")
      .eq("user_id", context.userId)
      .maybeSingle();
    return { hasKey: !!data, tail: data?.key_tail ?? null };
  });

export const submitMotionJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SubmitInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: keyRow } = await supabaseAdmin
      .from("user_provider_keys")
      .select("ciphertext")
      .eq("user_id", userId)
      .maybeSingle();
    if (!keyRow) {
      throw new Error("Save your AI provider API key first — the form above explains how to get one.");
    }

    // Round A's ceiling, shared in this direction too: same count, same
    // refusal wording, motion and render jobs under one bound.
    {
      const cutoffIso = new Date(Date.now() - INFLIGHT_STALE_AFTER_HOURS * 60 * 60 * 1000).toISOString();
      const { count, error: countErr } = await supabaseAdmin
        .from("render_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", [...INFLIGHT_RENDER_STATUSES])
        .gte("created_at", cutoffIso);
      if (!countErr) {
        const limit = maxInflightProjects();
        if (shouldRefuseSubmission(count ?? 0, limit)) {
          throw new Error(inflightRefusalMessage(count ?? 0, limit));
        }
      }
    }

    // The project row, honestly named. The per-user project limit trigger
    // applies exactly as it does to the other modes.
    const { data: project, error: projectErr } = await supabaseAdmin
      .from("projects")
      .insert({
        name: data.name.trim() || "Untitled explainer",
        status: "generating_motion",
        user_id: userId,
        niche: "general",
      })
      .select("id")
      .single();
    if (projectErr || !project) {
      throw new Error(
        isProjectLimitError(projectErr) ? PROJECT_LIMIT_MESSAGE : (projectErr?.message ?? "Failed to create project."),
      );
    }

    // The render_jobs row is BOTH the ceiling vehicle and the delivery
    // vehicle: the worker uploads to `${projectId}/${renderJobId}.mp4`, the
    // exact path pollRenderJob's completed short-circuit re-signs.
    const { data: jobRow, error: jobErr } = await supabaseAdmin
      .from("render_jobs")
      .insert({
        project_id: project.id,
        status: "queued",
        progress_pct: 0,
        settings: { mode: "motion", model: data.model, resolution: "1080p", fps: 60 },
      })
      .select("id")
      .single();

    const abandon = async (message: string) => {
      // Nothing persisted on a refusal: the rows just created are removed
      // (cascade takes the job row), mirroring Round A's ceiling — a full
      // queue reads as a refusal, never as a permanently failed project.
      await supabaseAdmin.from("projects").delete().eq("id", project.id);
      throw new Error(message);
    };

    if (jobErr || !jobRow) return abandon(jobErr?.message ?? "Failed to create the explainer job.");

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from("render-outputs")
      .createSignedUploadUrl(motionStoragePath(project.id, jobRow.id));
    if (signErr || !signed?.signedUrl) {
      return abandon(signErr?.message ?? "Could not create the explainer upload URL.");
    }

    const response = await fetch(`${motionWorkerBase()}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": motionWorkerKey() },
      body: JSON.stringify({
        job_id: motionJobId(project.id),
        brief: data.brief.trim(),
        model: data.model,
        api_key: await decryptProviderKey(keyRow.ciphertext),
        upload_url: signed.signedUrl,
      }),
    });
    if (!response.ok) {
      // 429 carries the honest depth-and-wait message; pass it through.
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return abandon(
        body?.error ??
          "The explainer service could not accept this job right now. Please try again in a moment.",
      );
    }

    return { ok: true as const, projectId: project.id };
  });

export const pollMotionJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const client = supabase as never as {
      from(t: "projects"): {
        select(c: string): {
          eq(k: string, v: string): { maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }> };
        };
      };
    };
    const { data: raw, error } = await client
      .from("projects")
      .select("id, status, user_id, updated_at")
      .eq("id", data.projectId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const project = raw as { id: string; status: string; user_id: string; updated_at: string } | null;
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");

    let worker: { kind: "ok"; payload: MotionWorkerPayload } | { kind: "not-found" };
    if (project.status !== "generating_motion") {
      worker = { kind: "not-found" };
    } else {
      const response = await fetch(`${motionWorkerBase()}/jobs/${motionJobId(data.projectId)}`, {
        headers: { "X-Api-Key": motionWorkerKey() },
      });
      if (response.status === 404) worker = { kind: "not-found" };
      else if (!response.ok) {
        throw new Error(
          `The explainer service could not be reached (HTTP ${response.status}). Checking again automatically.`,
        );
      } else {
        worker = { kind: "ok", payload: (await response.json()) as MotionWorkerPayload };
      }
    }

    const verdict = motionPollVerdict({
      projectStatus: project.status,
      stateEnteredAtIso: project.updated_at,
      nowMs: Date.now(),
      worker,
    });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (verdict.action === "fail") {
      await supabaseAdmin
        .from("projects")
        .update({ status: "failed", error_message: verdict.message })
        .eq("id", data.projectId)
        .eq("status", "generating_motion");
      await supabaseAdmin
        .from("render_jobs")
        .update({ status: "failed", error: verdict.message, completed_at: new Date().toISOString() })
        .eq("project_id", data.projectId)
        .eq("status", "queued");
      return { status: "failed" as const, error: verdict.message };
    }
    if (verdict.action === "moved-on") return { status: "moved-on" as const };
    if (verdict.action === "complete") {
      // The handoff, idempotent via the conditional updates: job row →
      // completed (pollRenderJob's short-circuit then re-signs the playback
      // URL from the storage path), project → completed.
      await supabaseAdmin
        .from("render_jobs")
        .update({ status: "completed", progress_pct: 100, completed_at: new Date().toISOString() })
        .eq("project_id", data.projectId)
        .eq("status", "queued");
      await supabaseAdmin
        .from("projects")
        .update({ status: "completed", error_message: null })
        .eq("id", data.projectId)
        .eq("status", "generating_motion");
      return { status: "completed" as const };
    }
    return {
      status: "waiting" as const,
      worker_status: verdict.payload.status,
      queue_position: verdict.payload.queue_position ?? null,
      eta_seconds: verdict.payload.eta_seconds ?? null,
      progress_pct: verdict.payload.progress_pct ?? null,
    };
  });
