/**
 * Reading and toggling maintenance mode.
 *
 * The toggle is the only write path, so the admin check lives here rather than
 * in an RLS policy that would have to be kept in step with it. The table grants
 * no write to `authenticated` at all — admin or not — which means a policy
 * cannot be the thing that goes wrong.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MaintenanceState } from "@/lib/maintenance";
import {
  invalidateMaintenanceCache,
  isAdminUser,
  readMaintenanceState,
} from "@/lib/maintenance.server";

export type MaintenanceView = MaintenanceState & {
  /** True for the caller, so the UI knows whether to show the admin banner. */
  viewerIsAdmin: boolean;
  /** Projects the worker has parked, so a project that fails to resume is visible. */
  frozenProjects: Array<{
    projectId: string;
    jobId: string;
    phase: string;
    chunkIndex: number | null;
    chunksTotal: number | null;
    frozenAt: string;
  }>;
  /** Live counts for the confirmation dialog. Null when the worker is unreachable. */
  renderingCount: number | null;
  queuedCount: number | null;
  matchingCount: number;
};

function workerBase(): string | null {
  const url = process.env.RENDER_WORKER_URL;
  return url ? url.replace(/\/+$/, "") : null;
}

/**
 * Asks the worker for its view: what it has frozen and what is running.
 *
 * Never throws. The worker being unreachable is a normal state during
 * maintenance — it may be the thing being deployed — and must not stop the
 * admin page from rendering or the toggle from working.
 */
async function readWorkerState(): Promise<{
  frozen: MaintenanceView["frozenProjects"];
  rendering: number | null;
  queued: number | null;
}> {
  const base = workerBase();
  const key = process.env.RENDER_WORKER_API_KEY;
  if (!base || !key) return { frozen: [], rendering: null, queued: null };

  try {
    const res = await fetch(`${base}/maintenance`, {
      method: "GET",
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { frozen: [], rendering: null, queued: null };
    const body = (await res.json()) as {
      frozen?: MaintenanceView["frozenProjects"];
      rendering_count?: number | null;
      queued_count?: number | null;
    };
    return {
      frozen: body.frozen ?? [],
      rendering: body.rendering_count ?? null,
      queued: body.queued_count ?? null,
    };
  } catch {
    return { frozen: [], rendering: null, queued: null };
  }
}

/** Pushes the flag to the worker. Never throws, for the same reason. */
async function pushWorkerState(enabled: boolean, message: string | null, enabledBy: string) {
  const base = workerBase();
  const key = process.env.RENDER_WORKER_API_KEY;
  if (!base || !key) return { ok: false, detail: "Worker URL or key not configured." };

  try {
    const res = await fetch(`${base}/maintenance`, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, message, enabled_by: enabledBy }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `Worker returned HTTP ${res.status}.` };
    return { ok: true, detail: null };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** How many projects are mid-matching, for the confirmation dialog. */
async function countMatching(): Promise<number> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("status", "matching_footage");
    return count ?? 0;
  } catch {
    return 0;
  }
}

export const getMaintenanceState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MaintenanceView> => {
    const state = await readMaintenanceState();
    const viewerIsAdmin = await isAdminUser(context.userId);

    // Non-admins get the state and nothing else: which projects are frozen and
    // how many are rendering is operational detail, and it is not theirs.
    if (!viewerIsAdmin) {
      return {
        ...state,
        viewerIsAdmin: false,
        frozenProjects: [],
        renderingCount: null,
        queuedCount: null,
        matchingCount: 0,
      };
    }

    const [worker, matchingCount] = await Promise.all([readWorkerState(), countMatching()]);
    return {
      ...state,
      viewerIsAdmin: true,
      frozenProjects: worker.frozen,
      renderingCount: worker.rendering,
      queuedCount: worker.queued,
      matchingCount,
    };
  });

export const setMaintenanceState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        enabled: z.boolean(),
        // Trimmed to something a banner can hold. Blank means no estimate is
        // given, which is honest and better than inventing one.
        message: z.string().trim().max(200).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (!(await isAdminUser(context.userId))) throw new Error("Forbidden.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const message = data.message?.trim() ? data.message.trim() : null;

    const { error } = await supabaseAdmin
      .from("maintenance_state")
      .update({
        enabled: data.enabled,
        message,
        enabled_by: data.enabled ? context.userId : null,
        enabled_at: data.enabled ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);
    if (error) throw new Error(error.message);

    invalidateMaintenanceCache();

    // The worker holds its own copy so a freeze does not depend on the app
    // being reachable — which it may not be, since the app is often the thing
    // being deployed. Pushed after the database write so the two agree, and a
    // failure here is REPORTED rather than swallowed: a half-applied freeze
    // that blocks users while the worker keeps rendering is the worst of both.
    const pushed = await pushWorkerState(data.enabled, message, context.userId);

    const state = await readMaintenanceState();
    console.warn("[maintenance] toggled", {
      enabled: state.enabled,
      by: context.userId,
      workerSynced: pushed.ok,
      envOverride: state.envOverride,
      overridden: state.overridden,
    });

    return {
      ...state,
      workerSynced: pushed.ok,
      workerError: pushed.ok ? null : pushed.detail,
    };
  });
