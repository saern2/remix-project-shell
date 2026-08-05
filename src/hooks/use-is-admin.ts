import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { amIAdmin } from "@/lib/admin.functions";

export const AM_I_ADMIN_QUERY_KEY = ["am-i-admin"] as const;

/**
 * Whether the signed-in account is an administrator.
 *
 * Shared so the nav and the project-limit notice read the same cached answer
 * rather than each issuing their own request — and, more importantly, so they
 * cannot disagree about it.
 *
 * `isAdmin` is false while loading. Every caller here uses it to RELAX a
 * restriction, so the pessimistic default shows the ordinary path for a moment
 * and then lifts, rather than flashing an admin affordance that vanishes.
 */
export function useIsAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const checkAdmin = useServerFn(amIAdmin);
  const { data, isPending } = useQuery({
    queryKey: AM_I_ADMIN_QUERY_KEY,
    queryFn: () => checkAdmin({}),
    retry: false,
    staleTime: 60_000,
  });
  return { isAdmin: data?.isAdmin === true, isLoading: isPending };
}
