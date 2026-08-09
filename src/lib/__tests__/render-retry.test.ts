import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { retryModeForProject } from "../render-retry";

/**
 * Retry must not discard what the failure did not destroy.
 *
 * MEASURED, 2026-08-09 (retry-run HARs): a project that failed at 34/36
 * rendered segments went failed → draft → generating_scenes →
 * matching_footage → ready → rendering on Retry — 5-6 minutes of matching
 * re-done for a timeline that was already complete, immediately after telling
 * the user "Nothing was lost from your project".
 */
describe("retryModeForProject", () => {
  it("a render failure with an intact timeline resubmits the render only", () => {
    expect(
      retryModeForProject({ latestRenderJobStatus: "failed", timelineComplete: true }),
    ).toBe("render-only");
  });

  it("a cancelled render also keeps its timeline", () => {
    expect(
      retryModeForProject({ latestRenderJobStatus: "cancelled", timelineComplete: true }),
    ).toBe("render-only");
  });

  it("a matching failure (no render job) re-runs the pipeline", () => {
    expect(retryModeForProject({ latestRenderJobStatus: null, timelineComplete: true })).toBe(
      "full-pipeline",
    );
    expect(
      retryModeForProject({ latestRenderJobStatus: undefined, timelineComplete: false }),
    ).toBe("full-pipeline");
  });

  it("a STALE render failure behind a broken timeline re-runs the pipeline", () => {
    // The compound shape: render failed, user retried, matching then failed.
    // The latest render job still says "failed", but the timeline it belonged
    // to is gone — resubmitting the render would render a half-built project.
    expect(
      retryModeForProject({ latestRenderJobStatus: "failed", timelineComplete: false }),
    ).toBe("full-pipeline");
  });

  it("an active or completed render job never triggers render-only retry", () => {
    for (const status of ["queued", "downloading", "rendering", "completed", "weird"]) {
      expect(retryModeForProject({ latestRenderJobStatus: status, timelineComplete: true })).toBe(
        "full-pipeline",
      );
    }
  });
});

describe("the project page actually honors the decision", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../routes/_authenticated/projects.$projectId.tsx"),
    "utf8",
  );

  it("render-only retry returns BEFORE the draft reset", () => {
    const retryFn = source.slice(source.indexOf("const handleRetry"));
    const renderOnly = retryFn.indexOf('mode === "render-only"');
    const draftReset = retryFn.indexOf('status: "draft"');
    expect(renderOnly).toBeGreaterThan(-1);
    expect(draftReset).toBeGreaterThan(-1);
    // The branch must short-circuit: resubmit, invalidate, return — never
    // fall through into the pipeline reset that discards the ready state.
    expect(renderOnly).toBeLessThan(draftReset);
    expect(retryFn.slice(renderOnly, draftReset)).toMatch(/runSubmitRender/);
    expect(retryFn.slice(renderOnly, draftReset)).toMatch(/return;/);
    // And the render-only branch must not touch the pipeline entry point.
    expect(retryFn.slice(renderOnly, draftReset)).not.toMatch(/runStart/);
  });

  it("scenes are loaded for failed projects, so the timeline check can run", () => {
    // Without this, expectedFixedSliceCount is 0 for every failed project and
    // the render-only path could never be taken.
    expect(source).toMatch(/project\.status === "failed"\)/);
  });
});
