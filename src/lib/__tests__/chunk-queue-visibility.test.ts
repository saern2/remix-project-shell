/**
 * "Admitted" and "encoding" are different states, and only one means work is
 * happening.
 *
 * MEASURED 2026-08-09. A 49-chunk project displayed "Rendering, 0 of 49
 * segments" for 2,193 seconds — 36.5 minutes — because all four chunk workers
 * were busy with three older projects. The operator read it as a stall and
 * closed the tab. It had not stalled: it went on to render all 49 chunks in 24
 * minutes. Its sibling did the same for 2,044 seconds.
 *
 * That is the third distinct queue in this system to look like a hang — after
 * the admission queue and the stitch queue — so the rule is now explicit and
 * tested: every waiting state says it is waiting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { describeChunkPhase } from "../render-queue";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("what a waiting project is told", () => {
  it("says it is waiting, and how much is in front", () => {
    const text = describeChunkPhase("waiting", 37);
    expect(text).toMatch(/waiting for a render slot/i);
    expect(text).toContain("37 segments ahead");
    // Not "rendering", which is what it said for 36 minutes.
    expect(text).not.toMatch(/rendering/i);
  });

  it("labels the estimate when there is one", () => {
    const text = describeChunkPhase("waiting", 37, 20 * 60);
    expect(text).toContain("about 20 minutes");
    expect(text).toContain("(estimate)");
  });

  it("gives no estimate rather than a fabricated one", () => {
    const text = describeChunkPhase("waiting", 37, null);
    expect(text).toContain("37 segments ahead");
    expect(text).not.toContain("estimate");
  });

  it("gets the singular right", () => {
    expect(describeChunkPhase("waiting", 1)).toContain("1 segment ahead");
  });

  it("still says something true when the depth is unknown", () => {
    // The queue read is advisory and can fail. "Waiting" is still the honest
    // word; silence would leave the old impression of a stall.
    for (const ahead of [null, undefined, 0]) {
      const text = describeChunkPhase("waiting", ahead);
      expect(text, String(ahead)).toMatch(/waiting for a render slot/i);
      expect(text, String(ahead)).not.toContain("0 segments");
    }
  });
});

describe("it says nothing when there is nothing to explain", () => {
  it("is silent while a chunk is actually on a worker", () => {
    // A chunk encoding but not yet finished is genuinely rendering. Saying
    // "waiting" here would be a new lie in place of the old one.
    expect(describeChunkPhase("encoding", 12)).toBeNull();
  });

  it("is silent once chunks start completing", () => {
    // From then on the segment counter moves and speaks for itself.
    expect(describeChunkPhase(null, null)).toBeNull();
    expect(describeChunkPhase(undefined, undefined)).toBeNull();
  });

  it("degrades an unknown state to no notice, never a wrong one", () => {
    expect(describeChunkPhase("something-new", 5)).toBeNull();
  });
});

describe("the worker reports the state, and only while it matters", () => {
  const queue = read("render-worker/src/queue.js");
  const block = queue.slice(
    queue.indexOf("── Chunk visibility"),
    queue.indexOf("── Stitch visibility"),
  );

  it("distinguishes waiting from encoding by what is on a worker", () => {
    expect(block).toMatch(/activeChunks\.some\(isMine\)/);
    expect(block).toMatch(/chunk_state = 'encoding'/);
    expect(block).toMatch(/chunk_state = 'waiting'/);
  });

  it("counts queued-ahead AND already-running chunks", () => {
    // Both are genuinely in front. Counting only the queue would understate the
    // wait by exactly the number of workers.
    expect(block).toMatch(/priority.*<.*myBest/s);
    expect(block).toMatch(/activeChunks\.filter\(\(chunk\) => !isMine\(chunk\)\)\.length/);
  });

  it("only runs while nothing has completed", () => {
    // Two extra Redis reads per poll, confined to the window they explain, and
    // stopping the moment the first chunk lands.
    expect(block).toMatch(/\(result\.chunks_completed \?\? 0\) === 0/);
  });

  it("bounds the queue scan", () => {
    // A status poll every 3s must not pull an unbounded job list.
    expect(block).toMatch(/getPrioritized\(0, CHUNK_QUEUE_SCAN_LIMIT\)/);
  });

  it("is advisory — a failed queue read never fails the poll", () => {
    expect(block).toMatch(/catch \(err\)/);
    expect(block).toMatch(/Chunk queue depth unavailable/);
  });
});

describe("the state reaches the screen", () => {
  it("is validated, not trusted, on the way in", () => {
    // An unrecognised value from a mismatched worker version must degrade to
    // null rather than fail the UPDATE against the column's constraint.
    const render = read("src/lib/render.functions.ts");
    expect(render).toMatch(/const CHUNK_STATES = \[[^\]]*"waiting"[^\]]*"encoding"[^\]]*\]/s);
    expect(render).toMatch(/CHUNK_STATES\.includes\(payload\.chunk_state \?\? ""\)/);
    expect(render).toMatch(/chunkState === "waiting" && typeof payload\.chunks_ahead === "number"/);
  });

  it("is persisted and cleared on completion", () => {
    const render = read("src/lib/render.functions.ts");
    expect(render).toMatch(/chunk_state: chunkState/);
    expect(render).toMatch(/jobUpdate\.chunk_state = null/);
  });

  it("is selected by the page and rendered ahead of the generic fallback", () => {
    const page = read("src/routes/_authenticated/projects.$projectId.tsx");
    expect(page).toMatch(/chunk_state, chunks_ahead/);
    // Most specific first: stitch phase, then chunk phase, then the generic
    // "Rendering video…" that was the only thing a waiting project ever said.
    const stitchAt = page.indexOf("describeStitchPhase(renderJob.stitch_state");
    const chunkAt = page.indexOf("describeChunkPhase(");
    // lastIndexOf, because the comment above the code quotes the same string
    // and indexOf would match the prose rather than the fallback.
    const genericAt = page.lastIndexOf('"Rendering video…"');
    expect(stitchAt).toBeGreaterThan(-1);
    expect(chunkAt).toBeGreaterThan(stitchAt);
    expect(genericAt).toBeGreaterThan(chunkAt);
  });

  it("is registered in catch-up.sql and the boot schema check", () => {
    expect(read("supabase/catch-up.sql")).toMatch(/add column if not exists chunk_state text/);
    expect(read("src/lib/schema-check.server.ts")).toMatch(/"chunk_state"/);
  });
});
