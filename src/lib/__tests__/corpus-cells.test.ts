/**
 * Corpus work is scheduled one query at a time.
 *
 * A cell cannot be preempted, so it is the true unit the time budget can stop
 * at. NASA used to run all three of its expanded queries inside one cell — three
 * sequential HTTP searches — which is how a space project produced 17s
 * invocations against a 12s budget.
 */
import { describe, expect, it } from "vitest";

import {
  corpusCellKey,
  NASA_QUERIES_PER_BUCKET,
  pendingCorpusWork,
  type CorpusBucket,
} from "../stock-corpus-store.server";

const bucket = (id: string, providersDone: string[] = []): CorpusBucket => ({
  id,
  query: `query ${id}`,
  tokens: [id],
  demandIds: [],
  candidates: [],
  providersDone,
});

describe("corpus cell scheduling", () => {
  it("emits one cell per NASA query, not one per provider", () => {
    const cells = pendingCorpusWork([bucket("b0")], ["nasa", "pexels", "pixabay"]);
    expect(cells.filter((c) => c.provider === "nasa")).toHaveLength(NASA_QUERIES_PER_BUCKET);
    expect(cells.filter((c) => c.provider === "pexels")).toHaveLength(1);
    expect(cells.filter((c) => c.provider === "pixabay")).toHaveLength(1);
  });

  it("resumes from the exact query it stopped at", () => {
    const partial = bucket("b0", ["pexels", corpusCellKey("nasa", 0)]);
    const cells = pendingCorpusWork([partial], ["nasa", "pexels", "pixabay"]);

    expect(cells.map((c) => `${c.provider}#${c.queryIndex}`)).toEqual([
      "nasa#1",
      "nasa#2",
      "pixabay#0",
    ]);
  });

  it("keeps the bare provider name for single-query providers", () => {
    // Rows written before cells were split store "pexels"/"pixabay"; those must
    // still read as done rather than being searched a second time.
    expect(corpusCellKey("pexels", 0)).toBe("pexels");
    expect(corpusCellKey("pixabay", 0)).toBe("pixabay");
    expect(pendingCorpusWork([bucket("b0", ["pexels", "pixabay"])], ["pexels", "pixabay"])).toEqual(
      [],
    );
  });

  it("honours a legacy bare 'nasa' marker as covering every NASA query", () => {
    // Written by the version that did all three queries in one cell. Re-running
    // them would be correct but wasteful, so the marker is respected.
    const legacy = bucket("b0", ["nasa", "pexels", "pixabay"]);
    expect(pendingCorpusWork([legacy], ["nasa", "pexels", "pixabay"])).toEqual([]);
  });

  it("returns nothing once every bucket is fully searched", () => {
    const done = ["pexels", "pixabay", "nasa#0", "nasa#1", "nasa#2"];
    expect(
      pendingCorpusWork([bucket("b0", done), bucket("b1", done)], ["nasa", "pexels", "pixabay"]),
    ).toEqual([]);
  });

  it("orders cells bucket by bucket so progress is contiguous", () => {
    const cells = pendingCorpusWork([bucket("b0"), bucket("b1")], ["pexels", "pixabay"]);
    expect(cells.map((c) => c.bucket.id)).toEqual(["b0", "b0", "b1", "b1"]);
  });
});
