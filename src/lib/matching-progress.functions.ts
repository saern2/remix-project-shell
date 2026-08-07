/**
 * Read-only progress counts for projects that are matching.
 *
 * Separate from the matching handler on purpose: it touches nothing the pipeline
 * writes, so surfacing progress cannot affect the thing being measured. The
 * dashboard needs these counts without polling the pipeline, and the project page
 * needs the same numbers the poll already reports so the two never disagree.
 *
 * Cheap by construction — four HEAD counts, no row bodies.
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

    const entries = await Promise.all(
      owned.map(async (project) => {
        const [scenes, selected, corpusTotal, corpusFilled, lastSelection, lastCorpusWrite] =
          await Promise.all([
            supabaseAdmin
              .from("scenes")
              .select("id", { count: "exact", head: true })
              .eq("project_id", project.id),
            supabaseAdmin
              .from("selected_clips")
              .select("scene_id, scenes!inner(project_id)", { count: "exact", head: true })
              .eq("scenes.project_id", project.id),
            supabaseAdmin
              .from("project_stock_corpus")
              .select("project_id", { count: "exact", head: true })
              .eq("project_id", project.id),
            // A bucket with candidates has been searched at least once. Close
            // enough for a progress bar, and it costs one count rather than
            // loading the corpus.
            supabaseAdmin
              .from("project_stock_corpus")
              .select("project_id", { count: "exact", head: true })
              .eq("project_id", project.id)
              .neq("candidates", "[]"),
            // Progress timestamps. projects.updated_at is useless here — every
            // poll touches it whether or not it did any work — so the signal comes
            // from the two tables that are only written when something advances.
            supabaseAdmin
              .from("selected_clips")
              .select("created_at, scenes!inner(project_id)")
              .eq("scenes.project_id", project.id)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
            supabaseAdmin
              .from("project_stock_corpus")
              .select("updated_at")
              .eq("project_id", project.id)
              .order("updated_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);

        const totalScenes = scenes.count ?? 0;
        const matched = selected.count ?? 0;
        const buckets = corpusTotal.count ?? 0;
        const built = corpusFilled.count ?? 0;

        // Corpus phase only while buckets exist and some are still empty.
        const cellsPending = buckets > 0 ? Math.max(0, buckets - built) : null;

        const progressAt = [lastSelection.data?.created_at, lastCorpusWrite.data?.updated_at]
          .filter((value): value is string => typeof value === "string")
          .map((value) => new Date(value).getTime())
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => b - a)[0];

        const counts: MatchingCounts = {
          // Null rather than a huge number when nothing has been written yet —
          // a project that has not started is not a paused one.
          msSinceProgress: progressAt == null ? null : Math.max(0, Date.now() - progressAt),
          corpusCellsPending: cellsPending,
          corpusCellsTotal: buckets > 0 ? buckets : null,
          totalScenes,
          scenesRemaining: Math.max(0, totalScenes - matched),
        };
        return [project.id, counts] as const;
      }),
    );

    return Object.fromEntries(entries);
  });
