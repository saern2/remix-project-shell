/**
 * Which cells build concurrently, and which never may.
 *
 * The B3 batch runs across BUCKETS only: two cells of one bucket race on the
 * read-merge-write of its candidates row and on providers_done, and the
 * loser's write silently discards the winner's candidates — the same
 * silent-data-loss class as the progress-read bug this round grew out of.
 *
 * And within a bucket the serial order is a PRIORITY order: NASA runs before
 * Pexels on a space project so NASA's finds enter the pool before the 120 cap
 * fills, and B1 skips the search of any cell whose bucket is already full. A
 * batch that took a bucket's Pexels cell early — because its NASA cell was
 * capped out of the batch — would let Pexels fill the cap and B1 then skip
 * NASA entirely. So a bucket contributes its FIRST pending cell or nothing.
 * That makes every bucket execute its cells in exactly the serial sequence,
 * which is what makes the stored corpus provably identical to the serial
 * build's, bucket by bucket.
 */
import { describe, expect, it } from "vitest";

import {
  BUCKET_CONCURRENCY,
  NASA_CELL_CONCURRENCY,
  nextCorpusBatch,
  pendingCorpusWork,
  type CorpusBucket,
  type CorpusProvider,
} from "../stock-corpus-store.server";

const bucket = (id: string, providersDone: string[] = []): CorpusBucket => ({
  id,
  query: `query ${id}`,
  tokens: [id],
  demandIds: [],
  candidates: [],
  providersDone,
});

const SPACE: CorpusProvider[] = ["nasa", "pexels", "pixabay"];
const GENERAL: CorpusProvider[] = ["pexels", "pixabay"];

const buckets = (count: number, providersDone: string[] = []) =>
  Array.from({ length: count }, (_, index) => bucket(`bucket-${index}`, providersDone));

describe("a batch never holds two cells of one bucket", () => {
  it("across the full space shape", () => {
    const batch = nextCorpusBatch(pendingCorpusWork(buckets(40), SPACE));
    const ids = batch.map((cell) => cell.bucket.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("even when one bucket holds every remaining cell", () => {
    // The tail of a build: one bucket, five cells. Concurrency must collapse
    // to 1 rather than race the bucket against itself.
    const batch = nextCorpusBatch(pendingCorpusWork(buckets(1), SPACE));
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ provider: "nasa", queryIndex: 0 });
  });
});

describe("a bucket contributes its first pending cell or nothing", () => {
  it("skips a NASA-capped bucket entirely rather than taking its Pexels cell", () => {
    // 40 buckets, all with NASA pending: the batch is two NASA cells and
    // NOTHING else. b2's first pending cell is NASA; with NASA capped, taking
    // its Pexels cell instead would break per-bucket order.
    const batch = nextCorpusBatch(pendingCorpusWork(buckets(40), SPACE));
    expect(batch.map((cell) => `${cell.bucket.id}:${cell.provider}#${cell.queryIndex}`)).toEqual([
      "bucket-0:nasa#0",
      "bucket-1:nasa#0",
    ]);
  });

  it("widens once buckets finish their NASA cells", () => {
    // b0 and b1 are past NASA; their first pending cell is Pexels. The batch
    // fills to four: two Pexels, two NASA — per-bucket order intact everywhere.
    const done = ["nasa#0", "nasa#1", "nasa#2"];
    const pending = pendingCorpusWork(
      [bucket("bucket-0", done), bucket("bucket-1", done), ...buckets(38).slice(2)],
      SPACE,
    );
    const batch = nextCorpusBatch(pending);
    expect(batch.map((cell) => `${cell.bucket.id}:${cell.provider}`)).toEqual([
      "bucket-0:pexels",
      "bucket-1:pexels",
      "bucket-2:nasa",
      "bucket-3:nasa",
    ]);
  });

  it("fills the full width on a general project, where nothing is capped", () => {
    const batch = nextCorpusBatch(pendingCorpusWork(buckets(40), GENERAL));
    expect(batch).toHaveLength(BUCKET_CONCURRENCY);
    expect(batch.every((cell) => cell.provider === "pexels")).toBe(true);
    expect(new Set(batch.map((cell) => cell.bucket.id)).size).toBe(BUCKET_CONCURRENCY);
  });
});

describe("the caps hold", () => {
  it("never exceeds BUCKET_CONCURRENCY cells or NASA_CELL_CONCURRENCY nasa cells", () => {
    // Sweep the build forward from every prefix of completed work; the caps
    // must hold at every stage, not just the first batch.
    for (let doneBuckets = 0; doneBuckets <= 40; doneBuckets += 5) {
      const state = [
        ...buckets(doneBuckets, ["nasa#0", "nasa#1", "nasa#2", "pexels", "pixabay"]),
        ...buckets(40).slice(doneBuckets),
      ];
      const batch = nextCorpusBatch(pendingCorpusWork(state, SPACE));
      expect(batch.length).toBeLessThanOrEqual(BUCKET_CONCURRENCY);
      expect(batch.filter((cell) => cell.provider === "nasa").length).toBeLessThanOrEqual(
        NASA_CELL_CONCURRENCY,
      );
    }
  });

  it("returns at least one cell whenever work is pending", () => {
    // The loop's forward-progress guarantee depends on this: an empty batch
    // with pending work would spin recordSlice(0) forever.
    expect(nextCorpusBatch(pendingCorpusWork(buckets(1), SPACE)).length).toBeGreaterThan(0);
    expect(nextCorpusBatch([])).toEqual([]);
  });
});

/**
 * The gated loop in prepareCorpus, pinned from the source: batches via
 * nextCorpusBatch, allSettled with successes kept before any failure
 * surfaces, and the budget fed the BATCH wall time so its projection —
 * elapsed + averageSliceMs — now describes one more batch. matching-budget.ts
 * itself is untouched.
 */
describe("the build loop batches, and the budget's unit is the batch", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  const source = readFileSync(resolve(process.cwd(), "src/lib/pipeline.functions.ts"), "utf8");
  const loop = source.slice(
    source.indexOf("while (pending.length > 0 && budget.shouldStartAnotherSlice())"),
    source.indexOf("if (pending.length > 0) {", source.indexOf("nextCorpusBatch(pending)")),
  );

  it("builds the batch with nextCorpusBatch and settles it with allSettled", () => {
    expect(loop).toMatch(/const batch = nextCorpusBatch\(pending\)/);
    expect(loop).toMatch(/Promise\.allSettled\(/);
    expect(loop).not.toMatch(/Promise\.all\(/);
  });

  it("keeps every fulfilled cell before surfacing any failure", () => {
    // Order in the source: the fulfilled branch stores into byId, the
    // rejection is only remembered, and the throw comes after the loop over
    // settled results — so a sibling's failure cannot discard written rows.
    const store = loop.indexOf("byId.set(result.value.id, result.value)");
    const rethrow = loop.indexOf("throw firstFailure");
    expect(store).toBeGreaterThan(-1);
    expect(rethrow).toBeGreaterThan(store);
  });

  it("records the batch's wall time, not a per-cell time", () => {
    expect(loop).toMatch(/const batchStartedAt = Date\.now\(\)/);
    expect(loop).toMatch(/budget\.recordSlice\(Date\.now\(\) - batchStartedAt\)/);
  });

  it("recomputes pending from the merged state after each batch", () => {
    expect(loop).toMatch(
      /pending = pendingCorpusWork\(\[\.\.\.byId\.values\(\)\], corpusProviders\)/,
    );
  });
});
