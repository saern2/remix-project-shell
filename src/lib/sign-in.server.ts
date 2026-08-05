/**
 * Policy for passwordless sign-in.
 *
 * THE FLOW. Screen 1 takes an email. Screen 2 takes a credential — an access
 * secret for regular users, a password for administrators, in a field that looks
 * identical either way. Screen 3 takes a one-time emailed code, and appears ONLY
 * for a browser that is not already trusted.
 *
 * WHY SCREEN 1 MAKES NO SERVER CALL. "Always advance whether or not the email
 * exists" is easy to write and easy to break later — one added lookup, one
 * differing error, and registration status leaks. Advancing purely on the client
 * makes the leak structurally impossible: there is nothing to compare, because
 * nothing was asked.
 *
 * WHAT THIS FILE OWNS. Timing-safe comparison, the rate-limit arithmetic, and
 * the code lifecycle. Everything here is pure so it can be tested without a
 * database; the I/O lives in sign-in.functions.ts.
 */

import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * How long a browser stays trusted before it must pass a fresh emailed code.
 *
 * 60 days is the middle of the 30-90 range: long enough that a regular user
 * sees the code screen roughly twice a year, short enough that a laptop lost and
 * never reported stops being a way in within a quarter. TRUSTED_DEVICE_DAYS
 * overrides it; the database default in the migration matches.
 */
export function trustedDeviceDays(): number {
  const configured = Number(process.env.TRUSTED_DEVICE_DAYS ?? 60);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60;
}

/** Code lifetime. Supabase's own OTP expiry must be set to match, in the dashboard. */
export function loginCodeTtlMinutes(): number {
  const configured = Number(process.env.LOGIN_CODE_TTL_MINUTES ?? 10);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10;
}

/** Attempts at a single code before it dies and a new one must be requested. */
export function loginCodeMaxAttempts(): number {
  const configured = Number(process.env.LOGIN_CODE_MAX_ATTEMPTS ?? 5);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 5;
}

/**
 * Code REQUESTS allowed per window, counted separately from attempts.
 *
 * Attempts protect the code; this protects the user's inbox. Without it, anyone
 * who knows an address can have us mail it on demand — and with the built-in
 * email service that also exhausts a project-wide quota, so one address being
 * spammed would stop everyone else signing in.
 */
export function loginCodeRequestLimit(): { maxRequests: number; windowMinutes: number } {
  const maxRequests = Number(process.env.LOGIN_CODE_MAX_REQUESTS ?? 3);
  const windowMinutes = Number(process.env.LOGIN_CODE_REQUEST_WINDOW_MINUTES ?? 15);
  return {
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? Math.floor(maxRequests) : 3,
    windowMinutes:
      Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.floor(windowMinutes) : 15,
  };
}

/** Failures on the credential screen before that email or IP is locked out. */
export function credentialLockPolicy(): { maxFailures: number; lockMinutes: number } {
  const maxFailures = Number(process.env.LOGIN_SECRET_MAX_FAILURES ?? 5);
  const lockMinutes = Number(process.env.LOGIN_LOCK_MINUTES ?? 15);
  return {
    maxFailures: Number.isFinite(maxFailures) && maxFailures > 0 ? Math.floor(maxFailures) : 5,
    lockMinutes: Number.isFinite(lockMinutes) && lockMinutes > 0 ? Math.floor(lockMinutes) : 15,
  };
}

/**
 * Compares two hex digests without leaking where they first differ.
 *
 * Both operands are HMAC-SHA256 output, so an attacker cannot work backwards
 * from a timing signal without the pepper — but this is the check that replaced
 * passwords, and `===` on a credential path is not worth defending. Unequal
 * lengths return false before the comparison, because timingSafeEqual throws on
 * a length mismatch and a length difference is not itself a secret here.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/** A six-digit code from the CSPRNG. randomInt is uniform; Math.random is not. */
export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type CredentialOutcome =
  /** Wrong credential, unknown email, or no secret issued — all indistinguishable. */
  | { outcome: "denied" }
  | { outcome: "locked"; retryAfterMinutes: number }
  | { outcome: "pending" }
  | { outcome: "rejected" }
  /** Correct credential, browser already trusted: no code needed. */
  | { outcome: "signed_in"; accessToken: string; refreshToken: string }
  /** Correct credential, new browser: a code is on its way. */
  | { outcome: "code_sent" }
  /** Correct credential, but the five trusted browsers are already spoken for. */
  | { outcome: "device_limit_reached" }
  | { outcome: "delivery_failed"; message: string };

// Copy lives in sign-in.messages.ts so the browser can import it too — this
// module pulls in node:crypto and cannot be bundled for the client.
export { SIGN_IN_MESSAGES, lockMessage } from "@/lib/sign-in.messages";

export type CodeState = {
  expiresAt: string | Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: string | Date | null;
  invalidatedAt: string | Date | null;
};

export type CodeVerdict = "usable" | "expired" | "spent" | "superseded" | "too-many-attempts";

/**
 * Whether a stored code may still be attempted.
 *
 * Ordered so the user gets the most actionable reason: a superseded code means
 * they are looking at an older email, which is the one case where "request a new
 * one" would be exactly the wrong advice.
 */
export function evaluateCode(state: CodeState, now: Date = new Date()): CodeVerdict {
  if (state.consumedAt != null) return "spent";
  if (state.invalidatedAt != null) return "superseded";
  if (state.attempts >= state.maxAttempts) return "too-many-attempts";
  if (new Date(state.expiresAt).getTime() <= now.getTime()) return "expired";
  return "usable";
}

/** Whether this email or IP has failed often enough to be locked out. */
export function isLockedOut(recentFailureCount: number): boolean {
  return recentFailureCount >= credentialLockPolicy().maxFailures;
}

/** Normalises an email the same way every table and lookup does. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Best-effort client IP.
 *
 * Only ever used to rate limit and to annotate a failure log, so a spoofed
 * X-Forwarded-For costs an attacker nothing they did not already have — it can
 * never grant access. The per-email limit is the one that has to hold.
 */
export function clientIpFrom(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip") ?? null;
}
