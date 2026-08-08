import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AlertTriangle, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeFreezeImpact } from "@/lib/maintenance";
import { pollWithAuthRetry } from "@/lib/auth-retry.browser";
import { getMaintenanceState, setMaintenanceState } from "@/lib/maintenance.functions";

/**
 * The maintenance toggle.
 *
 * Three things it has to get right, all of them about not surprising the
 * operator: say what turning it on will interrupt BEFORE it happens, say when
 * the environment variable is overriding the toggle rather than letting the
 * switch silently disagree with reality, and list what is frozen so a project
 * that fails to come back is visible rather than merely absent.
 */
export function MaintenancePanel() {
  const queryClient = useQueryClient();
  const fetchState = useServerFn(getMaintenanceState);
  const setState = useServerFn(setMaintenanceState);

  const { data, isLoading } = useQuery({
    queryKey: ["maintenance-state"],
    queryFn: () => pollWithAuthRetry(() => fetchState()),
    refetchInterval: 10_000,
  });

  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Maintenance mode</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Uncontrolled until the operator types, so a background refetch cannot wipe
  // what they are part-way through writing.
  const messageValue = message ?? data.message ?? "";

  const apply = async (enabled: boolean) => {
    setSaving(true);
    try {
      const result = await setState({ data: { enabled, message: messageValue || null } });
      await queryClient.invalidateQueries({ queryKey: ["maintenance-state"] });
      setMessage(null);

      // A half-applied freeze — users blocked while the worker keeps rendering
      // — is the worst of both, so a failed push is reported rather than
      // swallowed behind a success toast.
      if (!result.workerSynced) {
        toast.warning(
          `Saved, but the render worker did not confirm: ${result.workerError ?? "unreachable"}. Set MAINTENANCE_MODE on the worker if it stays out of sync.`,
        );
      } else {
        toast.success(enabled ? "Maintenance mode is on." : "Maintenance mode is off.");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  const impact = describeFreezeImpact({
    rendering: data.renderingCount ?? 0,
    matching: data.matchingCount,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="h-4 w-4" />
              Maintenance mode
            </CardTitle>
            <CardDescription>
              Freezes render and matching work. Users keep read-only access; admins are unaffected.
            </CardDescription>
          </div>
          <Badge variant={data.enabled ? "destructive" : "secondary"}>
            {data.enabled ? "ON" : "Off"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {data.overridden ? (
          // The toggle would otherwise sit in a position that does not match
          // reality, and the operator would have no way to tell.
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              The <code className="font-mono">MAINTENANCE_MODE</code> environment variable is set to{" "}
              <strong>{String(data.envOverride)}</strong> and is overriding this toggle. The switch
              below still records your intent — it takes effect once the variable is unset.
            </span>
          </div>
        ) : null}

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Source" value={data.source === "env" ? "Environment" : "Dashboard"} />
          <Stat
            label="Enabled by"
            value={data.enabled ? (data.enabledBy ? "An admin" : "—") : "—"}
          />
          <Stat
            label="Since"
            value={data.enabledAt ? new Date(data.enabledAt).toLocaleString() : "—"}
          />
          <Stat label="Frozen projects" value={String(data.frozenProjects.length)} />
        </dl>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="maintenance-message">
            Message shown to users (optional)
          </label>
          <Input
            id="maintenance-message"
            placeholder="Back at 3pm"
            maxLength={200}
            value={messageValue}
            onChange={(event) => setMessage(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to give no estimate. Blank is better than a guess.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {data.enabled ? (
            <Button onClick={() => apply(false)} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Turn maintenance off
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => setConfirming(true)} disabled={saving}>
              Turn maintenance on
            </Button>
          )}
          {data.enabled ? (
            <Button variant="outline" onClick={() => apply(true)} disabled={saving}>
              Update message
            </Button>
          ) : null}
        </div>

        {data.frozenProjects.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Frozen projects</p>
            {/* The list is not cleared when maintenance ends — each job takes
                its own entry down as it resumes, so anything still here a few
                minutes later is a project that did not come back. */}
            <ul className="divide-y rounded-md border text-sm">
              {data.frozenProjects.map((project) => (
                <li key={project.projectId} className="flex flex-wrap gap-x-3 gap-y-1 p-3">
                  <span className="font-mono text-xs">{project.projectId.slice(0, 8)}</span>
                  <span className="text-muted-foreground">{project.phase}</span>
                  {project.chunkIndex != null && project.chunksTotal != null ? (
                    <span className="text-muted-foreground">
                      segment {project.chunkIndex + 1} of {project.chunksTotal}
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    since {new Date(project.frozenAt).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn maintenance mode on?</AlertDialogTitle>
            <AlertDialogDescription>
              {impact} Users can still sign in, browse their projects and download finished videos.
              You keep full access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => apply(true)} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Turn it on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
