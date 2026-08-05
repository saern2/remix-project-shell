/**
 * The passwordless migration must EXTEND the access-secret and device systems,
 * not replace them.
 *
 * Those two already existed and were deliberate: secrets are per-person and
 * hashed, and five trusted browsers is enforced by the schema. The migration
 * adds a trust window, a constant-time comparison and the emailed-code tables
 * around them. These assertions are what stops a later edit from quietly
 * rebuilding either one.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807000001_passwordless_sign_in.sql"),
  "utf8",
);
const lower = migration.toLowerCase();

describe("the five-browser limit is preserved, not reinvented", () => {
  it("does not touch max_activations or the activation counter", () => {
    // The limit lives in user_access_secrets.max_activations (check = 5). If the
    // migration alters it, the deliberate limit has been changed by accident.
    expect(lower).not.toMatch(/alter\s+table\s+public\.user_access_secrets[\s\S]*max_activations/);
    expect(lower).not.toMatch(/drop\s+constraint[^;]*max_activations/);
  });

  it("keeps 'exhausted' as the sixth-device outcome", () => {
    expect(lower).toContain("'exhausted'");
    expect(lower).toContain("activation_count >= v_secret.max_activations");
  });

  it("still increments the counter exactly once per new browser", () => {
    expect(lower).toContain("activation_count = uas.activation_count + 1");
  });

  it("does not create a second device table", () => {
    // Trusted devices stay in access_activations. A parallel table would be two
    // sources of truth for the same five slots.
    expect(lower).not.toMatch(/create\s+table\s+.*trusted_devices/);
    expect(lower).toContain("alter table public.access_activations");
  });

  it("does not rebuild the secrets table or re-hash anything", () => {
    // Secrets are ALREADY hashed (HMAC-SHA256 with the pepper). A migration that
    // touched secret_hash would be a sign someone assumed otherwise.
    expect(lower).not.toMatch(/update\s+public\.user_access_secrets\s+set\s+secret_hash/);
    expect(lower).not.toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.user_access_secrets/);
  });
});

describe("trusted-device expiry", () => {
  it("adds the column without expiring anyone retroactively", () => {
    expect(lower).toContain("add column if not exists trusted_until");
    // Existing browsers get a fresh window rather than being invalidated —
    // nobody who can sign in today is asked to re-verify by this migration.
    expect(lower).toContain("where revoked_at is null");
    expect(lower).toMatch(/set trusted_until = now\(\) \+ interval '60 days'/);
  });

  it("treats a NULL window as still trusted", () => {
    // Rows written before the column existed mean "no expiry".
    expect(lower).toContain("a.trusted_until is null or a.trusted_until > now()");
  });
});

describe("constant-time comparison", () => {
  it("no longer compares the digests with <>", () => {
    expect(migration).not.toContain("v_secret.secret_hash <> p_secret_hash");
  });

  it("XORs every byte and folds the result", () => {
    // bit_or over all 64 positions: the answer does not depend on where the
    // first difference is.
    expect(lower).toContain("bit_or");
    expect(lower).toContain("generate_series(0, 63)");
    expect(lower).toContain("get_byte");
  });
});

describe("revocation kills devices and codes", () => {
  it("installs a trigger so revocation holds however it happens", () => {
    expect(lower).toContain("revoke_activations_with_secret");
    expect(lower).toContain("after update on public.user_access_secrets");
  });

  it("revokes activations and invalidates live codes together", () => {
    expect(lower).toContain("update public.access_activations");
    expect(lower).toContain("update public.auth_login_codes");
    expect(lower).toContain("new.status = 'revoked'");
  });

  it("only fires on the transition into revoked", () => {
    // Without the old-status guard, every update to a revoked secret would
    // re-run the revocation writes.
    expect(lower).toContain("coalesce(old.status, '') <> 'revoked'");
  });
});

describe("the code table enforces what Supabase does not", () => {
  it("holds attempts, a ceiling, expiry, single use and invalidation", () => {
    for (const column of [
      "attempts",
      "max_attempts",
      "expires_at",
      "consumed_at",
      "invalidated_at",
    ]) {
      expect(lower).toContain(column);
    }
  });

  it("allows only one live code per user per browser", () => {
    // This is what makes "a new request invalidates the previous one"
    // enforceable rather than merely intended.
    expect(lower).toContain("auth_login_codes_live_unique");
    expect(lower).toContain("where consumed_at is null and invalidated_at is null");
  });

  it("stores a code hash when it stores a code at all", () => {
    expect(lower).toContain(
      "code_hash text check (code_hash is null or char_length(code_hash) = 64)",
    );
  });

  it("binds a code to the browser that asked for it", () => {
    // A code lifted from an inbox is useless from a different browser.
    expect(lower).toContain("client_token_hash text not null");
  });

  it("keeps both new tables service-role only", () => {
    expect(lower).toContain(
      "revoke all on public.auth_login_codes from public, anon, authenticated",
    );
    expect(lower).toContain(
      "revoke all on public.auth_login_failures from public, anon, authenticated",
    );
  });
});

describe("the failure log records who, never what", () => {
  it("stores the email, the IP and the stage — and no credential column", () => {
    const table = migration.slice(
      migration.indexOf("create table if not exists public.auth_login_failures"),
      migration.indexOf("create index if not exists auth_login_failures_email_idx"),
    );
    // Comments stripped: the point is that no COLUMN holds a credential, and
    // the stage column's comment legitimately names the two screens.
    const columns = table
      .split("\n")
      .map((line) => line.replace(/--.*$/, "").trim())
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    expect(columns).toContain("email_normalized");
    expect(columns).toContain("ip_address");
    expect(columns).toContain("stage");
    expect(columns).not.toMatch(/secret|code|password|credential/);
  });
});
