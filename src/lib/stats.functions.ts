import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isCallerAdmin } from "@/lib/admin.functions";

/**
 * Everything the /stats page renders, in one call.
 *
 * All aggregation happens in `public.get_generation_stats`, not here. That is
 * not a preference: a day with no generations has to appear in the 30-day
 * chart as a zero-height bar rather than a gap, which needs a generate_series
 * left join, and PostgREST cannot express one. Reducing a bulk fetch in
 * JavaScript would also mean shipping every row a user has ever produced to
 * the browser to compute six numbers.
 *
 * SCOPE IS A PRIVILEGE, NOT A PARAMETER. The RPC is SECURITY DEFINER and
 * therefore sees every row regardless of RLS. It is granted to service_role
 * only, so this function is its sole caller — which makes the admin check here
 * the actual boundary. `platform` is refused for anyone who is not an
 * administrator, and `user` scope always passes the CALLER's own id rather
 * than an id from the request, so no input can widen what a user sees.
 */

const StatsInput = z.object({
  scope: z.enum(["user", "platform"]).default("user"),
  /**
   * IANA zone from the browser. "Today" is computed in it, so a user at 18:00
   * in UTC-7 does not see an empty day because the server has already rolled
   * over. An unrecognised zone falls back to UTC inside the RPC rather than
   * failing the page.
   */
  timeZone: z.string().max(64).optional(),
});

export type GenerationStats = {
  scope: "user" | "platform";
  timezone: string;
  today: { completed: number; total: number; seconds: number };
  previous_day: { completed: number; total: number; seconds: number };
  lifetime: { completed: number; total: number; seconds: number };
  /** Start of RECORDED history — null when there is nothing yet. */
  range_start: string | null;
  daily: Array<{ day: string; count: number }>;
  outcomes: Array<{ event_type: string; count: number }>;
  ranked: Array<{ label: string; count: number }>;
  recent: Array<{
    id: string;
    created_at: string;
    event_type: string;
    scene_count: number | null;
    audio_duration_seconds: number | null;
    /** Render job start to finish. Includes clip downloading, not just encoding. */
    render_duration_ms: number | null;
    backfilled: boolean;
    user_label: string | null;
  }>;
  active_now: number;
};

export const getGenerationStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => StatsInput.parse(input))
  .handler(async ({ data, context }): Promise<GenerationStats> => {
    const wantsPlatform = data.scope === "platform";
    if (wantsPlatform && !(await isCallerAdmin(context))) {
      throw new Error("Forbidden.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: stats, error } = await supabaseAdmin.rpc("get_generation_stats", {
      p_scope: wantsPlatform ? "platform" : "user",
      // Never from the request: user scope is always the caller's own history.
      p_user_id: wantsPlatform ? null : context.userId,
      p_tz: data.timeZone ?? "UTC",
    });
    if (error) {
      console.error("[stats] aggregation failed", {
        scope: data.scope,
        code: error.code,
        message: error.message,
      });
      throw new Error("Statistics could not be loaded.");
    }

    return stats as unknown as GenerationStats;
  });
