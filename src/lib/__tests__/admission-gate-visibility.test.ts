/**
 * A chunk held at an admission gate must say so.
 *
 * MEASURED 2026-08-13, project a1a7c67e / render job 54b899a3, 46 scenes,
 * 4 chunks. From the HAR, only the polls where something changed:
 *
 *   19:26:17  rendering, 0%, 0/4, chunk_state "waiting", chunks_ahead 0
 *   19:31:35  rendering, 0%, 0/4, chunk_state "encoding"
 *   19:32:40  rendering, 34%, 3/4
 *   19:32:55  completed
 *
 * 318 seconds — 80% of a 6m39s render — displayed as 0% with the word
 * "waiting" and ZERO segments ahead. Zero ahead is a measurement, and it says
 * nothing is in the way, so the only honest reading of that screen was
 * "stuck". The render then finished in 80 seconds.
 *
 * The cause is structural: a gated chunk is moved to DELAYED, and a delayed
 * job is in neither getActive() nor getPrioritized() — the two queries the
 * status poll runs. The project vanished from both, so the poll described an
 * empty queue rather than a held one.
 *
 * WHAT IS AND IS NOT PROVEN. The deferral pattern itself is proven: worker
 * logs show "Chunk deferred: project is queued for an admission slot",
 * position 1..7 against limit 3. Those logs cover 15:36-15:37 UTC and this
 * render ran 19:26-19:32 UTC, so which gate held THIS job is UNVERIFIED. The
 * same logs also settle what it was not: "Render phase split" reports
 * downloadMs of 1,241-8,870 and downloadSharePct of 2-12%, so downloading is
 * not the missing five minutes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { describeChunkPhase } from "../render-queue";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("what a gated project is told", () => {
  it("names its place in the queue instead of claiming nothing is ahead", () => {
    const text = describeChunkPhase("waiting-slot", null, null, 3);
    expect(text).toMatch(/waiting for a render slot/i);
    expect(text).toContain("3rd in the queue");
    // The two things the old screen said, both of which read as stuck.
    expect(text).not.toContain("0 segments");
    expect(text).not.toMatch(/^Rendering/);
  });

  it("uses ordinals, because a bare number reads like an error code", () => {
    expect(describeChunkPhase("waiting-slot", null, null, 1)).toContain("1st in the queue");
    expect(describeChunkPhase("waiting-slot", null, null, 2)).toContain("2nd in the queue");
    expect(describeChunkPhase("waiting-slot", null, null, 7)).toContain("7th in the queue");
    // The English exceptions, which an off-the-cuff implementation gets wrong.
    expect(describeChunkPhase("waiting-slot", null, null, 11)).toContain("11th");
    expect(describeChunkPhase("waiting-slot", null, null, 12)).toContain("12th");
    expect(describeChunkPhase("waiting-slot", null, null, 13)).toContain("13th");
    expect(describeChunkPhase("waiting-slot", null, null, 21)).toContain("21st");
  });

  it("still says the place is held when no position is known", () => {
    // The position comes from an advisory snapshot that can be unavailable.
    // Saying nothing would restore the blank screen this exists to remove.
    for (const position of [null, undefined, 0]) {
      const text = describeChunkPhase("waiting-slot", null, null, position);
      expect(text, String(position)).toMatch(/waiting for a render slot/i);
      expect(text, String(position)).toMatch(/starts automatically/i);
      expect(text, String(position)).not.toMatch(/\b0(st|nd|rd|th)\b/);
    }
  });

  it("labels an estimate as an estimate, and omits it rather than inventing one", () => {
    const text = describeChunkPhase("waiting-slot", null, 20 * 60, 3);
    expect(text).toContain("(estimate)");
    expect(text).toContain("about 20 minutes");
    // describeWait already supplies "about"; a second one here read as
    // "about about 20 minutes".
    expect(text).not.toMatch(/about about/);
    expect(describeChunkPhase("waiting-slot", null, null, 3)).not.toContain("estimate");
  });

  it("explains a memory hold without inventing a number for it", () => {
    const text = describeChunkPhase("waiting-memory", null, null, null);
    expect(text).toMatch(/memory/i);
    expect(text).toMatch(/starts automatically/i);
    // How long depends on other projects releasing memory. Any figure would be
    // fabricated, and a fabricated ETA is worse than none.
    expect(text).not.toMatch(/estimate|minute|second/i);
  });

  it("still goes quiet once a chunk is genuinely on a worker", () => {
    expect(describeChunkPhase("encoding", null, null, 3)).toBeNull();
  });
});

describe("the worker publishes the reason through the channel that already exists", () => {
  const renderJob = read("render-worker/src/renderJob.js");

  it("announces a slot deferral, not only to the log", () => {
    const gate = renderJob.slice(
      renderJob.indexOf("async function gateOnAdmission"),
      renderJob.indexOf("async function deferChunk"),
    );
    expect(gate).toMatch(/state: 'waiting-slot'/);
    expect(gate).toMatch(/phase: 'admission'/);
    // The numbers the user is told, taken from the gate's own decision.
    expect(gate).toMatch(/position,/);
    expect(gate).toMatch(/limit: admission\.admissionLimit\(\)/);
  });

  it("reuses publishJobHealth rather than adding a second channel", () => {
    const gate = renderJob.slice(
      renderJob.indexOf("async function gateOnAdmission"),
      renderJob.indexOf("async function deferChunk"),
    );
    expect(gate).toMatch(/publishJobHealth\(/);
    // The memory gate already published here; the slot gate now does too.
    expect(gate).toMatch(/state: 'waiting-memory'/);
  });

  it("takes the notice down when the gate opens", () => {
    // Job health is otherwise cleared only when a CHUNK COMPLETES, so without
    // this the notice would outlive the wait and the poll would report a
    // queued project that was already encoding.
    expect(renderJob).toMatch(/async function clearAdmissionNotice/);
    expect(renderJob).toMatch(/if \(admitted\) \{\s*await clearAdmissionNotice/);
  });

  it("clears only its own notice, never another chunk's stall warning", () => {
    const fn = renderJob.slice(
      renderJob.indexOf("async function clearAdmissionNotice"),
      renderJob.indexOf("async function gateOnAdmission"),
    );
    // The health key is shared across the project's chunks.
    expect(fn).toMatch(/health\?\.phase === 'admission'/);
  });
});

describe("the status poll reports the gate without costing more", () => {
  const queue = read("render-worker/src/queue.js");

  it("reads job health exactly once per poll", () => {
    // The read already existed further down the function; it was moved, not
    // added. The poll endpoint runs at a 1,743ms median and must not grow.
    const reads = queue.match(/readJobHealth\(getRedisConnection\(\)/g) ?? [];
    expect(reads).toHaveLength(1);
  });

  it("adds no queue query for the gated case", () => {
    const block = queue.slice(
      queue.indexOf("── Chunk visibility"),
      queue.indexOf("── Stitch visibility"),
    );
    // Still exactly the two reads this block always made.
    expect(block.match(/chunkQueue\.get\w+\(/g) ?? []).toHaveLength(2);
    expect(block).toMatch(/gateNotice/);
  });

  it("refuses to report zero-ahead for a gated chunk", () => {
    const block = queue.slice(
      queue.indexOf("── Chunk visibility"),
      queue.indexOf("── Stitch visibility"),
    );
    // null means "not a countable queue". Zero was the measurement that read
    // as "nothing is in the way" for 318 seconds.
    expect(block).toMatch(/result\.chunks_ahead = null/);
  });

  it("lets an actually-running chunk override any stale notice", () => {
    const block = queue.slice(
      queue.indexOf("── Chunk visibility"),
      queue.indexOf("── Stitch visibility"),
    );
    const encodingAt = block.indexOf("chunk_state = 'encoding'");
    const gateAt = block.indexOf("gateNotice");
    expect(encodingAt).toBeGreaterThan(-1);
    // Observed reality is checked first; the notice only explains an absence.
    expect(encodingAt).toBeLessThan(block.indexOf("} else if (gateNotice)"));
    expect(gateAt).toBeGreaterThan(-1);
  });
});

describe("the new states survive the trip to the screen", () => {
  it("are accepted by the poll's allow-list", () => {
    const render = read("src/lib/render.functions.ts");
    expect(render).toMatch(/"waiting-slot"/);
    expect(render).toMatch(/"waiting-memory"/);
  });

  it("carry no fabricated chunks_ahead", () => {
    // Only the plain queue produces a countable number.
    const render = read("src/lib/render.functions.ts");
    expect(render).toMatch(/chunkState === "waiting" && typeof payload\.chunks_ahead === "number"/);
  });

  it("reach describeChunkPhase with the position argument", () => {
    const page = read("src/routes/_authenticated/projects.$projectId.tsx");
    const call = page.slice(
      page.indexOf("describeChunkPhase("),
      page.indexOf("describeChunkPhase(") + 240,
    );
    expect(call).toMatch(/renderJob\.queue_position/);
  });

  it("need no migration: chunk_state is an unconstrained text column", () => {
    // New values must not require a schema change, or they cannot ship with
    // the app that produces them.
    const migration = read("supabase/migrations/20260811000001_render_job_chunk_state.sql");
    expect(migration).toMatch(/add column if not exists chunk_state text/);
    expect(migration).not.toMatch(/check\s*\(/i);
  });
});
