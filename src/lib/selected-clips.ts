/**
 * The timeline's selected-clips fetch, made deterministic and complete.
 *
 * THE TWO LIVE 500s, 2026-08-23 02:33:43 and 02:33:53: this exact query
 * (selected_clips with two !inner embeds, filtered on the embedded
 * scenes.project_id) died twice with 57014 "canceling statement due to
 * statement timeout" — PostgREST's 8s authenticator budget — during the
 * post-outage load. Raising statement_timeout for service_role is a proven
 * no-op (role settings apply at login; PostgREST SET ROLEs), so the query has
 * to get cheaper, not the budget bigger.
 *
 * What this changes and does not change:
 *
 *  - ORDER. The old query had no ORDER BY, so PostgREST's max-rows LIMIT 1000
 *    would truncate to an arbitrary, plan-dependent subset — silent timeline
 *    holes with no error. scene_id carries a UNIQUE constraint on
 *    selected_clips, so ordering by it is a total order and range pagination
 *    can neither skip nor duplicate rows across page boundaries.
 *
 *  - RANGE. Pages of 1000 (matching the server's max-rows) fetched until a
 *    short page. A sub-1000-row project — every project at the current
 *    450-612-scene workload — still costs exactly ONE round trip; the loop
 *    only continues when a page comes back full.
 *
 *  - NOT the RLS shape (Round A, B8). The policies that enumerate every scene
 *    the user owns are the deep cost driver, but restructuring them is a
 *    schema change and out of this round's scope.
 *
 * The page fetch itself is injected: the caller keeps the fully-typed Supabase
 * query (the generated client's select-string types do not survive being
 * funneled through a structural interface — TS2589), and this module owns the
 * pagination rule, which is the part that needs tests.
 */

/** Matches the server's max-rows so a full page is exactly "maybe more". */
export const SELECTED_CLIPS_PAGE_SIZE = 1000;

/** The exact column list the pre-pagination query used — pinned by test. */
export const SELECTED_CLIPS_SELECT =
  "scene_id, in_point, out_point, clip_candidates!inner(id, url, thumbnail_url, duration_sec, provider, provider_clip_id), scenes!inner(project_id)";

export type SelectedClipRow = {
  scene_id: string;
  in_point: number;
  out_point: number;
  clip_candidates: {
    id: string;
    url: string;
    thumbnail_url: string | null;
    duration_sec: number;
    provider: string;
    provider_clip_id: string;
  };
  scenes: { project_id: string };
};

/** One page of results, in the {data, error} shape every Supabase query returns. */
export type SelectedClipsPage = {
  data: unknown[] | null;
  error: { message: string } | null;
};

/**
 * Every selected clip for a project, across as many pages as it takes.
 *
 * `fetchPage(from, to)` must be the ordered, range-limited query — see the
 * call site in projects.$projectId.tsx, whose shape a source pin guards.
 * Throws on the first page error: a partial timeline must never be presented
 * as a complete one (the partial-page-as-holes class).
 */
export async function fetchAllSelectedClips(
  fetchPage: (from: number, to: number) => PromiseLike<SelectedClipsPage>,
  pageSize: number = SELECTED_CLIPS_PAGE_SIZE,
): Promise<SelectedClipRow[]> {
  const rows: SelectedClipRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    const pageRows = (data ?? []) as SelectedClipRow[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }
  return rows;
}

/**
 * The per-scene lookup the timeline actually renders from. Keyed by scene_id,
 * so the MAP is identical whatever order the rows arrived in — which is the
 * regression guarantee for this round: for sub-1000-row projects the derived
 * timeline is byte-identical to what the unordered single query produced.
 */
export function selectedClipsByScene(
  rows: SelectedClipRow[],
): Map<string, { thumb: string | null; url: string; duration: number }> {
  const map = new Map<string, { thumb: string | null; url: string; duration: number }>();
  for (const row of rows) {
    map.set(row.scene_id, {
      thumb: row.clip_candidates.thumbnail_url,
      url: row.clip_candidates.url,
      duration: Number(row.clip_candidates.duration_sec),
    });
  }
  return map;
}
