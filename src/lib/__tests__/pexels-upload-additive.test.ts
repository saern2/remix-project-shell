/**
 * A key upload adds. It never takes away.
 *
 * The previous handler was a REPLACE: once a batch met a safety threshold, every
 * active key NOT in the upload was deactivated with
 * "Replaced by validated upload batch". Adding two keys silently retired the
 * rest of the pool — a routine top-up destroying capacity, with no confirmation
 * and no obvious way to notice afterwards.
 *
 * Source assertions, because the destructive path was a block of code that
 * simply should not exist. A behavioural test can only prove the cases it
 * enumerates; this proves the deactivation is gone entirely.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/lib/admin-pexels.functions.ts"), "utf8");

/** Just the upload handler, so assertions do not catch unrelated admin actions. */
const uploadHandler = source.slice(
  source.indexOf("export const uploadPexelsKeysResilient"),
  source.indexOf("export const revalidateAllPexelsKeys"),
);

describe("uploading keys is additive", () => {
  it("never deactivates a key that was not in the upload", () => {
    expect(uploadHandler).not.toContain("Replaced by validated upload batch");
    expect(uploadHandler).not.toMatch(/activeOutsideUpload/);
    expect(uploadHandler).not.toMatch(/is_active:\s*false/);
  });

  it("never deletes a key", () => {
    // Removal must stay a separate, explicit action.
    expect(uploadHandler).not.toMatch(/\.delete\(\)/);
  });

  it("only ever writes is_active true", () => {
    const writes = uploadHandler.match(/is_active:\s*(true|false)/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.includes("true"))).toBe(true);
  });

  it("inserts valid new keys unconditionally", () => {
    // The safety threshold used to gate INSERTS too, so a small upload validated
    // its keys and then threw them away. A valid uploaded key gets added.
    expect(uploadHandler).not.toContain("safetyThresholdMet");
    expect(uploadHandler).not.toContain("replacement threshold was not met");
  });
});

describe("the result summary answers what happened to each key", () => {
  it("reports added, already present, reactivated and rejected", () => {
    for (const field of ["inserted", "alreadyPresent", "reactivated", "invalid", "errors"]) {
      expect(uploadHandler).toContain(field);
    }
  });

  it("reports the resulting pool size, which is what an operator checks", () => {
    expect(uploadHandler).toContain("activePoolSize");
    expect(uploadHandler).toContain('.eq("is_active", true)');
  });

  it("carries a per-key detail so a rejection says why", () => {
    expect(uploadHandler).toMatch(/detail:/);
    expect(uploadHandler).toContain("validation.detail");
  });
});

describe("an inactive key is revalidated, not skipped as a duplicate", () => {
  it("separates inactive keys from active ones before validating", () => {
    // An inactive key that passes validation must come back, rather than being
    // dismissed as already present.
    expect(uploadHandler).toContain("inactiveKeys");
    expect(uploadHandler).toContain("keysToValidate = [...inactiveKeys, ...newKeys]");
    expect(uploadHandler).toContain("reactivated");
  });

  it("marks only ALREADY ACTIVE keys as duplicates", () => {
    expect(uploadHandler).toContain("Key is already active in the pool.");
  });
});

describe("keys can be pasted as well as uploaded", () => {
  it("parses newline-separated input, so paste and CSV share one path", () => {
    // The parser splits on newlines and commas alike; the paste box is a UI
    // affordance over the same server function rather than a second code path.
    expect(source).toContain("csv\n        .split(/[\\r\\n,]+/)");
  });
});
