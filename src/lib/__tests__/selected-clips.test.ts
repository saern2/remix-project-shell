import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fetchAllSelectedClips,
  SELECTED_CLIPS_PAGE_SIZE,
  SELECTED_CLIPS_SELECT,
  selectedClipsByScene,
  type SelectedClipRow,
  type SelectedClipsPage,
} from "@/lib/selected-clips";

function makeRow(n: number): SelectedClipRow {
  const sceneId = `scene-${String(n).padStart(6, "0")}`;
  return {
    scene_id: sceneId,
    in_point: n,
    out_point: n + 4,
    clip_candidates: {
      id: `cand-${n}`,
      url: `https://cdn.example/clip-${n}.mp4`,
      thumbnail_url: n % 3 === 0 ? null : `https://cdn.example/thumb-${n}.jpg`,
      duration_sec: 10 + (n % 7),
      provider: "pexels",
      provider_clip_id: `p-${n}`,
    },
    scenes: { project_id: "project-1" },
  };
}

/**
 * A fake page fetcher that serves `rows` in scene_id order the way the real
 * ordered query does, and records every range requested.
 */
function fakePager(rows: SelectedClipRow[], options: { failOnPage?: number } = {}) {
  const rangesRequested: Array<[number, number]> = [];
  const sorted = [...rows].sort((a, b) =>
    a.scene_id < b.scene_id ? -1 : a.scene_id > b.scene_id ? 1 : 0,
  );
  let call = 0;
  const fetchPage = (from: number, to: number): Promise<SelectedClipsPage> => {
    rangesRequested.push([from, to]);
    const page = call++;
    if (options.failOnPage === page) {
      return Promise.resolve({
        data: null,
        error: { message: "canceling statement due to statement timeout" },
      });
    }
    return Promise.resolve({ data: sorted.slice(from, to + 1) as unknown[], error: null });
  };
  return { fetchPage, rangesRequested };
}

describe("fetchAllSelectedClips", () => {
  it("fetches a sub-1000-row project in exactly one round trip", async () => {
    const rows = Array.from({ length: 612 }, (_, i) => makeRow(i));
    const { fetchPage, rangesRequested } = fakePager(rows);
    const result = await fetchAllSelectedClips(fetchPage);
    expect(result).toHaveLength(612);
    // One request, full-page range: the current workload (450-612 scenes) must
    // not pay a second round trip for future-proofing it does not yet need.
    expect(rangesRequested).toEqual([[0, SELECTED_CLIPS_PAGE_SIZE - 1]]);
  });

  it("stitches multiple pages without skips or duplicates past 1000 rows", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => makeRow(i));
    const { fetchPage, rangesRequested } = fakePager(rows);
    const result = await fetchAllSelectedClips(fetchPage);
    expect(result).toHaveLength(2345);
    expect(rangesRequested).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    const ids = result.map((row) => row.scene_id);
    expect(new Set(ids).size).toBe(2345); // no duplicates
    expect(ids).toEqual([...ids].sort()); // total order held across pages
  });

  it("an exact page-multiple result issues one trailing empty-page probe, never truncates", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => makeRow(i));
    const { fetchPage, rangesRequested } = fakePager(rows);
    const result = await fetchAllSelectedClips(fetchPage);
    expect(result).toHaveLength(2000);
    expect(rangesRequested).toHaveLength(3); // two full pages + the empty probe
  });

  it("throws on a page error instead of returning a partial timeline", async () => {
    // The partial-page-as-holes class: a timeline missing rows must never be
    // presented as complete.
    const rows = Array.from({ length: 1500 }, (_, i) => makeRow(i));
    const { fetchPage } = fakePager(rows, { failOnPage: 1 });
    await expect(fetchAllSelectedClips(fetchPage)).rejects.toMatchObject({
      message: expect.stringContaining("statement timeout"),
    });
  });
});

describe("selectedClipsByScene — the regression guard for this round", () => {
  it("derives a byte-identical timeline map from ordered rows and the old arbitrary order", () => {
    // The old query had no ORDER BY, so row order was plan-dependent. The
    // timeline is keyed by scene_id, so ordering the rows (which pagination
    // requires) must change NOTHING the timeline renders.
    const rows = Array.from({ length: 612 }, (_, i) => makeRow(i));
    // Deterministic reorderings, no RNG in tests: reversed, and odd-before-even.
    const reversed = [...rows].reverse();
    const interleaved = [
      ...rows.filter((_, i) => i % 2 === 1),
      ...rows.filter((_, i) => i % 2 === 0),
    ];
    const fromOrdered = selectedClipsByScene(rows);
    const fromReversed = selectedClipsByScene(reversed);
    const fromInterleaved = selectedClipsByScene(interleaved);

    const serialize = (map: Map<string, unknown>) =>
      JSON.stringify([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(serialize(fromReversed)).toBe(serialize(fromOrdered));
    expect(serialize(fromInterleaved)).toBe(serialize(fromOrdered));
  });

  it("carries exactly the fields the timeline reads: thumb, url, duration", () => {
    const map = selectedClipsByScene([makeRow(1)]);
    expect(map.get("scene-000001")).toEqual({
      thumb: "https://cdn.example/thumb-1.jpg",
      url: "https://cdn.example/clip-1.mp4",
      duration: 11,
    });
  });
});

describe("the query shape pins (B8: pagination only, no RLS change)", () => {
  it("keeps the exact select string the previous query used", () => {
    expect(SELECTED_CLIPS_SELECT).toBe(
      "scene_id, in_point, out_point, clip_candidates!inner(id, url, thumbnail_url, duration_sec, provider, provider_clip_id), scenes!inner(project_id)",
    );
  });

  it("pages at the server's max-rows boundary", () => {
    expect(SELECTED_CLIPS_PAGE_SIZE).toBe(1000);
  });

  it("the component's query is ordered, ranged, and uses the pinned select", () => {
    // The pagination rule is injected, so the query shape lives at the call
    // site. This pin keeps the two halves honest with each other: dropping
    // .order() or .range() there would silently reintroduce the arbitrary
    // 1000-row truncation this round removed.
    const source = readFileSync(
      join(process.cwd(), "src/routes/_authenticated/projects.$projectId.tsx"),
      "utf8",
    );
    expect(source).toContain("fetchAllSelectedClips((from, to) =>");
    expect(source).toContain(".select(SELECTED_CLIPS_SELECT)");
    expect(source).toContain('.order("scene_id", { ascending: true })');
    expect(source).toContain(".range(from, to)");
  });
});
