/**
 * The browser-side binding of the auth retry policy.
 *
 * Separate from auth-retry.ts so the policy stays pure and testable; this file
 * is the only place that knows about the real Supabase client.
 */
import { supabase } from "@/integrations/supabase/client";
import { withAuthRetry } from "@/lib/auth-retry";

/**
 * Wraps a polling call so a stale token is refreshed and retried once, silently.
 *
 * Every polling call site goes through this. They all share the failure — three
 * tabs polling on the same expiring session all raised at the same instant —
 * and a fix applied to one of them would have left the others reporting a
 * recovered blip as a red error.
 */
export function pollWithAuthRetry<T>(run: () => Promise<T>): Promise<T> {
  return withAuthRetry(run, {
    refresh: () => supabase.auth.refreshSession(),
    getExpiresAt: async () => {
      // getSession reads the locally cached session; it is not a network call,
      // so checking before every poll is cheap.
      const { data } = await supabase.auth.getSession();
      return data.session?.expires_at ?? null;
    },
  });
}
