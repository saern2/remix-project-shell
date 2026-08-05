import { describe, expect, it } from "vitest";
import {
  isProjectLimitError,
  PROJECT_LIMIT,
  projectUsage,
  summarizeProjectStatuses,
} from "../project-limit";

describe("two-project limit helpers", () => {
  it.each([
    [0, false, 2],
    [1, false, 1],
    [2, true, 0],
    [3, true, 0],
  ])("maps %i projects to the correct limit state", (count, atLimit, remaining) => {
    // exempt is false for a regular account; the admin case lives in
    // project-limit-admin.test.ts.
    expect(projectUsage(count)).toEqual({ count, atLimit, remaining, exempt: false });
    expect(PROJECT_LIMIT).toBe(2);
  });

  it("recognizes the stable database trigger error without exposing raw SQL", () => {
    expect(isProjectLimitError({ message: "PROJECT_LIMIT_REACHED" })).toBe(true);
    expect(isProjectLimitError({ details: "A user may own at most two projects." })).toBe(false);
    expect(isProjectLimitError(new Error("unrelated"))).toBe(false);
  });

  it("derives dashboard statistics from every project status", () => {
    expect(
      summarizeProjectStatuses([
        { status: "draft" },
        { status: "failed" },
        { status: "rendering" },
        { status: "completed" },
        { status: "cancelled" },
      ]),
    ).toEqual({ total: 5, active: 1, completed: 1, attention: 2 });
  });
});
