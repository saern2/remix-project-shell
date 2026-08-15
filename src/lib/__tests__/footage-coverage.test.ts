/**
 * A timeline with holes must never offer a render, must say why — and must
 * never be fooled into seeing holes that are not there.
 *
 * Two incidents, one gate:
 *
 *   2026-08-14: a 356-scene project completed `ready` with scenes the UI drew
 *   as "No clip" while the Final video panel said "Everything looks good" and
 *   Render was offered. The gate was built to close on holes.
 *
 *   2026-08-15: the same project turned out to be COMPLETE — the "holes" were
 *   a mid-flight snapshot. The row query's 3s interval stops the instant the
 *   status leaves matching_footage, so the 350-of-356 page it was holding
 *   outlived the transition, and the gate's first version would block Render
 *   on a whole project. Rows can also truncate at PostgREST's max-rows cap
 *   (~1000, non-deterministic order) — so rows can never prove completeness.
 *
 * Hence the invariant pinned here: the gate judges from two exact server-side
 * counts and nothing else. A partial page never closes it; only a genuine
 * count deficit does.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_SCENE_CARD_HINT,
  EMPTY_SCENE_CARD_NOTICE,
  describeFootageCoverage,
  describeMissingFootage,
} from "../footage-coverage";

describe("the render gate closes only on a genuine count deficit", () => {
  it("blocks with the exact 2026-08-14 shape: 350 of 356 scenes covered", () => {
    const coverage = describeFootageCoverage({
      counts: { totalScenes: 356, scenesWithClips: 350 },
    });
    expect(coverage.complete).toBe(false);
    expect(coverage.missingScenes).toBe(6);
    expect(coverage.totalScenes).toBe(356);
    expect(coverage.notice).toContain("6 scenes");
    expect(coverage.notice).toContain("356");
  });

  it("THE 2026-08-15 PIN: a partial row page never closes the gate", () => {
    // The row query held 350 of 356 rows when the project went ready. The gate
    // takes counts, not rows — so the only way to reproduce that failure would
    // be for the SERVER's aggregate to be wrong, which a head-only count
    // cannot be. Equal counts read complete, whatever any row page holds.
    const coverage = describeFootageCoverage({
      counts: { totalScenes: 356, scenesWithClips: 356 },
    });
    expect(coverage).toMatchObject({ complete: true, missingScenes: 0, notice: null });
  });

  it("blocks on a single missing scene", () => {
    const coverage = describeFootageCoverage({
      counts: { totalScenes: 10, scenesWithClips: 9 },
    });
    expect(coverage.missingScenes).toBe(1);
    expect(coverage.notice).toContain("1 scene");
  });

  it("clamps rather than reporting negative holes if a scene vanishes between counts", () => {
    const coverage = describeFootageCoverage({
      counts: { totalScenes: 5, scenesWithClips: 6 },
    });
    expect(coverage).toMatchObject({ complete: true, missingScenes: 0 });
  });
});

describe("not loaded is not missing", () => {
  // Before the counts resolve, nothing is known. Blocking on that would hide
  // the Render button on every fresh page load of a healthy project — a
  // silence of the opposite kind.
  it("does not block while the counts are still loading", () => {
    expect(describeFootageCoverage({ counts: undefined })).toMatchObject({
      complete: true,
      notice: null,
    });
    expect(describeFootageCoverage({ counts: null })).toMatchObject({
      complete: true,
      notice: null,
    });
  });

  it("does not block a project with no scenes at all", () => {
    expect(
      describeFootageCoverage({ counts: { totalScenes: 0, scenesWithClips: 0 } }),
    ).toMatchObject({ complete: true });
  });
});

describe("fixed-duration projects are judged by their own table", () => {
  // Their timeline is render_clip_slices, not selected_clips; a fixed-duration
  // project legitimately has no selected_clips rows at all, so applying this
  // check there would block every render of a working feature.
  it("reports complete even with zero selections", () => {
    const coverage = describeFootageCoverage({
      counts: { totalScenes: 40, scenesWithClips: 0 },
      fixedDurationSeconds: 5,
    });
    expect(coverage).toMatchObject({ complete: true, missingScenes: 0, notice: null });
  });
});

describe("the wording is usable by someone who did not read the logs", () => {
  it("leads with the count and names the action that works", () => {
    const notice = describeMissingFootage(6, 356);
    expect(notice).toContain("6 scenes");
    expect(notice).toContain("Swap");
    // Never points at the page's other retry: it resets the project to draft,
    // deleting the scenes that DID match.
    expect(notice).not.toMatch(/retry matching/i);
  });

  it("uses singular language for a single scene", () => {
    const notice = describeMissingFootage(1, 356);
    expect(notice).toContain("1 scene");
    expect(notice).not.toContain("1 scenes");
    expect(notice).not.toContain("those scenes");
  });

  it("explains the empty card without jargon", () => {
    expect(EMPTY_SCENE_CARD_NOTICE).not.toMatch(/null|undefined|clip_candidates|selected_clips/);
    expect(EMPTY_SCENE_CARD_HINT).toContain("Swap");
  });
});

/**
 * The gate is only useful if the page is actually wired to it — and wired to
 * the RIGHT data source. Pinned from source.
 */
describe("the page is wired to the gate, and the gate to counts", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  const source = readFileSync(
    resolve(process.cwd(), "src/routes/_authenticated/projects.$projectId.tsx"),
    "utf8",
  );

  it("gates the Render button on complete footage", () => {
    const gate = source.slice(
      source.indexOf("const canSubmitRender ="),
      source.indexOf("const handleRender"),
    );
    expect(gate).toContain("footageCoverage.complete");
  });

  it("derives coverage from head-only exact counts, never from the row queries", () => {
    // The 2026-08-15 regression in wiring form: coverage judged from
    // clipsQuery's rows reads a partial page as holes. The call site must
    // consume the counts query and must not touch the row-derived structures.
    const callSite = source.slice(
      source.indexOf("const coverageQuery = useQuery({"),
      source.indexOf("const runSwap"),
    );
    expect(callSite).toContain('queryKey: ["footage-coverage", projectId, project?.status]');
    expect(callSite.match(/count: "exact", head: true/g)?.length).toBe(2);
    expect(callSite).toContain("counts: coverageQuery.data");
    expect(callSite).not.toContain("clipsByScene");
    expect(callSite).not.toContain("clipsQuery");
  });

  it("re-counts after a swap, so filling a hole reopens the gate", () => {
    const swap = source.slice(
      source.indexOf("const handleSwap"),
      source.indexOf("// ---- Delete project ----"),
    );
    expect(swap).toContain('invalidateQueries({ queryKey: ["footage-coverage", projectId] })');
  });

  it("refetches the timeline rows on the matching_footage -> ready transition", () => {
    // The stale-display half of the incident: the row queries' 3s interval
    // stops at the transition, so without this the final slice's clips are
    // systematically missing from the page left on screen.
    const effect = source.slice(
      source.indexOf("const prevStatusRef"),
      source.indexOf("const scenesQuery"),
    );
    expect(effect).toContain('prev === "matching_footage"');
    expect(effect).toContain('invalidateQueries({ queryKey: ["selected-clips", projectId] })');
    expect(effect).toContain('invalidateQueries({ queryKey: ["scenes", projectId] })');
  });

  it("no longer renders a bare 'No clip'", () => {
    // The JSX form specifically — the phrase still appears in the comments that
    // explain why it went away, and pinning the bare string would match those.
    expect(source).not.toMatch(/:\s*"No clip"\}/);
    expect(source).toContain("EMPTY_SCENE_CARD_NOTICE");
  });

  it("offers Swap on empty cards, which is the only per-scene way out", () => {
    // Previously `clip && isReady`: the one card that needed the button was the
    // one card that never showed it.
    expect(source).not.toContain("{clip && isReady ? (");
  });
});
