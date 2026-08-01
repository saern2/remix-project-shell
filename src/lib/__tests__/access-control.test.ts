import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cookies = vi.hoisted(() => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => cookies);

import {
  ACCESS_COOKIE_NAME,
  generateAccessSecret,
  readTrustedClientToken,
  secureHash,
  writeTrustedClientToken,
} from "../access-control.server";
import {
  getOrCreateTrustedClientToken,
  TRUSTED_CLIENT_HEADER,
  TRUSTED_CLIENT_STORAGE_KEY,
} from "../trusted-client";

const schemaMigration = readFileSync(
  resolve("supabase/migrations/20260801000001_approval_waitlist_access_secrets.sql"),
  "utf8",
);
const enforcementMigration = readFileSync(
  resolve("supabase/migrations/20260801000002_enforce_verified_platform_rls.sql"),
  "utf8",
);
const adminBypassMigration = readFileSync(
  resolve("supabase/migrations/20260801120000_admin_bypass_and_activation_fix.sql"),
  "utf8",
);
const activationRecoveryMigration = readFileSync(
  resolve("supabase/migrations/20260801130000_stable_browser_activation_recovery.sql"),
  "utf8",
);
const accessFunctions = readFileSync(resolve("src/lib/access.functions.ts"), "utf8");
const authRoute = readFileSync(resolve("src/routes/auth.tsx"), "utf8");
const authMiddleware = readFileSync(
  resolve("src/integrations/supabase/auth-middleware.ts"),
  "utf8",
);

describe("access control security contract", () => {
  beforeEach(() => {
    process.env.ACCESS_SECRET_PEPPER = "test-only-pepper-with-more-than-32-characters";
    vi.clearAllMocks();
    cookies.getRequest.mockReturnValue({ headers: new Headers() });
    window.localStorage.removeItem(TRUSTED_CLIENT_STORAGE_KEY);
  });

  it("generates unique high-entropy secrets and stores only deterministic hashes", () => {
    const first = generateAccessSecret();
    const second = generateAccessSecret();
    expect(first).toMatch(/^ss_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(secureHash(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(secureHash(first)).toBe(secureHash(first));
    expect(secureHash(first)).not.toContain(first);
  });

  it("keeps a hardened HttpOnly cookie as a server-side fallback", () => {
    writeTrustedClientToken("client-token");
    expect(cookies.setCookie).toHaveBeenCalledWith(
      ACCESS_COOKIE_NAME,
      "client-token",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });

  it("reuses one stable browser token across repeated server requests", () => {
    const first = getOrCreateTrustedClientToken();
    const second = getOrCreateTrustedClientToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("prefers the stable browser header over an unavailable cookie", () => {
    const token = "a".repeat(64);
    cookies.getRequest.mockReturnValue({
      headers: new Headers({ [TRUSTED_CLIENT_HEADER]: token }),
    });
    cookies.getCookie.mockReturnValue(undefined);
    expect(readTrustedClientToken()).toBe(token);
  });

  it("locks activation decisions and denies the sixth distinct client", () => {
    expect(schemaMigration).toContain("for update;");
    expect(schemaMigration).toContain("activation_count >= v_secret.max_activations");
    expect(schemaMigration).toContain("return query select 'exhausted'::text");
    expect(schemaMigration).toContain("activation_count = activation_count + 1");
    expect(schemaMigration).toContain("status = case when activation_count + 1 >= max_activations");
  });

  it("keeps security tables private and enforces one usable secret per user", () => {
    expect(schemaMigration).toContain("user_access_secrets_one_usable_per_user");
    expect(schemaMigration).toContain("where status in ('active', 'exhausted')");
    for (const table of [
      "access_requests",
      "user_access_secrets",
      "access_activations",
      "access_security_events",
    ]) {
      expect(schemaMigration).toContain(`revoke all on public.${table} from anon, authenticated`);
      expect(schemaMigration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(schemaMigration).toContain(
      "grant execute on function public.activate_access_secret(uuid, text, text) to service_role",
    );
  });

  it("adds restrictive approval and activation RLS to existing application data", () => {
    expect(enforcementMigration).toContain('create policy "Verified platform access"');
    expect(enforcementMigration).toContain("u.approval_status = 'approved'");
    expect(enforcementMigration).toContain("s.activation_count > 0");
    expect(enforcementMigration).toContain('create policy "Verified platform audio access"');
    expect(enforcementMigration).toContain('create policy "Verified platform render access"');
  });

  it("restricts password recovery delivery to approved administrators without enumeration", () => {
    expect(accessFunctions).toContain('.eq("role", "admin")');
    expect(accessFunctions).toContain('.eq("approval_status", "approved")');
    expect(accessFunctions).toContain("const genericResult = { accepted: true as const }");
    expect(accessFunctions).toContain('event_type: "admin_password_recovery_requested"');
    expect(accessFunctions).toContain("PASSWORD_RECOVERY_COOLDOWN_MINUTES");
    expect(accessFunctions).toContain("supabaseAdmin.auth.resetPasswordForEmail");
    expect(authRoute).toContain('event === "PASSWORD_RECOVERY"');
    expect(authRoute).not.toContain("supabase.auth.resetPasswordForEmail");
  });

  it("allows approved administrators through without access-secret activation", () => {
    expect(authMiddleware).toContain('identity.profile.role === "admin"');
    expect(authMiddleware).toContain('identity.profile?.approval_status === "approved"');
    expect(accessFunctions).toContain("isAdmin || (await hasTrustedAccess(context.userId))");
    expect(accessFunctions).toContain("Administrators do not require access secrets.");
    expect(authRoute).not.toContain("Initialize primary administrator access");
    expect(adminBypassMigration).toContain("u.role = 'admin'");
  });

  it("qualifies activation counters so the regular-user RPC is unambiguous", () => {
    expect(adminBypassMigration).toContain("activation_count = uas.activation_count + 1");
    expect(adminBypassMigration).toContain("when uas.activation_count + 1 >= uas.max_activations");
    expect(adminBypassMigration).toContain("returning uas.* into v_secret");
  });

  it("resets accidental activations under a row lock without rotating the secret", () => {
    expect(activationRecoveryMigration).toContain("for update;");
    expect(activationRecoveryMigration).toContain("activation_count = 0");
    expect(activationRecoveryMigration).toContain("secret_activations_reset");
    expect(activationRecoveryMigration).toContain(
      "grant execute on function public.reset_access_secret_activations(uuid, uuid) to service_role",
    );
  });

  it("validates protected requests against the authoritative Supabase user endpoint", () => {
    expect(authMiddleware).toContain("supabase.auth.getUser(token)");
    expect(authMiddleware).not.toContain("supabase.auth.getClaims(token)");
  });
});
