import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden.");
}

/**
 * Guard: throws if the target user is the primary admin.
 * Called server-side before any reject/demote action regardless of who is calling.
 */
async function assertNotPrimaryAdmin(targetUserId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("is_primary_admin")
    .eq("id", targetUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.is_primary_admin) {
    throw new Error("Cannot modify the primary admin account.");
  }
}

/** Cheap self-check used by the UI-level route gate. */
export const amIAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (error) throw new Error(error.message);
    return { isAdmin: !!data };
  });

export const getAdminOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [usersRes, jobsRes, projectsRes, keysRes] = await Promise.all([
      supabaseAdmin.from("users").select("id, email, approval_status"),
      supabaseAdmin.from("render_jobs").select("id, status, project_id, created_at"),
      supabaseAdmin.from("projects").select("id, user_id"),
      supabaseAdmin
        .from("pexels_api_keys")
        .select("id, api_key, is_active, last_error, last_error_at")
        .order("last_error_at", { ascending: false, nullsFirst: false }),
    ]);
    for (const r of [usersRes, jobsRes, projectsRes, keysRes]) {
      if (r.error) throw new Error(r.error.message);
    }

    const users = usersRes.data ?? [];
    const jobs = jobsRes.data ?? [];
    const projects = projectsRes.data ?? [];
    const keys = keysRes.data ?? [];

    const usersByStatus = { pending: 0, approved: 0, rejected: 0 } as Record<string, number>;
    for (const u of users) usersByStatus[u.approval_status] = (usersByStatus[u.approval_status] ?? 0) + 1;

    const completed = jobs.filter((j) => j.status === "completed");

    // Renders per day, last 30 days.
    const days: { date: string; count: number }[] = [];
    const byDay = new Map<string, number>();
    for (const j of completed) {
      const d = String(j.created_at).slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: d, count: byDay.get(d) ?? 0 });
    }

    // Top 10 users by completed render count.
    const projectOwner = new Map(projects.map((p) => [p.id, p.user_id]));
    const perUser = new Map<string, number>();
    for (const j of completed) {
      const owner = projectOwner.get(j.project_id);
      if (!owner) continue;
      perUser.set(owner, (perUser.get(owner) ?? 0) + 1);
    }
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const topUsers = [...perUser.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ userId: id, email: emailById.get(id) ?? "(unknown)", count }));

    return {
      totalUsers: users.length,
      usersByStatus,
      totalCompletedRenders: completed.length,
      rendersPerDay: days,
      topUsers,
      keyPool: {
        total: keys.length,
        active: keys.filter((k) => k.is_active).length,
        withError: keys.filter((k) => k.last_error !== null).length,
        recentErrors: keys
          .filter((k) => k.last_error !== null)
          .slice(0, 5)
          .map((k) => ({
            id: k.id,
            masked: maskKey(k.api_key),
            last_error: k.last_error,
            last_error_at: k.last_error_at,
          })),
      },
    };
  });

function maskKey(key: string) {
  return `••••${key.slice(-4)}`;
}

export const listAdminUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [usersRes, jobsRes, projectsRes] = await Promise.all([
      supabaseAdmin
        .from("users")
        .select("id, email, role, approval_status, plan_tier, created_at, is_primary_admin")
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("render_jobs").select("id, status, project_id"),
      supabaseAdmin.from("projects").select("id, user_id"),
    ]);
    for (const r of [usersRes, jobsRes, projectsRes]) if (r.error) throw new Error(r.error.message);

    const projectOwner = new Map((projectsRes.data ?? []).map((p) => [p.id, p.user_id]));
    const perUser = new Map<string, number>();
    for (const j of jobsRes.data ?? []) {
      if (j.status !== "completed") continue;
      const owner = projectOwner.get(j.project_id);
      if (!owner) continue;
      perUser.set(owner, (perUser.get(owner) ?? 0) + 1);
    }

    return (usersRes.data ?? []).map((u) => ({ ...u, renderCount: perUser.get(u.id) ?? 0 }));
  });

/** Approve / reject a user. Never touches plan_tier. */
export const setUserApprovalStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        userId: z.string().uuid(),
        approvalStatus: z.enum(["pending", "approved", "rejected"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    // Self-action guard: no admin can reject their own account mid-session.
    if (data.userId === context.userId && data.approvalStatus === "rejected") {
      throw new Error("You cannot reject your own account.");
    }
    // Primary admin guard: the primary admin account cannot be rejected.
    if (data.approvalStatus === "rejected") {
      await assertNotPrimaryAdmin(data.userId);
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("users")
      .update({ approval_status: data.approvalStatus })
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Change plan tier only. Never touches approval_status. */
export const setUserPlanTier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ userId: z.string().uuid(), planTier: z.enum(["free", "pro", "business"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("users")
      .update({ plan_tier: data.planTier })
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ userId: z.string().uuid(), role: z.enum(["user", "admin"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    // Self-action guard: no admin can remove their own admin role mid-session.
    if (data.userId === context.userId && data.role === "user") {
      throw new Error("You cannot remove your own admin role.");
    }
    // Primary admin guard: the primary admin's role can never be changed.
    if (data.role === "user") {
      await assertNotPrimaryAdmin(data.userId);
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("users").update({ role: data.role }).eq("id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const listPexelsKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("pexels_api_keys")
      .select("id, api_key, is_active, request_count, last_used_at, last_error, last_error_at, added_at")
      .order("added_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((k) => ({ ...k, api_key: maskKey(k.api_key) }));
  });

export const deactivatePexelsKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("pexels_api_keys")
      .update({
        is_active: false,
        last_error: "Manually deactivated by admin",
        last_error_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

type UploadRow = {
  line: number;
  masked: string;
  status: "inserted" | "invalid" | "duplicate" | "error";
  detail?: string;
};

/**
 * Upload a CSV of Pexels keys (one key per line, or "key,note").
 * Each key gets ONE live test call against Pexels before insertion.
 */
export const uploadPexelsKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ csv: z.string().min(1).max(200_000) }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const rows = data.csv
      .split(/\r?\n/)
      .map((line, i) => ({ line: i + 1, raw: line.trim() }))
      .filter((r) => r.raw.length > 0)
      .map((r) => ({ line: r.line, key: r.raw.split(",")[0].trim().replace(/^["']|["']$/g, "") }))
      .filter((r) => r.key.length > 0 && r.key.toLowerCase() !== "api_key" && r.key.toLowerCase() !== "key");

    const results: UploadRow[] = [];

    for (const row of rows) {
      const masked = maskKey(row.key);
      // 1. Live test call.
      let ok = false;
      let detail = "";
      try {
        const res = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", {
          headers: { authorization: row.key },
        });
        ok = res.ok;
        if (!ok) detail = `Pexels responded HTTP ${res.status}`;
      } catch (e) {
        detail = e instanceof Error ? e.message : "Network error";
      }
      if (!ok) {
        results.push({ line: row.line, masked, status: "invalid", detail });
        continue;
      }

      // 2. Insert; unique constraint surfaces duplicates.
      const { error } = await supabaseAdmin
        .from("pexels_api_keys")
        .insert({ api_key: row.key, is_active: true });
      if (error) {
        if (error.code === "23505") {
          results.push({ line: row.line, masked, status: "duplicate", detail: "Key already in pool" });
        } else {
          results.push({ line: row.line, masked, status: "error", detail: error.message });
        }
        continue;
      }
      results.push({ line: row.line, masked, status: "inserted" });
    }

    return {
      total: rows.length,
      inserted: results.filter((r) => r.status === "inserted").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    };
  });
