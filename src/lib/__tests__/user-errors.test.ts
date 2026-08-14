/**
 * No raw server string ever reaches a user.
 *
 * OBSERVED 2026-08-14: the Cloudflare Workers hang detector cancelled
 * pollPipeline requests, the proxy answered "Internal server error" (21
 * bytes), the server-function client surfaced that body as the Error message,
 * and the poll loop's toast put it on screen verbatim — once per ~94s crash
 * cycle. Eleven call sites shared the same toast.error((err).message) shape.
 *
 * The rule: infrastructure failures are described by US; messages the
 * application wrote for users pass through untouched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  describeUserFacingError,
  isTransportNoise,
  TRANSIENT_RETRYING,
  TRANSIENT_TRY_AGAIN,
} from "../user-errors";

describe("transport noise becomes our sentence, not theirs", () => {
  it("maps the observed 502 body", () => {
    // The exact 21-byte string users saw as a toast.
    expect(describeUserFacingError(new Error("Internal server error"))).toBe(TRANSIENT_TRY_AGAIN);
  });

  it("maps the rest of the infrastructure vocabulary", () => {
    for (const raw of [
      "Bad Gateway",
      "502 Bad Gateway",
      "Service Unavailable",
      "Gateway Timeout",
      "gateway time-out",
      "Failed to fetch", // Chromium
      "NetworkError when attempting to fetch resource.", // Firefox
      "Load failed", // Safari
      "fetch failed", // undici
      "Network request failed",
      "socket hang up",
      "read ECONNRESET",
      "connect ECONNREFUSED 1.2.3.4:443",
      "ETIMEDOUT",
      "500",
      "Unexpected token '<', \"<html>...\" is not valid JSON",
      "<html><head><title>502 Bad Gateway</title></head></html>",
      "Error: The Workers runtime canceled this request because it detected that your Worker's code had hung",
    ]) {
      expect(describeUserFacingError(new Error(raw)), raw).toBe(TRANSIENT_TRY_AGAIN);
      expect(isTransportNoise(raw), raw).toBe(true);
    }
  });

  it("honours the caller's transient wording", () => {
    // A poll retries itself; a button does not. The sentence must match the
    // path, or it claims a retry that will never happen.
    expect(
      describeUserFacingError(new Error("Internal server error"), {
        transient: TRANSIENT_RETRYING,
      }),
    ).toBe(TRANSIENT_RETRYING);
    expect(TRANSIENT_RETRYING).toContain("retrying automatically");
    expect(TRANSIENT_TRY_AGAIN).toContain("please try again");
  });
});

describe("application-authored messages pass through untouched", () => {
  it("keeps the sentences this codebase wrote for users", () => {
    for (const authored of [
      "This project no longer exists.",
      "Project processing stopped because the project was deleted.",
      "Stock provider request budget exceeded (120 Pexels requests per project).",
      "Maintenance mode is on. Your project is paused, not lost.",
    ]) {
      expect(describeUserFacingError(new Error(authored))).toBe(authored);
      expect(isTransportNoise(authored), authored).toBe(false);
    }
  });

  it("falls back when there is no message at all", () => {
    expect(describeUserFacingError(new Error(""))).toBe("Something went wrong. Please try again.");
    expect(describeUserFacingError(null)).toBe("Something went wrong. Please try again.");
    expect(describeUserFacingError(undefined, { fallback: "Action failed." })).toBe(
      "Action failed.",
    );
    expect(describeUserFacingError({ odd: true })).toBe("Something went wrong. Please try again.");
  });
});

describe("every toast site goes through the mapper", () => {
  // The shape that put "Internal server error" on screen. Any file that
  // toasts an error must route it through describeUserFacingError.
  const OFFENDING = /toast\.error\(\s*\(?(err|error)\b(?!\w)[^)]*\.message/;

  it.each([
    "src/routes/_authenticated/projects.$projectId.tsx",
    "src/routes/_authenticated/projects.new.tsx",
    "src/routes/auth.tsx",
    "src/components/admin-access-panel.tsx",
    "src/components/maintenance-panel.tsx",
  ])("%s", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(OFFENDING);
    expect(source).toMatch(/describeUserFacingError\(/);
  });

  it("the pipeline poll records its failure for the paused banner", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/routes/_authenticated/projects.$projectId.tsx"),
      "utf8",
    );
    // Recorded on EVERY error, not only the first of a streak — the banner
    // counts a pattern, and the toast's once-per-streak throttle would hide
    // repeats from it.
    const catchBlock = source.slice(
      source.indexOf("consecutiveErrors += 1"),
      source.indexOf("} finally {", source.indexOf("consecutiveErrors += 1")),
    );
    expect(catchBlock).toMatch(/noteServerFnError\(\)/);
    // And the count reaches the view builder.
    expect(source).toMatch(
      /describeMatchingProgress\(matchingCounts\[projectId\], \{ recentServerErrors \}\)/,
    );
  });
});
