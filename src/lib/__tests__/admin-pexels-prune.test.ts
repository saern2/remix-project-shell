import { describe, expect, it } from "vitest";

import { isNeverSucceededPexelsKey } from "../admin.functions";

describe("Pexels key prune eligibility", () => {
  it("only marks never-successful authentication rejections for pruning", () => {
    expect(
      isNeverSucceededPexelsKey({
        request_count: 0,
        last_error: "Pexels rejected key (HTTP 401)",
      }),
    ).toBe(true);
    expect(
      isNeverSucceededPexelsKey({
        request_count: 0,
        last_error: "Pexels rejected key (HTTP 403)",
      }),
    ).toBe(true);
    expect(
      isNeverSucceededPexelsKey({
        request_count: 12,
        last_error: "Pexels rejected key (HTTP 401)",
      }),
    ).toBe(false);
    expect(
      isNeverSucceededPexelsKey({
        request_count: 0,
        last_error: "Pexels rate limit reached (HTTP 429)",
      }),
    ).toBe(false);
  });
});
