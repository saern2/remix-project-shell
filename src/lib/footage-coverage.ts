/**
 * Whether every scene actually has footage, and what to tell the user when it
 * does not.
 *
 * WHY THIS EXISTS. Matching deliberately tolerates a few unmatched scenes: it
 * fails the project only once they pass unmatchedSceneFailureThreshold (10%),
 * because failing 356 scenes over 6 is the wrong trade. That decision is right,
 * and it was also completely invisible — the project went to `ready`, the
 * timeline showed a bare "No clip" card, and the Final video panel said
 * "Everything looks good. Click Render video" over the holes. Clicking it then
 * failed server-side with the name of ONE scene, which is the worst possible
 * order to learn it in. So the tolerance stays and the silence goes: a hole is
 * stated on the card in plain language, and the render gate names the count.
 *
 * WHY COUNTS, NOT ROWS. The first version of this gate judged coverage from
 * the timeline's own selected_clips rows, and that input can lie in two ways:
 *
 *   MID-FLIGHT. The row query polls on a 3-second interval WHILE matching and
 *   stops the instant the status leaves matching_footage — so the final
 *   assignment slice, which lands moments before that transition, is
 *   systematically absent from the page the query is left holding. On
 *   2026-08-15 a complete 356-scene project read as 6 holes because the last
 *   snapshot predated the last slice: the gate blocked Render and told the
 *   user 6 scenes had no footage, on data that was whole in the database.
 *
 *   AT SCALE. The row query has no .range() and no .order(), so past
 *   PostgREST's max-rows cap (1000 by default — a limit the scene skeleton
 *   read already guards against server-side) it returns a partial,
 *   NON-DETERMINISTIC page on every fetch. Rows can never prove completeness;
 *   a bigger fetch only moves the tripwire.
 *
 * Two head-only exact counts have neither failure mode: they transfer zero
 * rows, are aggregated server-side, and cannot be truncated. The caller
 * fetches them under a queryKey that includes project.status, so the ready
 * transition itself forces fresh numbers and a mid-matching snapshot cannot
 * be carried across the boundary.
 *
 * SCOPE. Selections (`selected_clips`) are the timeline's source of truth only
 * on the PLAIN path. A fixed-duration project renders from `render_clip_slices`
 * instead, and its completeness is already checked separately — so coverage
 * reports "complete" there rather than second-guessing a different model with
 * the wrong table.
 *
 * NOT LOADED IS NOT MISSING. Before the counts resolve, nothing is known.
 * Blocking on that would hide the button on every fresh page load, so an
 * unloaded state is never a hole: the gate only closes on evidence.
 */

/** The two aggregates the gate is allowed to judge from. */
export type FootageCoverageCounts = {
  /** Exact server-side count of the project's scenes. */
  totalScenes: number;
  /** Exact server-side count of its selected_clips rows (one per scene). */
  scenesWithClips: number;
};

export type FootageCoverage = {
  /** Scenes with no usable clip. 0 when unknown — absence of evidence only. */
  missingScenes: number;
  totalScenes: number;
  /** False only when scenes are provably missing footage. */
  complete: boolean;
  /** One plain sentence naming the count, or null when there is nothing wrong. */
  notice: string | null;
};

const COMPLETE: FootageCoverage = {
  missingScenes: 0,
  totalScenes: 0,
  complete: true,
  notice: null,
};

export function describeFootageCoverage(opts: {
  /** Server-side aggregates, or null/undefined while they are loading. */
  counts: FootageCoverageCounts | null | undefined;
  /**
   * Set for fixed-duration projects, whose timeline comes from
   * render_clip_slices rather than selected_clips.
   */
  fixedDurationSeconds?: number | null;
}): FootageCoverage {
  if (opts.fixedDurationSeconds) return COMPLETE;
  if (!opts.counts) return COMPLETE;
  const { totalScenes, scenesWithClips } = opts.counts;
  if (totalScenes === 0) return COMPLETE;

  // scenes is the authoritative side; selected_clips is unique per scene_id, so
  // the difference is exactly the clipless scenes. Clamped because a scene
  // deleted between the two counts must not read as negative holes.
  const missingScenes = Math.max(0, totalScenes - scenesWithClips);
  if (missingScenes === 0) return { missingScenes: 0, totalScenes, complete: true, notice: null };

  return {
    missingScenes,
    totalScenes,
    complete: false,
    notice: describeMissingFootage(missingScenes, totalScenes),
  };
}

/**
 * The sentence the user reads instead of a silent gap.
 *
 * States the count first, says what it means for the video, and names the one
 * action that actually works. No apology, no jargon, no scene ids: the timeline
 * above already marks which cards are empty.
 *
 * It points at Swap rather than at a re-match on purpose. Swap runs a fresh
 * provider search for the one scene, independent of the stored corpus, so it can
 * find footage the corpus never held. The page's other retry resets the project
 * to `draft`, which deletes every scene and clears the corpus — throwing away
 * the clips that DID match to chase the few that did not.
 */
export function describeMissingFootage(missingScenes: number, totalScenes: number): string {
  const subject = missingScenes === 1 ? "1 scene of" : `${missingScenes} scenes of`;
  const pronoun = missingScenes === 1 ? "it" : "them";
  return (
    `Matching finished, but ${subject} ${totalScenes} found no usable clip. Rendering is blocked ` +
    `because ${pronoun === "it" ? "that scene" : "those scenes"} would be missing footage in the ` +
    `finished video. Use Swap on the empty cards above to search again for just ${pronoun}.`
  );
}

/** What a single empty timeline card says, in place of a bare "No clip". */
export const EMPTY_SCENE_CARD_NOTICE = "No footage found";
export const EMPTY_SCENE_CARD_HINT = "Nothing matched this scene. Use Swap to search again.";
