/**
 * The one place that reads matching progress out of the database.
 *
 * Both consumers go through here — the read-only progress endpoint the panel
 * polls, and the pipeline's lock-not-held response — because the 2026-08-07
 * incident was precisely two readers with two opinions: the progress panel
 * counted selected_clips (empty until a fixed-duration project's final flush)
 * while the timeline read render_clip_slices (558 rows and climbing). The
 * panel said "0 of 300 scenes, paused"; the timeline said 90% done; both were
 * on screen at once. A second reader implementation is how that happens again.
 *
 * Read-only by construction: nothing here writes, so surfacing progress cannot
 * affect the thing being measured.
 */
import {
  assembleMatchingCounts,
  expectedFixedSlicesForScenes,
  type MatchingCounts,
} from "@/lib/matching-progress";

type AdminClient = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

export async function readProjectMatchingCounts(
  supabaseAdmin: AdminClient,
  project: { id: string; clip_duration_seconds?: number | string | null },
): Promise<MatchingCounts> {
  let clipDuration = project.clip_duration_seconds;
  if (clipDuration === undefined) {
    // The caller may not have the project row (the pipeline's lock-not-held
    // path passes only the id). The mode decides which table progress comes
    // from, so guessing it would recreate the wrong-table bug this file exists
    // to prevent.
    const { data } = await supabaseAdmin
      .from("projects")
      .select("clip_duration_seconds")
      .eq("id", project.id)
      .maybeSingle();
    clipDuration = data?.clip_duration_seconds ?? null;
  }
  const fixedDuration = Number(clipDuration ?? 0);
  const sliceMode = Number.isFinite(fixedDuration) && fixedDuration > 0;

  const [scenes, selected, corpusTotal, corpusFilled, lastSelection, lastCorpusWrite] =
    await Promise.all([
      // Scene bodies only in slice mode, where the expected-slice arithmetic
      // needs start/end; otherwise a HEAD count is enough.
      sliceMode
        ? supabaseAdmin
            .from("scenes")
            .select("start_ts, end_ts", { count: "exact" })
            .eq("project_id", project.id)
            .order("idx", { ascending: true })
        : supabaseAdmin
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
      // A bucket with candidates has been searched at least once. Close enough
      // for a progress bar, and it costs one count rather than loading the corpus.
      supabaseAdmin
        .from("project_stock_corpus")
        .select("project_id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .neq("candidates", "[]"),
      // Progress timestamps. projects.updated_at is useless here — every poll
      // touches it whether or not it did any work — so the signal comes from
      // tables that are only written when something advances.
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

  // Slice-mode extras: the count the timeline shows, and the newest slice
  // write. This is the pair that was missing — for a fixed-duration project
  // these are where matching progress actually lands, and without them the
  // paused notice fired on a project that was writing a slice every second.
  let slicesFilled: number | null = null;
  let slicesExpected: number | null = null;
  let lastSliceWrite: string | null = null;
  if (sliceMode) {
    const [sliceCount, newestSlice] = await Promise.all([
      supabaseAdmin
        .from("render_clip_slices")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id),
      supabaseAdmin
        .from("render_clip_slices")
        .select("created_at")
        .eq("project_id", project.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    slicesFilled = sliceCount.count ?? 0;
    slicesExpected = expectedFixedSlicesForScenes(
      (scenes.data ?? []) as Array<{ start_ts: number; end_ts: number }>,
      fixedDuration,
    );
    lastSliceWrite = newestSlice.data?.created_at ?? null;
  }

  return assembleMatchingCounts({
    now: Date.now(),
    totalScenes: scenes.count ?? 0,
    matchedScenes: selected.count ?? 0,
    corpusBuckets: corpusTotal.count ?? 0,
    corpusBucketsFilled: corpusFilled.count ?? 0,
    slicesFilled,
    slicesExpected,
    lastProgressAt: [lastSelection.data?.created_at, lastCorpusWrite.data?.updated_at, lastSliceWrite],
  });
}
