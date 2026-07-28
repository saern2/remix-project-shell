import { describe, expect, it } from "vitest";
import {
  fallbackVisualQuery,
  parseVisualQueryContent,
} from "../visual-queries.server";

describe("visual query resilience", () => {
  it("parses fenced JSON responses", () => {
    expect(
      parseVisualQueryContent('```json\n{"results":[{"idx":0,"query":"police chase road"}]}\n```'),
    ).toEqual({ results: [{ idx: 0, query: "police chase road" }] });
  });

  it("extracts balanced JSON from surrounding text", () => {
    expect(
      parseVisualQueryContent('Here is the JSON: {"results":[{"idx":1,"query":"crowd cheering"}]} thanks'),
    ).toEqual({ results: [{ idx: 1, query: "crowd cheering" }] });
  });

  it("builds deterministic category-aware fallbacks", () => {
    expect(fallbackVisualQuery("The final whistle brought happy viewers with popcorn.", "crime")).toBe(
      "crime law enforcement final whistle brought",
    );
  });
});
