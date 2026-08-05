/**
 * Passwordless sign-in.
 *
 * This replaced passwords, so the properties below are not "nice to have" —
 * each one is the only thing standing where a password used to. They are
 * asserted against the policy module rather than a live database because the
 * policy is what decides; the I/O layer only carries it out.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  clientIpFrom,
  credentialLockPolicy,
  evaluateCode,
  generateLoginCode,
  isLockedOut,
  loginCodeMaxAttempts,
  loginCodeRequestLimit,
  loginCodeTtlMinutes,
  normalizeEmail,
  timingSafeEqualHex,
  trustedDeviceDays,
} from "../sign-in.server";
import { lockMessage, SIGN_IN_MESSAGES } from "../sign-in.messages";

const ENV_KEYS = [
  "TRUSTED_DEVICE_DAYS",
  "LOGIN_CODE_TTL_MINUTES",
  "LOGIN_CODE_MAX_ATTEMPTS",
  "LOGIN_CODE_MAX_REQUESTS",
  "LOGIN_CODE_REQUEST_WINDOW_MINUTES",
  "LOGIN_SECRET_MAX_FAILURES",
  "LOGIN_LOCK_MINUTES",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("credential comparison", () => {
  it("accepts an exact match and rejects anything else", () => {
    const digest = "a".repeat(64);
    expect(timingSafeEqualHex(digest, digest)).toBe(true);
    expect(timingSafeEqualHex(digest, "b".repeat(64))).toBe(false);
  });

  it("rejects a differing length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; a credential check must not
    // turn a wrong-length input into a 500.
    expect(timingSafeEqualHex("a".repeat(64), "a".repeat(63))).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });

  it("compares the whole value, not a prefix", () => {
    // A prefix-equal pair is exactly what an === short-circuit would leak the
    // length of. Both of these must be false.
    const stored = "abc" + "0".repeat(61);
    expect(timingSafeEqualHex(stored, "abc" + "1".repeat(61))).toBe(false);
    expect(timingSafeEqualHex(stored, "abd" + "0".repeat(61))).toBe(false);
  });

  it("never throws on non-string input", () => {
    expect(timingSafeEqualHex(undefined as unknown as string, "a")).toBe(false);
  });
});

describe("one-time codes", () => {
  it("is six digits, zero-padded, from the CSPRNG", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLoginCode()).toMatch(/^\d{6}$/);
    }
  });

  it("produces a spread of values rather than a constant", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateLoginCode()));
    expect(seen.size).toBeGreaterThan(150);
  });

  const base = {
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    invalidatedAt: null,
  };

  it("accepts a fresh, unused code", () => {
    expect(evaluateCode(base)).toBe("usable");
  });

  it("rejects an expired code", () => {
    expect(evaluateCode({ ...base, expiresAt: new Date(Date.now() - 1000) })).toBe("expired");
  });

  it("rejects a code that was already used", () => {
    expect(evaluateCode({ ...base, consumedAt: new Date() })).toBe("spent");
  });

  it("rejects a code a newer request superseded", () => {
    expect(evaluateCode({ ...base, invalidatedAt: new Date() })).toBe("superseded");
  });

  it("dies at the attempt ceiling", () => {
    expect(evaluateCode({ ...base, attempts: 4 })).toBe("usable");
    expect(evaluateCode({ ...base, attempts: 5 })).toBe("too-many-attempts");
  });

  it("reports being superseded before being expired", () => {
    // Both are true for an abandoned code. "Request a new one" is wrong advice
    // when a newer one is already in their inbox.
    const stale = { ...base, expiresAt: new Date(Date.now() - 1000), invalidatedAt: new Date() };
    expect(evaluateCode(stale)).toBe("superseded");
  });
});

describe("policy defaults and overrides", () => {
  it("defaults trusted devices to 60 days, inside the 30-90 range", () => {
    expect(trustedDeviceDays()).toBe(60);
    process.env.TRUSTED_DEVICE_DAYS = "30";
    expect(trustedDeviceDays()).toBe(30);
  });

  it("defaults the code to 10 minutes and 5 attempts", () => {
    expect(loginCodeTtlMinutes()).toBe(10);
    expect(loginCodeMaxAttempts()).toBe(5);
  });

  it("rate limits code REQUESTS separately from attempts", () => {
    // Attempts protect the code; requests protect the inbox and the shared
    // email quota. They must not be the same number by accident.
    const { maxRequests, windowMinutes } = loginCodeRequestLimit();
    expect(maxRequests).toBe(3);
    expect(windowMinutes).toBe(15);
    expect(maxRequests).not.toBe(loginCodeMaxAttempts());
  });

  it("locks the credential screen after five failures", () => {
    expect(credentialLockPolicy()).toEqual({ maxFailures: 5, lockMinutes: 15 });
    expect(isLockedOut(4)).toBe(false);
    expect(isLockedOut(5)).toBe(true);
  });

  it("falls back to the default when misconfigured", () => {
    process.env.TRUSTED_DEVICE_DAYS = "not a number";
    process.env.LOGIN_CODE_MAX_ATTEMPTS = "-3";
    expect(trustedDeviceDays()).toBe(60);
    expect(loginCodeMaxAttempts()).toBe(5);
  });
});

describe("what the user is told", () => {
  it("says the same thing for a wrong secret, an unknown email and no secret", () => {
    // All three return { outcome: "denied" }, which renders this one string.
    // Three messages would make the form a way to test which addresses exist.
    expect(SIGN_IN_MESSAGES.denied).toBe(
      "That access secret is not correct. Check it and try again.",
    );
    expect(SIGN_IN_MESSAGES.denied).not.toMatch(/account|registered|exists|unknown/i);
  });

  it("distinguishes pending from rejected, but only after a valid secret", () => {
    expect(SIGN_IN_MESSAGES.pending).toMatch(/awaiting approval/i);
    expect(SIGN_IN_MESSAGES.rejected).not.toBe(SIGN_IN_MESSAGES.pending);
  });

  it("tells a locked-out user when to come back", () => {
    expect(lockMessage(15)).toBe("Too many attempts. Try again in 15 minutes.");
    expect(lockMessage(15)).not.toContain("{minutes}");
  });

  it("gives a delivery failure a retry rather than a dead end", () => {
    // A silent failure here locks someone out completely.
    expect(SIGN_IN_MESSAGES.delivery_failed).toMatch(/try again/i);
  });

  it("points a device-limited user at the existing admin reset", () => {
    // The five-browser limit and its admin-reset recovery already existed; the
    // message must describe that, not invent a different remedy.
    expect(SIGN_IN_MESSAGES.device_limit_reached).toMatch(/five browsers/i);
    expect(SIGN_IN_MESSAGES.device_limit_reached).toMatch(/administrator/i);
  });

  it("never embeds a secret or a code in any message", () => {
    for (const message of Object.values(SIGN_IN_MESSAGES)) {
      expect(message).not.toMatch(/ss_[A-Za-z0-9_-]/);
      expect(message).not.toMatch(/\b\d{6}\b/);
    }
  });
});

describe("request plumbing", () => {
  it("normalises emails the same way the tables do", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("reads the client IP from the usual proxy headers", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIpFrom(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFrom(new Headers())).toBeNull();
    expect(clientIpFrom(null)).toBeNull();
  });
});
