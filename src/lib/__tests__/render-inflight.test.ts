import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_INFLIGHT_PROJECTS,
  INFLIGHT_RENDER_STATUSES,
  INFLIGHT_STALE_AFTER_HOURS,
  inflightRefusalMessage,
  maxInflightProjects,
  shouldRefuseSubmission,
} from "@/lib/render-inflight";

describe("maxInflightProjects", () => {
  it("defaults to 12 — the operator's decision for Round A (B5)", () => {
    expect(DEFAULT_MAX_INFLIGHT_PROJECTS).toBe(12);
    expect(maxInflightProjects({})).toBe(12);
  });

  it("reads MAX_INFLIGHT_PROJECTS from the environment", () => {
    expect(maxInflightProjects({ MAX_INFLIGHT_PROJECTS: "5" })).toBe(5);
    expect(maxInflightProjects({ MAX_INFLIGHT_PROJECTS: "42" })).toBe(42);
  });

  it("falls back to the default on unset, empty, unparsable, or non-positive values", () => {
    // A misconfigured guard must not become an outage of its own.
    expect(maxInflightProjects({ MAX_INFLIGHT_PROJECTS: "" })).toBe(12);
    expect(maxInflightProjects({ MAX_INFLIGHT_PROJECTS: "many" })).toBe(12);
    expect(maxInflightProjects({ MAX_INFLIGHT_PROJECTS: "0" })).toBe(12);
    expect(maxInflightProjects({ MAX_INFLIGHT_PROJECTS: "-3" })).toBe(12);
  });
});

describe("shouldRefuseSubmission", () => {
  it("admits below the ceiling and refuses at it", () => {
    expect(shouldRefuseSubmission(0, 12)).toBe(false);
    expect(shouldRefuseSubmission(11, 12)).toBe(false);
    // The 12th in-flight project fills the last slot; the NEXT submission —
    // seeing 12 already in flight — is the first one refused.
    expect(shouldRefuseSubmission(12, 12)).toBe(true);
    expect(shouldRefuseSubmission(42, 12)).toBe(true);
  });
});

describe("inflightRefusalMessage", () => {
  it("names the real depth and the ceiling — honest, not vague", () => {
    const message = inflightRefusalMessage(12, 12);
    expect(message).toContain("12 projects are already rendering or waiting");
    expect(message).toContain("at most 12 at once");
    expect(message).toContain("Nothing was submitted");
  });

  it("reads grammatically at a depth of one", () => {
    expect(inflightRefusalMessage(1, 1)).toContain("1 project is already rendering or waiting");
  });
});

describe("the in-flight status vocabulary", () => {
  it("counts exactly the non-terminal render statuses", () => {
    // Mirrors the poll path's allowed list minus TERMINAL_RENDER_STATUSES
    // (completed/failed/cancelled). A terminal status slipping in here would
    // wedge the ceiling shut with finished work; a non-terminal one missing
    // would undercount live load.
    expect([...INFLIGHT_RENDER_STATUSES].sort()).toEqual(["downloading", "queued", "rendering"]);
  });

  it("pins the staleness cutoff that keeps zombie rows from wedging the ceiling", () => {
    // Job c1c1586e sat at 0% for 19 days. Without an age cutoff, one such row
    // holds a ceiling slot forever.
    expect(INFLIGHT_STALE_AFTER_HOURS).toBe(24);
  });
});
