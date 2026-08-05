import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  requireSupabaseAuth,
  requireSupabaseIdentity,
} from "@/integrations/supabase/auth-middleware";

type SupabaseAdminClient =
  (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];

const waitlistSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(8).max(20),
  email: z.string().trim().email().max(254),
});

const passwordRecoverySchema = z.object({
  email: z.string().trim().email().max(254),
});

const PASSWORD_RECOVERY_COOLDOWN_MINUTES = 15;

function normalizePhone(value: string) {
  const normalized = value.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("Enter a valid phone number including its country code.");
  }
  return normalized;
}

export const submitAccessRequest = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => waitlistSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.toLowerCase();
    const { error } = await supabaseAdmin.from("access_requests").insert({
      full_name: data.fullName,
      phone_e164: normalizePhone(data.phone),
      email_normalized: email,
    });
    if (error && error.code !== "23505") throw new Error("Unable to submit the request right now.");
    return { accepted: true as const };
  });

export const requestAdminPasswordRecovery = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => passwordRecoverySchema.parse(input))
  .handler(async ({ data }) => {
    const genericResult = { accepted: true as const };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.toLowerCase();
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .select("id,role,approval_status")
      .eq("email", email)
      .eq("role", "admin")
      .eq("approval_status", "approved")
      .maybeSingle();

    if (profileError || !profile) return genericResult;

    const cooldownStart = new Date(
      Date.now() - PASSWORD_RECOVERY_COOLDOWN_MINUTES * 60 * 1000,
    ).toISOString();
    const { count, error: cooldownError } = await supabaseAdmin
      .from("access_security_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "admin_password_recovery_requested")
      .eq("user_id", profile.id)
      .gte("created_at", cooldownStart);

    if (cooldownError || (count ?? 0) > 0) return genericResult;

    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      console.error("[admin-password-recovery] APP_URL is not configured.");
      return genericResult;
    }

    const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl.replace(/\/$/, "")}/auth`,
    });
    if (resetError) {
      console.error("[admin-password-recovery] Supabase delivery failed:", resetError.message);
      return genericResult;
    }

    const { error: auditError } = await supabaseAdmin.from("access_security_events").insert({
      event_type: "admin_password_recovery_requested",
      user_id: profile.id,
      metadata: { delivery: "supabase_email" },
    });
    if (auditError) {
      console.error("[admin-password-recovery] Audit write failed:", auditError.message);
    }
    return genericResult;
  });

export const getAccessGateStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseIdentity])
  .handler(async ({ context }) => {
    const { hasTrustedAccess } = await import("@/lib/access-control.server");
    const isApproved = context.profile?.approval_status === "approved";
    const isAdmin = context.profile?.role === "admin";
    const hasAccess = isApproved && (isAdmin || (await hasTrustedAccess(context.userId)));
    return {
      approvalStatus: context.profile?.approval_status ?? "pending",
      hasAccess,
    };
  });

export const activateAccessSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseIdentity])
  .inputValidator((input: unknown) =>
    z.object({ secret: z.string().trim().min(20).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    if (context.profile?.approval_status !== "approved") {
      throw new Error("Access is not available for this account.");
    }
    const access = await import("@/lib/access-control.server");
    const clientToken = access.readTrustedClientToken() ?? access.generateClientToken();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin.rpc("activate_access_secret", {
      p_user_id: context.userId,
      p_secret_hash: access.secureHash(data.secret),
      p_client_token_hash: access.secureHash(clientToken),
    });
    if (error) throw new Error("Access verification failed.");
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (!result || !["activated", "trusted"].includes(result.outcome)) {
      const message =
        result?.outcome === "rate_limited"
          ? "Too many attempts. Try again in 15 minutes."
          : result?.outcome === "exhausted"
            ? "This access secret has reached its activation limit."
            : "The access secret could not be verified.";
      throw new Error(message);
    }
    access.writeTrustedClientToken(clientToken);
    return {
      ok: true as const,
      activationCount: result.activation_count,
      maxActivations: result.max_activations,
    };
  });

async function assertAdmin(context: { profile?: { role?: string | null } | null }) {
  if (context.profile?.role !== "admin") throw new Error("Forbidden.");
}

async function findAuthUserByEmail(supabaseAdmin: SupabaseAdminClient, email: string) {
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 1000) return null;
  }
  throw new Error("Unable to safely resolve the applicant's authentication account.");
}

export const listAccessAdministration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [requests, secrets, events, devices, failures] = await Promise.all([
      supabaseAdmin.from("access_requests").select("*").order("created_at", { ascending: false }),
      supabaseAdmin
        .from("user_access_secrets")
        .select(
          "id,user_id,secret_suffix,status,activation_count,max_activations,created_at,last_used_at,revoked_at,revocation_reason,failed_attempt_count,failed_window_started_at",
        )
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("access_security_events")
        .select("id,event_type,user_id,actor_user_id,metadata,created_at")
        .order("created_at", { ascending: false })
        .limit(100),
      // Live trusted browsers. client_token_hash is deliberately NOT selected —
      // it is the device credential, and an admin never needs to see it to
      // revoke one.
      supabaseAdmin
        .from("access_activations")
        .select("id,user_id,secret_id,created_at,last_seen_at,trusted_until")
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false }),
      supabaseAdmin
        .from("auth_login_failures")
        .select("email_normalized,stage,created_at")
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    for (const result of [requests, secrets, events, devices, failures]) {
      if (result.error) throw new Error(result.error.message);
    }
    return {
      requests: requests.data ?? [],
      secrets: secrets.data ?? [],
      events: events.data ?? [],
      devices: devices.data ?? [],
      failures: failures.data ?? [],
    };
  });

export const reviewAccessRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ requestId: z.string().uuid(), decision: z.enum(["approved", "rejected"]) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: request, error } = await supabaseAdmin
      .from("access_requests")
      .select("*")
      .eq("id", data.requestId)
      .eq("status", "pending")
      .maybeSingle();
    if (error || !request) throw new Error("This request is no longer pending.");

    let userId: string | null = request.user_id;
    if (data.decision === "approved") {
      const { data: existing } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("email", request.email_normalized)
        .maybeSingle();
      userId = existing?.id ?? null;
      if (!userId) {
        const existingAuthUser = await findAuthUserByEmail(supabaseAdmin, request.email_normalized);
        userId = existingAuthUser?.id ?? null;
      }
      if (!userId) {
        const appUrl = process.env.APP_URL;
        if (!appUrl) throw new Error("APP_URL is required to send approval invitations.");
        const { data: invited, error: inviteError } =
          await supabaseAdmin.auth.admin.inviteUserByEmail(request.email_normalized, {
            redirectTo: `${appUrl.replace(/\/$/, "")}/auth`,
            data: {
              full_name: request.full_name,
              phone_e164: request.phone_e164,
              needs_password_setup: true,
            },
          });
        if (inviteError || !invited.user)
          throw new Error(inviteError?.message ?? "Invitation failed.");
        userId = invited.user.id;
      }
      const { error: userError } = await supabaseAdmin.from("users").upsert({
        id: userId,
        email: request.email_normalized,
        full_name: request.full_name,
        phone_e164: request.phone_e164,
        approval_status: "approved",
      });
      if (userError) throw new Error(userError.message);
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("access_requests")
      .update({
        status: data.decision,
        user_id: userId,
        reviewed_by: context.userId,
        reviewed_at: now,
        updated_at: now,
      })
      .eq("id", request.id)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);
    await supabaseAdmin.from("access_security_events").insert({
      event_type: `request_${data.decision}`,
      user_id: userId,
      request_id: request.id,
      actor_user_id: context.userId,
    });
    return { ok: true as const };
  });

export const issueUserAccessSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ userId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("approval_status,role")
      .eq("id", data.userId)
      .maybeSingle();
    if (user?.approval_status !== "approved")
      throw new Error("Approve the user before issuing access.");
    // Administrators sign in with email + password, so they do not NEED a
    // secret — but nothing should refuse them one either, and an admin who also
    // uses the workspace as a normal user does.
    const { count } = await supabaseAdmin
      .from("user_access_secrets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", data.userId)
      .in("status", ["active", "exhausted"]);
    if ((count ?? 0) > 0)
      throw new Error("Revoke the existing access secret before issuing another.");

    const access = await import("@/lib/access-control.server");
    const secret = access.generateAccessSecret();
    const { data: created, error } = await supabaseAdmin
      .from("user_access_secrets")
      .insert({
        user_id: data.userId,
        secret_hash: access.secureHash(secret),
        secret_suffix: secret.slice(-4),
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("access_security_events").insert({
      event_type: "secret_issued",
      user_id: data.userId,
      secret_id: created.id,
      actor_user_id: context.userId,
    });
    return { secret };
  });

export const revokeUserAccessSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ secretId: z.string().uuid(), reason: z.string().trim().min(3).max(200) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: secret, error } = await supabaseAdmin
      .from("user_access_secrets")
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
        revoked_by: context.userId,
        revocation_reason: data.reason,
      })
      .eq("id", data.secretId)
      .in("status", ["active", "exhausted"])
      .select("id,user_id")
      .maybeSingle();
    if (error || !secret) throw new Error("The secret is already revoked or does not exist.");
    // The migration installs a trigger that does this too. Kept here as well so
    // revocation holds regardless of which layer runs first, and so the effect
    // is visible at the call site rather than only in the schema.
    await supabaseAdmin
      .from("access_activations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("secret_id", secret.id)
      .is("revoked_at", null);
    await supabaseAdmin
      .from("auth_login_codes")
      .update({ invalidated_at: new Date().toISOString() })
      .eq("user_id", secret.user_id)
      .is("consumed_at", null)
      .is("invalidated_at", null);
    // Kills live sessions: without this a revoked user keeps working until
    // their JWT expires, which is up to an hour of access after revocation.
    await supabaseAdmin.auth.admin
      .signOut(secret.user_id, "global")
      .then(undefined, () => undefined);
    await supabaseAdmin.from("access_security_events").insert({
      event_type: "secret_revoked",
      user_id: secret.user_id,
      secret_id: secret.id,
      actor_user_id: context.userId,
      metadata: { reason: data.reason },
    });
    return { ok: true as const };
  });

export const resetUserAccessSecretActivations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ secretId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: reset, error } = await supabaseAdmin.rpc("reset_access_secret_activations", {
      p_actor_user_id: context.userId,
      p_secret_id: data.secretId,
    });
    if (error) throw new Error(error.message);
    if (!reset) throw new Error("This access secret is no longer usable.");
    return { ok: true as const };
  });

/**
 * Revokes one trusted browser, or every one, for a user.
 *
 * Distinct from resetUserAccessSecretActivations, which resets the FIVE-slot
 * counter as a recovery action. This is the targeted version: an admin who
 * knows a specific laptop is gone should not have to make everyone else
 * re-verify.
 */
export const revokeTrustedDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        userId: z.string().uuid(),
        // Omit to revoke every browser for this user.
        activationId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = new Date().toISOString();

    let query = supabaseAdmin
      .from("access_activations")
      .update({ revoked_at: now })
      .eq("user_id", data.userId)
      .is("revoked_at", null);
    if (data.activationId) query = query.eq("id", data.activationId);

    const { data: revoked, error } = await query.select("id");
    if (error) throw new Error(error.message);

    // A revoked browser must stop working now, not when its JWT happens to
    // expire. Revoking every device signs the user out everywhere.
    if (!data.activationId) {
      await supabaseAdmin.auth.admin
        .signOut(data.userId, "global")
        .then(undefined, () => undefined);
    }

    await supabaseAdmin.from("access_security_events").insert({
      event_type: "trusted_devices_revoked",
      user_id: data.userId,
      actor_user_id: context.userId,
      metadata: { revoked: revoked?.length ?? 0, scope: data.activationId ? "one" : "all" },
    });
    return { ok: true as const, revoked: revoked?.length ?? 0 };
  });
