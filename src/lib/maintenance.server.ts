/**
 * Server-side maintenance enforcement.
 *
 * THE RULE: a hidden button is not a permission. Every action the UI greys out
 * during maintenance is rejected here as well, so calling the server function
 * directly gets the same refusal. The UI and this file call the same pure
 * `decideMaintenance`, so they cannot drift.
 *
 * Read through the ADMIN client rather than the caller's RLS-scoped one. The
 * flag is not user data and the caller's own session is exactly what we are
 * deciding about; reading it through their client would make the answer depend
 * on the policies of the thing being gated.
 */
import {
  decideMaintenance,
  parseMaintenanceEnv,
  resolveMaintenanceState,
  type MaintenanceAction,
  type MaintenanceState,
} from "@/lib/maintenance";

/**
 * How long a resolved state is reused before re-reading.
 *
 * Every gated server function calls this, so an uncached read would add a query
 * to every mutation on the platform — a permanent cost for a feature that is
 * off almost always. Three seconds is short enough that a freeze takes effect
 * faster than an operator can switch tabs, and long enough that a burst of
 * calls costs one query.
 */
const STATE_CACHE_MS = 3_000;

let cached: { at: number; state: MaintenanceState } | null = null;

/** Drops the cache. Called after a toggle so the operator sees it immediately. */
export function invalidateMaintenanceCache(): void {
  cached = null;
}

export async function readMaintenanceState(): Promise<MaintenanceState> {
  const envOverride = parseMaintenanceEnv(process.env.MAINTENANCE_MODE);

  // The env var short-circuits the query entirely. That is the whole point of
  // it: it has to work when the database does not.
  if (envOverride != null && cached == null) {
    // Still try for the message and attribution, but never let a failed read
    // change the answer.
    const stored = await readStoredState().catch(() => null);
    return resolveMaintenanceState(stored, envOverride);
  }

  if (cached && Date.now() - cached.at < STATE_CACHE_MS) return cached.state;

  let stored: Awaited<ReturnType<typeof readStoredState>> = null;
  try {
    stored = await readStoredState();
  } catch (err) {
    // FAIL OPEN. An unreadable flag must not freeze the platform: a database
    // blip would otherwise take everything down, which is a far worse outcome
    // than a deploy that briefly overlaps live work. The env var is there for
    // when the operator needs a guarantee rather than a best effort.
    console.warn("[maintenance] state read failed; treating as not enabled", {
      error: (err as Error).message,
    });
    stored = null;
  }

  const state = resolveMaintenanceState(stored, envOverride);
  cached = { at: Date.now(), state };
  return state;
}

async function readStoredState() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("maintenance_state")
    .select("enabled, message, enabled_at, enabled_by")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Is the caller an admin?
 *
 * Verified against the database on every check rather than trusted from the
 * session, because "admin bypasses maintenance" is the one place where a stale
 * claim would hand a non-admin the ability to write during a migration.
 */
export async function isAdminUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    return data?.role === "admin";
  } catch {
    // Failing closed here is right, and is not the same call as failing open on
    // the flag: an unverifiable admin claim must not become a bypass.
    return false;
  }
}

/**
 * Rejects the action if maintenance forbids it.
 *
 * Throws a plain Error whose message is the user-facing sentence — the server
 * functions in this codebase surface thrown messages to the client as toasts,
 * so a blocked action explains itself instead of failing silently.
 */
export async function assertMaintenanceAllows(
  action: MaintenanceAction,
  userId: string | null | undefined,
): Promise<void> {
  const state = await readMaintenanceState();
  if (!state.enabled) return; // The overwhelmingly common path: one cached read.

  const isAdmin = await isAdminUser(userId);
  const decision = decideMaintenance({ state, action, isAdmin });
  if (!decision.allowed) throw new Error(decision.reason ?? "That action is paused for maintenance.");
}
