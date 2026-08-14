/**
 * Batching changes how assignments are PERSISTED, never what is chosen.
 *
 * Measured on a 286-scene production run: dbWriteMs 40,970-55,408 per
 * invocation against elapsedMs ~11,000, with providerSearchMs 0 and
 * assignmentMs 0. Assignment was pure write latency — three sequential round
 * trips per scene at ~3s each. Batching turns 45 round trips per slice into 3.
 *
 * The reference implementation below is the per-scene code this replaced,
 * transcribed exactly. Every test compares the batched output against it: same
 * inputs, byte-identical rows. That is the whole safety argument — if these
 * agree, no scene can end up with a different clip, a different in-point, or a
 * different out-point than it had before.
 */
import { describe, expect, it } from "vitest";

import {
  buildCandidateRows,
  buildSelectionRows,
  chunked,
  IN_FILTER_CHUNK_SIZE,
  type SliceAssignment,
} from "../pipeline.functions";

/** Exactly what processScene wrote, per scene, before batching. */
function referencePerSceneRows(assignments: SliceAssignment[], candidateId: (i: number) => string) {
  const candidates: unknown[] = [];
  const selections: unknown[] = [];
  assignments.forEach((a, i) => {
    candidates.push({
      scene_id: a.sceneId,
      provider: a.provider,
      provider_clip_id: a.providerClipId,
      url: a.url,
      fallback_urls: a.fallbackUrls,
      thumbnail_url: a.thumbnailUrl,
      width: a.width,
      height: a.height,
      duration_sec: a.sourceDurationSec,
    });
    selections.push({
      scene_id: a.sceneId,
      clip_candidate_id: candidateId(i),
      in_point: a.inPoint,
      out_point: a.inPoint + Math.max(a.visualDurationSec, 1),
    });
  });
  return { candidates, selections };
}

function assignment(i: number, overrides: Partial<SliceAssignment> = {}): SliceAssignment {
  return {
    sceneId: `scene-${i}`,
    visualDurationSec: 4 + (i % 3),
    provider: i % 2 === 0 ? "pexels" : "pixabay",
    providerClipId: `clip-${i}`,
    url: `https://cdn.test/${i}.mp4`,
    fallbackUrls: [`https://cdn.test/${i}_sd.mp4`],
    thumbnailUrl: `https://cdn.test/${i}.jpg`,
    width: 1920,
    height: 1080,
    sourceDurationSec: 20 + i,
    inPoint: i * 4,
    ...overrides,
  };
}

describe("batched rows are identical to the per-scene rows", () => {
  const assignments = Array.from({ length: 15 }, (_, i) => assignment(i));
  const idFor = (i: number) => `cand-${i}`;
  const idMap = new Map(assignments.map((a, i) => [a.sceneId, idFor(i)]));

  it("writes the same candidate rows, in the same order", () => {
    const reference = referencePerSceneRows(assignments, idFor);
    expect(buildCandidateRows(assignments)).toEqual(reference.candidates);
  });

  it("writes the same selection rows, in the same order", () => {
    const reference = referencePerSceneRows(assignments, idFor);
    expect(buildSelectionRows(assignments, idMap)).toEqual(reference.selections);
  });

  it("produces an identical (scene_id, provider_clip_id, in_point) set", () => {
    // The tuple the operator asked to compare before and after.
    const batched = buildCandidateRows(assignments).map((row, i) => ({
      scene_id: row.scene_id,
      provider_clip_id: row.provider_clip_id,
      in_point: buildSelectionRows(assignments, idMap)[i].in_point,
    }));
    const reference = referencePerSceneRows(assignments, idFor);
    const referenceTuples = reference.candidates.map((row, i) => ({
      scene_id: (row as { scene_id: string }).scene_id,
      provider_clip_id: (row as { provider_clip_id: string }).provider_clip_id,
      in_point: (reference.selections[i] as { in_point: number }).in_point,
    }));
    expect(batched).toEqual(referenceTuples);
  });
});

describe("the candidate-to-scene mapping", () => {
  it("pairs each scene with ITS OWN candidate, whatever order they come back in", () => {
    // The one bug batching can introduce that nothing downstream would catch:
    // a scene paired with another scene's clip. PostgREST does not promise the
    // returned order, so the mapping goes by scene_id, never by index.
    const assignments = [assignment(0), assignment(1), assignment(2)];
    const shuffled = new Map([
      ["scene-2", "cand-2"],
      ["scene-0", "cand-0"],
      ["scene-1", "cand-1"],
    ]);
    const rows = buildSelectionRows(assignments, shuffled);
    expect(rows.map((r) => [r.scene_id, r.clip_candidate_id])).toEqual([
      ["scene-0", "cand-0"],
      ["scene-1", "cand-1"],
      ["scene-2", "cand-2"],
    ]);
  });

  it("drops a selection rather than guessing when a candidate is missing", () => {
    // persistSlice turns a short result into a thrown error; the builder's job
    // is only to never invent a pairing.
    const assignments = [assignment(0), assignment(1)];
    const partial = new Map([["scene-0", "cand-0"]]);
    expect(buildSelectionRows(assignments, partial)).toHaveLength(1);
  });
});

describe("out_point arithmetic is unchanged", () => {
  it("floors the visual duration at one second", () => {
    // Math.max(visualDuration, 1) — a zero-length scene must not produce
    // out_point === in_point.
    const rows = buildSelectionRows(
      [assignment(0, { visualDurationSec: 0, inPoint: 12 })],
      new Map([["scene-0", "cand-0"]]),
    );
    expect(rows[0].out_point).toBe(13);
  });

  it("adds the duration to the in-point exactly", () => {
    const rows = buildSelectionRows(
      [assignment(0, { visualDurationSec: 6.5, inPoint: 3.25 })],
      new Map([["scene-0", "cand-0"]]),
    );
    expect(rows[0].out_point).toBe(9.75);
  });
});

describe("empty slices write nothing", () => {
  it("builds no rows at all", () => {
    expect(buildCandidateRows([])).toEqual([]);
    expect(buildSelectionRows([], new Map())).toEqual([]);
  });
});

/**
 * MATCHING_SLICE_SIZE goes 5 -> 25 (round A, Q2). Nothing in the write path
 * changes; the slice simply carries five times the rows.
 *
 * MEASURED 2026-08-14: 356 scenes at slice 5 issued 216 statements and 67.3s of
 * dbWriteMs — exactly three statements per slice, at ~311ms each, dominated by
 * round-trip latency rather than payload. At 25 that is 15 slices and 45
 * statements. The 8s authenticator timeout is nowhere near binding: 25 rows is
 * ~25-50 kB, against a 3.9 MB read that measured ~30ms server-side.
 */
describe("a 25-scene slice is still three statements and still byte-identical", () => {
  const assignments = Array.from({ length: 25 }, (_, i) => assignment(i));
  const idMap = new Map(assignments.map((a, i) => [a.sceneId, `cand-${i}`]));

  it("writes exactly what the per-scene reference would have written", () => {
    const reference = referencePerSceneRows(assignments, (i) => `cand-${i}`);
    expect(buildCandidateRows(assignments)).toEqual(reference.candidates);
    expect(buildSelectionRows(assignments, idMap)).toEqual(reference.selections);
  });

  it("keeps the failed-scene update in a single .in() chunk", () => {
    // This is what holds the three-statement pattern. Above IN_FILTER_CHUNK_SIZE
    // the update splits and a slice costs more than three statements — so 100 is
    // the ceiling on any future slice size, not 25.
    const sceneIds = assignments.map((a) => a.sceneId);
    expect(chunked(sceneIds)).toHaveLength(1);
    expect(25).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
  });
});

describe("the .in() chunker", () => {
  it("keeps a 600-scene id list under the request-line limit", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `${i}`.padStart(36, "0"));
    const batches = chunked(ids);
    expect(batches).toHaveLength(6);
    // 100 UUIDs at 37 chars is well under 4 KB; 600 would be ~22 KB.
    for (const batch of batches) {
      expect(batch.join(",").length).toBeLessThan(4096);
    }
  });

  it("loses nothing and preserves order", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    expect(chunked(ids).flat()).toEqual(ids);
  });

  it("handles the edges", () => {
    expect(chunked([])).toEqual([]);
    expect(chunked(["a"])).toEqual([["a"]]);
    expect(chunked(Array.from({ length: IN_FILTER_CHUNK_SIZE }, (_, i) => i))).toHaveLength(1);
    expect(chunked(Array.from({ length: IN_FILTER_CHUNK_SIZE + 1 }, (_, i) => i))).toHaveLength(2);
  });
});
