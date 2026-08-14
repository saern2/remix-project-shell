/**
 * A timeline with holes must never offer a render, and must say why.
 *
 * The bug: a 356-scene project completed `ready` with six scenes that had no
 * selected_clips row. The timeline drew them as a bare "No clip", the Final
 * video panel said "Everything looks good", and clicking Render failed
 * server-side naming a single scene. Every one of those is a separate silence;
 * this pins all of them shut.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_SCENE_CARD_HINT,
  EMPTY_SCENE_CARD_NOTICE,
  describeFootageCoverage,
  describeMissingFootage,
} from "../footage-coverage";

const scenes = (count: number) => Array.from({ length: count }, (_, i) => `scene-${i}`);

describe("the render gate closes on evidence of holes", () => {
  it("reports the exact production shape: 350 of 356", () => {
    // Capture 64: the six missing scenes were the tail, idx 350-355.
    const all = scenes(356);
    const coverage = describeFootageCoverage({
      sceneIds: all,
      sceneIdsWithClips: all.slice(0, 350),
    });
    expect(coverage.complete).toBe(false);
    expect(coverage.missingScenes).toBe(6);
    expect(coverage.totalScenes).toBe(356);
    expect(coverage.notice).toContain("6 scenes");
    expect(coverage.notice).toContain("356");
  });

  it("stays open when every scene has a clip", () => {
    const all = scenes(356);
    const coverage = describeFootageCoverage({ sceneIds: all, sceneIdsWithClips: all });
    expect(coverage).toMatchObject({ complete: true, missingScenes: 0, notice: null });
  });

  it("counts a hole wherever it falls, not only at the tail", () => {
    const all = scenes(10);
    const coverage = describeFootageCoverage({
      sceneIds: all,
      sceneIdsWithClips: all.filter((id) => id !== "scene-4"),
    });
    expect(coverage.missingScenes).toBe(1);
    expect(coverage.notice).toContain("1 scene");
  });
});

describe("not loaded is not missing", () => {
  // Before the clips query resolves every scene looks clipless. Blocking on
  // that would hide the Render button on every fresh page load of a healthy
  // project — a silence of the opposite kind.
  it("does not block while the clip list is still loading", () => {
    const coverage = describeFootageCoverage({
      sceneIds: scenes(356),
      sceneIdsWithClips: null,
    });
    expect(coverage).toMatchObject({ complete: true, notice: null });
  });

  it("does not block while the scene list is still loading", () => {
    expect(describeFootageCoverage({ sceneIds: null, sceneIdsWithClips: [] })).toMatchObject({
      complete: true,
      notice: null,
    });
  });

  it("does not block a project with no scenes at all", () => {
    expect(describeFootageCoverage({ sceneIds: [], sceneIdsWithClips: [] })).toMatchObject({
      complete: true,
    });
  });
});

describe("fixed-duration projects are judged by their own table", () => {
  // Their timeline is render_clip_slices, not selected_clips; a fixed-duration
  // project legitimately has no selected_clips rows at all, so applying this
  // check there would block every render of a working feature.
  it("reports complete even with zero selections", () => {
    const coverage = describeFootageCoverage({
      sceneIds: scenes(40),
      sceneIdsWithClips: [],
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
    // deleting the 350 scenes that DID match.
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
 * The gate is only useful if the button is actually wired to it. Pinned from
 * source: canSubmitRender must depend on footageCoverage.complete, and the
 * timeline's empty state must use the explanatory card rather than "No clip".
 */
describe("the page is wired to the gate", () => {
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
