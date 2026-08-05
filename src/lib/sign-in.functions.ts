/**
 * The three-screen sign-in.
 *
 * Screen 1 (email) makes NO call — see sign-in.server.ts for why that is the
 * strongest form of "never reveal registration status".
 *
 * Screen 2 calls verifyAccessCredential. It is UNAUTHENTICATED by necessity: the
 * secret is checked before any session exists. That makes it the one endpoint
 * worth guessing at, which is why every path through it is rate limited, logged,
 * and returns the same shape for "wrong secret", "no such email" and "no secret
 * issued".
 *
 * Screen 3 calls verifyLoginCode, and only ever appears when screen 2 said
 * code_sent.
 *
 * WHAT THIS DOES NOT REBUILD. Access secrets, their hashing, and the five-browser
 * limit all already existed and are used as they are. The emailed code sits in
 * front of activate_access_secret, which is still the only thing that creates an
 * activation — so a browser that passes the code becomes one of the same five,
 * and the sixth still gets 'exhausted'.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import {
  clientIpFrom,
  credentialLockPolicy,
  evaluateCode,
  isLockedOut,
  loginCodeMaxAttempts,
  loginCodeRequestLimit,
  loginCodeTtlMinutes,
  normalizeEmail,
  timingSafeEqualHex,
  trustedDeviceDays,
  type CredentialOutcome,
} from "@/lib/sign-in.server";

const emailSchema = z.string().trim().email().max(254);

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Records a failure. Never receives, and so can never log, the value that was tried. */
async function recordFailure(email: string | null, stage: "secret" | "code") {
  const ip = clientIpFrom(getRequest()?.headers);
  const supabaseAdmin = await admin();
  await supabaseAdmin
    .from("auth_login_failures")
    .insert({ email_normalized: email, ip_address: ip, stage })
    .then(undefined, () => undefined);
  console.warn("[sign-in] failed attempt", { email, ip, stage });
}

/** Failure counts for this email and this IP over the lock window. */
async function recentFailures(email: string): Promise<number> {
  const { lockMinutes } = credentialLockPolicy();
  const since = new Date(Date.now() - lockMinutes * 60_000).toISOString();
  const ip = clientIpFrom(getRequest()?.headers);
  const supabaseAdmin = await admin();

  const [byEmail, byIp] = await Promise.all([
    supabaseAdmin
      .from("auth_login_failures")
      .select("id", { count: "exact", head: true })
      .eq("email_normalized", email)
      .gte("created_at", since),
    ip
      ? supabaseAdmin
          .from("auth_login_failures")
          .select("id", { count: "exact", head: true })
          .eq("ip_address", ip)
          .gte("created_at", since)
      : Promise.resolve({ count: 0 }),
  ]);

  // Whichever limit is hit first wins: an attacker rotating emails is caught by
  // the IP count, and one rotating IPs is caught by the email count.
  return Math.max(byEmail.count ?? 0, (byIp as { count: number | null }).count ?? 0);
}

/**
 * Mints a Supabase session for a user who has proved themselves without a
 * password.
 *
 * generateLink produces the token without sending mail, so a trusted browser
 * signing in costs no email quota — which matters a great deal while delivery is
 * the built-in service.
 */
async function mintSession(
  email: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const supabaseAdmin = await admin();
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const hashedToken = data?.properties?.hashed_token;
  if (error || !hashedToken) {
    console.error("[sign-in] could not mint a session", { email, error: error?.message });
    return null;
  }
  const { data: verified, error: verifyError } = await supabaseAdmin.auth.verifyOtp({
    token_hash: hashedToken,
    type: "magiclink",
  });
  if (verifyError || !verified.session) {
    console.error("[sign-in] session exchange failed", { email, error: verifyError?.message });
    return null;
  }
  return {
    accessToken: verified.session.access_token,
    refreshToken: verified.session.refresh_token,
  };
}

/**
 * Asks the delivery provider to send a code.
 *
 * With Supabase's built-in email service the code is Supabase's own OTP: that
 * service can only send Auth's templated emails, so a code we generated could
 * not be delivered at all. Supabase hashes and expires it; the request rate
 * limit, the attempt ceiling and single use are enforced by auth_login_codes
 * around it. Set Auth -> Email OTP Expiration to match LOGIN_CODE_TTL_MINUTES.
 *
 * Swapping to a transactional provider means changing this function and storing
 * a code_hash — the column and the policy are already in place.
 */
async function deliverCode(email: string): Promise<{ ok: boolean; message?: string }> {
  const supabaseAdmin = await admin();
  const { error } = await supabaseAdmin.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) {
    // Surfaced to the user rather than swallowed: a silent delivery failure here
    // locks someone out with no way to tell why.
    console.error("[sign-in] code delivery failed", { email, error: error.message });
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

/**
 * Screen 2. One credential field, two kinds of credential.
 *
 * Administrators keep email + password — that path is what they use today and is
 * deliberately unchanged, so the account that issues access secrets cannot be
 * locked out by a change to the access-secret flow. The screen looks identical
 * either way, so which kind of account an address belongs to is not observable.
 */
export const verifyAccessCredential = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        email: emailSchema,
        credential: z.string().min(1).max(300),
        clientToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<CredentialOutcome> => {
    const email = normalizeEmail(data.email);
    const { lockMinutes } = credentialLockPolicy();

    if (isLockedOut(await recentFailures(email))) {
      return { outcome: "locked", retryAfterMinutes: lockMinutes };
    }

    const supabaseAdmin = await admin();
    const access = await import("@/lib/access-control.server");

    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id, email, role, approval_status")
      .eq("email", email)
      .maybeSingle();

    // Unknown address: the same answer a wrong secret gets. The failure is still
    // recorded, so guessing addresses is rate limited exactly like guessing
    // secrets.
    if (!user) {
      await recordFailure(email, "secret");
      return { outcome: "denied" };
    }

    // ── Administrators: email + password, as today ─────────────────────────
    if (user.role === "admin") {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!url || !key) throw new Error("Supabase is not configured.");
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: signedIn, error } = await client.auth.signInWithPassword({
        email,
        password: data.credential,
      });
      if (error || !signedIn.session) {
        await recordFailure(email, "secret");
        return { outcome: "denied" };
      }
      if (user.approval_status !== "approved") {
        return { outcome: user.approval_status === "rejected" ? "rejected" : "pending" };
      }
      return {
        outcome: "signed_in",
        accessToken: signedIn.session.access_token,
        refreshToken: signedIn.session.refresh_token,
      };
    }

    // ── Regular users: access secret ───────────────────────────────────────
    const { data: secretRow } = await supabaseAdmin
      .from("user_access_secrets")
      .select("id, secret_hash, status")
      .eq("user_id", user.id)
      .in("status", ["active", "exhausted"])
      .maybeSingle();

    const candidateHash = access.secureHash(data.credential);
    // No secret issued yet is indistinguishable from a wrong one. Compared
    // against a dummy of equal length so the no-secret case takes the same path.
    const storedHash = secretRow?.secret_hash ?? "0".repeat(64);
    if (!secretRow || !timingSafeEqualHex(storedHash, candidateHash)) {
      await recordFailure(email, "secret");
      return { outcome: "denied" };
    }

    // Correct secret. Only now is it safe to say anything about the account —
    // before this point, status would have been a probe for valid addresses.
    if (user.approval_status !== "approved") {
      return { outcome: user.approval_status === "rejected" ? "rejected" : "pending" };
    }

    // Already-trusted browser: straight in, no code, no activation consumed.
    const clientTokenHash = access.secureHash(data.clientToken);
    const { data: trusted } = await supabaseAdmin.rpc("check_access_activation", {
      p_user_id: user.id,
      p_client_token_hash: clientTokenHash,
    });
    if (trusted === true) {
      const session = await mintSession(email);
      if (!session) return { outcome: "delivery_failed", message: "Sign-in failed. Try again." };
      access.writeTrustedClientToken(data.clientToken);
      // Refreshes last_seen_at and the trust window; returns 'trusted' without
      // taking one of the five slots.
      await supabaseAdmin.rpc("activate_access_secret", {
        p_user_id: user.id,
        p_secret_hash: candidateHash,
        p_client_token_hash: clientTokenHash,
      });
      return { outcome: "signed_in", ...session };
    }

    // A new browser cannot become trusted if all five slots are taken. Say so
    // now rather than after the user has fetched a code they cannot use.
    if (secretRow.status === "exhausted") {
      return { outcome: "device_limit_reached" };
    }

    // ── New browser: send a code ───────────────────────────────────────────
    const { maxRequests, windowMinutes } = loginCodeRequestLimit();
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    const { count: requestsInWindow } = await supabaseAdmin
      .from("auth_login_codes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", since);
    if ((requestsInWindow ?? 0) >= maxRequests) {
      return { outcome: "locked", retryAfterMinutes: windowMinutes };
    }

    // A new request supersedes the old one, so an intercepted earlier code is
    // dead the moment a fresh one is asked for.
    await supabaseAdmin
      .from("auth_login_codes")
      .update({ invalidated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("consumed_at", null)
      .is("invalidated_at", null);

    const delivery = await deliverCode(email);
    if (!delivery.ok) {
      return {
        outcome: "delivery_failed",
        message: "We couldn't send your code right now. Try again in a moment.",
      };
    }

    const { error: codeError } = await supabaseAdmin.from("auth_login_codes").insert({
      user_id: user.id,
      email_normalized: email,
      client_token_hash: clientTokenHash,
      max_attempts: loginCodeMaxAttempts(),
      expires_at: new Date(Date.now() + loginCodeTtlMinutes() * 60_000).toISOString(),
    });
    if (codeError) throw new Error("Could not start verification. Try again.");

    return { outcome: "code_sent" };
  });

/**
 * Screen 3. Verifies the emailed code and, on success, makes this browser one of
 * the five trusted ones through the existing activation RPC.
 */
export const verifyLoginCode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        email: emailSchema,
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/),
        credential: z.string().min(1).max(300),
        clientToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const email = normalizeEmail(data.email);
    const supabaseAdmin = await admin();
    const access = await import("@/lib/access-control.server");

    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id, approval_status, role")
      .eq("email", email)
      .maybeSingle();
    if (!user || user.approval_status !== "approved") {
      await recordFailure(email, "code");
      return { outcome: "denied" as const };
    }

    const clientTokenHash = access.secureHash(data.clientToken);
    const { data: codeRow } = await supabaseAdmin
      .from("auth_login_codes")
      .select("id, attempts, max_attempts, expires_at, consumed_at, invalidated_at")
      .eq("user_id", user.id)
      .eq("client_token_hash", clientTokenHash)
      .is("consumed_at", null)
      .is("invalidated_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) return { outcome: "expired" as const };

    const verdict = evaluateCode({
      expiresAt: codeRow.expires_at,
      attempts: codeRow.attempts,
      maxAttempts: codeRow.max_attempts,
      consumedAt: codeRow.consumed_at,
      invalidatedAt: codeRow.invalidated_at,
    });
    if (verdict === "too-many-attempts") return { outcome: "too_many_attempts" as const };
    if (verdict !== "usable") return { outcome: "expired" as const };

    // The code itself is Supabase's OTP while the built-in email service is the
    // transport, so Supabase is what verifies it — and a correct code returns a
    // session directly.
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Supabase is not configured.");
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: verified, error } = await client.auth.verifyOtp({
      email,
      token: data.code,
      type: "email",
    });

    if (error || !verified.session) {
      const attempts = codeRow.attempts + 1;
      await supabaseAdmin
        .from("auth_login_codes")
        .update({
          attempts,
          // Burn the code at the ceiling rather than leaving it attemptable.
          invalidated_at:
            attempts >= codeRow.max_attempts ? new Date().toISOString() : codeRow.invalidated_at,
        })
        .eq("id", codeRow.id);
      await recordFailure(email, "code");
      return {
        outcome:
          attempts >= codeRow.max_attempts ? ("too_many_attempts" as const) : ("wrong" as const),
        attemptsRemaining: Math.max(0, codeRow.max_attempts - attempts),
      };
    }

    // Single use.
    await supabaseAdmin
      .from("auth_login_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", codeRow.id);

    // Now, and only now, does this browser take one of the five slots. The
    // existing RPC decides — including returning 'exhausted' for the sixth.
    const { data: rows } = await supabaseAdmin.rpc("activate_access_secret", {
      p_user_id: user.id,
      p_secret_hash: access.secureHash(data.credential),
      p_client_token_hash: clientTokenHash,
    });
    const activation = Array.isArray(rows) ? rows[0] : rows;
    if (!activation || !["activated", "trusted"].includes(activation.outcome)) {
      return {
        outcome:
          activation?.outcome === "exhausted"
            ? ("device_limit_reached" as const)
            : ("denied" as const),
      };
    }

    access.writeTrustedClientToken(data.clientToken);
    return {
      outcome: "signed_in" as const,
      accessToken: verified.session.access_token,
      refreshToken: verified.session.refresh_token,
      trustedForDays: trustedDeviceDays(),
    };
  });

/** Screen 3's "send it again" — the same request limit applies. */
export const resendLoginCode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ email: emailSchema }).parse(input))
  .handler(async ({ data }) => {
    const email = normalizeEmail(data.email);
    const supabaseAdmin = await admin();
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    // Silent for an unknown address: this endpoint must not become a way to test
    // which addresses are registered.
    if (!user) return { outcome: "code_sent" as const };

    const { maxRequests, windowMinutes } = loginCodeRequestLimit();
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    const { count } = await supabaseAdmin
      .from("auth_login_codes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", since);
    if ((count ?? 0) >= maxRequests) {
      return { outcome: "locked" as const, retryAfterMinutes: windowMinutes };
    }

    const delivery = await deliverCode(email);
    if (!delivery.ok) {
      return {
        outcome: "delivery_failed" as const,
        message: "We couldn't send your code right now. Try again in a moment.",
      };
    }
    return { outcome: "code_sent" as const };
  });
