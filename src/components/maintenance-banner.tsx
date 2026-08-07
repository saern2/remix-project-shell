import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Wrench } from "lucide-react";

import { describeMaintenanceNotice } from "@/lib/maintenance";
import { getMaintenanceState } from "@/lib/maintenance.functions";
import { cn } from "@/lib/utils";

/**
 * The banner every signed-in page carries while maintenance is on.
 *
 * Rendered in the shell rather than per-page for one reason: the admin failure
 * mode is forgetting maintenance is on and leaving everyone else frozen out for
 * hours. A notice that appears on one page is a notice that can be navigated
 * away from.
 *
 * Admins get a loud amber banner because for them it is a warning; everyone
 * else gets a calm neutral one because for them nothing is wrong — their work
 * is safe and paused, which is information, not an alert.
 */
export function MaintenanceBanner() {
  const fetchState = useServerFn(getMaintenanceState);
  const { data } = useQuery({
    queryKey: ["maintenance-state"],
    queryFn: () => fetchState(),
    // Frequent enough that a user who was blocked mid-session sees the reason
    // appear, and cheap: one cached read on the server for most calls.
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  if (!data?.enabled) return null;

  const notice = describeMaintenanceNotice({ state: data, isAdmin: data.viewerIsAdmin });
  if (!notice) return null;

  const isAdmin = data.viewerIsAdmin;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 border-b px-4 py-3 text-sm",
        isAdmin
          ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-border bg-muted/60 text-muted-foreground",
      )}
    >
      {isAdmin ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <Wrench className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0">
        <p className="font-medium">{notice.headline}</p>
        <p className="mt-0.5">{notice.detail}</p>
      </div>
    </div>
  );
}
