/**
 * User-facing sign-in copy, in its own module so the CLIENT can import it.
 *
 * sign-in.server.ts pulls in node:crypto, which cannot be bundled for the
 * browser — and the three screens need these strings. Keeping them here means
 * the server and the client render the same words rather than two sets that
 * drift apart.
 *
 * `denied` covers a wrong secret, an unknown email, and an account with no
 * secret issued. That is one string on purpose: three different messages would
 * turn the sign-in form into a way to test which addresses are registered.
 */
export const SIGN_IN_MESSAGES = {
  denied: "That access secret is not correct. Check it and try again.",
  locked: "Too many attempts. Try again in {minutes} minutes.",
  pending: "Your account is awaiting approval. You'll hear from us by email once it's reviewed.",
  rejected: "This account cannot be signed in to. Contact support if you think that's a mistake.",
  device_limit_reached:
    "You've already set up the maximum of five browsers for this account. Ask an administrator to reset your browsers, then try again.",
  code_expired: "That code has expired. Request a new one.",
  code_wrong: "That code is not correct.",
  code_dead: "Too many incorrect attempts. Request a new code.",
  delivery_failed:
    "We couldn't send your code right now. Wait a moment and try again — if it keeps failing, contact support.",
} as const;

export function lockMessage(minutes: number): string {
  return SIGN_IN_MESSAGES.locked.replace("{minutes}", String(minutes));
}
