/**
 * What an error is allowed to look like on screen.
 *
 * OBSERVED 2026-08-14: the Cloudflare Workers hang detector cancelled
 * pollPipeline requests, the proxy answered with a 21-byte "Internal server
 * error" body, the server-function client surfaced that body as the thrown
 * Error's message, and the poll loop's catch put it on screen verbatim as a
 * toast — once per ~94s crash cycle, to every viewer. Eleven call sites shared
 * the same `toast.error((err as Error).message)` shape, so any raw transport
 * string the stack produced was one failure away from being user-facing.
 *
 * The rule this module enforces: an infrastructure failure is described by US,
 * never by whatever byte string the transport happened to carry. Messages the
 * APPLICATION wrote for users ("This project no longer exists.") pass through
 * untouched — they are already the honest, specific text this platform's
 * history demands.
 *
 * Pure, so the classification is testable without a server or a toast.
 */

/**
 * Transport and infrastructure noise, matched case-insensitively. Everything
 * here is a string a user has actually seen or plausibly could: proxy bodies,
 * fetch-layer failures across browsers, HTML error pages leaking through.
 */
const TRANSPORT_NOISE = [
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /^\s*<!?\w*html/i, // an HTML error page where a message should be
  /failed to fetch/i, // Chromium's fetch rejection
  /networkerror/i, // Firefox's
  /load failed/i, // Safari's
  /fetch failed/i, // undici's
  /network request failed/i,
  /socket hang ?up/i,
  /ECONNRE(SET|FUSED)/,
  /ETIMEDOUT/,
  /^\s*\d{3}\s*$/, // a bare status code
  /^unexpected (token|end of json)/i, // JSON.parse on an error page body
  /worker.s code had hung/i, // the hang detector's own text
];

/** True when a message is transport noise rather than something we wrote. */
export function isTransportNoise(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return true;
  return TRANSPORT_NOISE.some((pattern) => pattern.test(trimmed));
}

export type UserFacingErrorOptions = {
  /**
   * Shown for transport/server failures. Callers pick the honest version for
   * their context: a poll retries by itself, a mutation does not, and telling
   * a user "it will retry" about a button that will not is this platform's
   * least favourite kind of lie.
   */
  transient?: string;
  /** Shown when the error carries no usable message at all. */
  fallback?: string;
};

/** The transient text for paths that retry themselves (the pipeline polls). */
export const TRANSIENT_RETRYING =
  "The server had a temporary problem. Your project is safe — retrying automatically.";

/** The transient text for one-shot actions (buttons), which do not retry. */
export const TRANSIENT_TRY_AGAIN =
  "The server had a temporary problem. Nothing was changed — please try again.";

/**
 * The message a user should see for `err`.
 *
 * Application-authored messages pass through; transport noise becomes the
 * caller's `transient` text; an empty or missing message becomes `fallback`.
 */
export function describeUserFacingError(
  err: unknown,
  options: UserFacingErrorOptions = {},
): string {
  const transient = options.transient ?? TRANSIENT_TRY_AGAIN;
  const fallback = options.fallback ?? "Something went wrong. Please try again.";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (message.trim().length === 0) return fallback;
  return isTransportNoise(message) ? transient : message;
}
