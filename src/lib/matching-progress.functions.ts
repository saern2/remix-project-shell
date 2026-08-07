/**
 * Read-only progress counts for projects that are matching.
 *
 * Separate from the matching handler on purpose: it touches nothing the pipeline
 * writes, so surfacing progress cannot affect the thing being measured. The
 * dashboard needs these counts without polling the pipeline, and the project page
 * needs the same numbers the timeline shows so the two never disagree.
 *
 * The queries live in matching-counts.server.ts, shared with the pipeline's
 * lock-not-held response — one reader, one opinion about how done a project is.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MatchingCounts } from "@/lib/matching-progress";

export const getMatchingProgress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ projectIds: z.array(z.string().uuid()).max(20) }).parse(input),
  )
  .handler(async ({ data, context }): Promise<Record<string, MatchingCounts>> => {
    if (data.projectIds.length === 0) return {};
    const { supabase, userId } = context;

    // Ownership is checked before anything else is read: these ids come from the
    // client, and scene counts for someone else's project are not ours to give.
    const { data: owned, error } = await supabase
      .from("projects")
      .select("id, clip_duration_seconds")
      .in("id", data.projectIds)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    if (!owned || owned.length === 0) return {};

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { readProjectMatchingCounts } = await import("@/lib/matching-counts.server");

    const entries = await Promise.all(
      owned.map(
        async (project) =>
          [project.id, await readProjectMatchingCounts(supabaseAdmin, project)] as const,
      ),
    );

    return Object.fromEntries(entries);
  });
