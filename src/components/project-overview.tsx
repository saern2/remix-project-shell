import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { addHours, formatDistanceToNow } from "date-fns";
import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FolderKanban,
  Loader2,
  Plus,
  Trash2,
  Video,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { deleteProject } from "@/lib/deleteProject";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { describeMatchingProgress, shortMatchingLabel } from "@/lib/matching-progress";
import { getMatchingProgress } from "@/lib/matching-progress.functions";
import { pollWithAuthRetry } from "@/lib/auth-retry.client";
import { Progress } from "@/components/ui/progress";
import {
  oldestProject,
  PROJECT_LIMIT,
  PROJECT_LIMIT_MESSAGE,
  projectUsage,
  summarizeProjectStatuses,
} from "@/lib/project-limit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { toast } from "sonner";

export type ProjectSummary = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
};

export const PROJECTS_QUERY_KEY = ["projects"] as const;
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  uploading: "Uploading",
  uploaded: "Uploaded",
  transcribing: "Transcribing",
  generating_scenes: "Generating scenes",
  matching_footage: "Matching footage",
  ready: "Ready",
  rendering: "Rendering",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async (): Promise<ProjectSummary[]> => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, status, created_at, updated_at, error_message")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as ProjectSummary[];
    },
  });
}

/**
 * Always navigable. Being at the limit is surfaced by the notice below and on
 * the new-project page, which offers to free a slot in place — disabling the
 * button here just left the user with nowhere to go and nothing to click.
 */
function CreateProjectAction({ atLimit }: { atLimit: boolean }) {
  return (
    <Button asChild variant={atLimit ? "outline" : "default"}>
      <Link to="/projects/new">
        <Plus className="mr-2 h-4 w-4" />
        Create project
      </Link>
    </Button>
  );
}

export function ProjectOverview({ projectsOnly = false }: { projectsOnly?: boolean }) {
  const queryClient = useQueryClient();
  const runDelete = useServerFn(deleteProject);
  const { data: projects = [], isLoading, error } = useProjects();
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { isAdmin } = useIsAdmin();
  const usage = projectUsage(projects.length, { isAdmin });
  const oldest = oldestProject(projects);

  // One request covering every matching project on the page, polled only while
  // at least one is actually matching.
  const matchingIds = projects
    .filter((project) => project.status === "matching_footage")
    .map((project) => project.id)
    .slice(0, 20);
  const fetchMatchingProgress = useServerFn(getMatchingProgress);
  const { data: matchingCounts } = useQuery({
    queryKey: ["matching-progress", matchingIds],
    queryFn: () =>
      pollWithAuthRetry(() => fetchMatchingProgress({ data: { projectIds: matchingIds } })),
    enabled: matchingIds.length > 0,
    refetchInterval: matchingIds.length > 0 ? 4000 : false,
  });
  const stats = summarizeProjectStatuses(projects);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeletingId(pendingDelete.id);
    try {
      await runDelete({ data: { projectId: pendingDelete.id } });
      toast.success(`Deleted "${pendingDelete.name}"`);
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    } catch (deleteError) {
      toast.error((deleteError as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:py-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">
            {projectsOnly ? "Workspace" : "Overview"}
          </p>
          <h1 className="mt-1 text-2xl font-semibold">{projectsOnly ? "Projects" : "Dashboard"}</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Create, review, and manage your scene-matched videos from one workspace.
          </p>
        </div>
        <CreateProjectAction atLimit={usage.atLimit} />
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-y py-4">
        <div>
          <p className="text-sm font-medium">
            {usage.exempt
              ? `${usage.count} project${usage.count === 1 ? "" : "s"}`
              : `${usage.count} of ${PROJECT_LIMIT} projects used`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {usage.exempt
              ? "No project limit on this account"
              : `${usage.remaining} project ${usage.remaining === 1 ? "slot" : "slots"} available`}
          </p>
        </div>
        {!usage.exempt ? (
          <div
            className="flex h-2 w-36 overflow-hidden rounded-full bg-muted"
            aria-label={`${usage.count} of ${PROJECT_LIMIT} project slots used`}
          >
            <span
              className="bg-primary transition-[width]"
              style={{ width: `${Math.min(100, (usage.count / PROJECT_LIMIT) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      {usage.atLimit ? (
        <Alert className="mt-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Project limit reached</AlertTitle>
          <AlertDescription className="mt-2 space-y-3">
            <p>{PROJECT_LIMIT_MESSAGE}</p>
            {oldest ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPendingDelete(oldest)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete the oldest ("{oldest.name}")
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {!projectsOnly ? (
        <section
          className="mt-8 grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Project statistics"
        >
          {[
            { label: "Total projects", value: stats.total, icon: FolderKanban },
            { label: "In progress", value: stats.active, icon: Clock3 },
            { label: "Completed", value: stats.completed, icon: CheckCircle2 },
            { label: "Needs attention", value: stats.attention, icon: AlertCircle },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-card p-5">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{label}</p>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="mt-3 text-2xl font-semibold tabular-nums">{isLoading ? "-" : value}</p>
            </div>
          ))}
        </section>
      ) : null}

      <section className="mt-9" aria-labelledby="projects-heading">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="projects-heading" className="text-base font-semibold">
            {projectsOnly ? "All projects" : "Recent projects"}
          </h2>
          <p className="text-xs text-muted-foreground">
            <Clock3 className="mr-1 inline h-3.5 w-3.5" />
            Files expire 30 hours after creation
          </p>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Projects could not be loaded</AlertTitle>
            <AlertDescription>{(error as Error).message}</AlertDescription>
          </Alert>
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-14 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-lg bg-primary-subtle text-primary">
                <Video className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold">Create your first video</h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Upload a voiceover and Scene Smith will prepare the scenes and footage.
              </p>
              <div className="mt-5">
                <CreateProjectAction atLimit={false} />
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {projects.map((project) => (
              <div key={project.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-muted">
                      <Video className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{project.name}</p>
                      {/* "Updated a minute ago" is meaningless here: every poll
                          touches updated_at even when it does no work. During
                          matching, say what is actually happening instead. */}
                      {project.status === "matching_footage" && matchingCounts?.[project.id] ? (
                        <div className="mt-1 space-y-1">
                          <p
                            className={`truncate text-xs ${
                              describeMatchingProgress(matchingCounts[project.id]).paused
                                ? "text-amber-700"
                                : "text-muted-foreground"
                            }`}
                          >
                            {shortMatchingLabel(matchingCounts[project.id])}
                          </p>
                          <Progress
                            className="h-1"
                            value={
                              describeMatchingProgress(matchingCounts[project.id]).percent ?? 0
                            }
                            aria-label={shortMatchingLabel(matchingCounts[project.id])}
                          />
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Updated{" "}
                          {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })} ·
                          expires{" "}
                          {formatDistanceToNow(addHours(new Date(project.created_at), 30), {
                            addSuffix: true,
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                </Link>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <Badge
                    variant={
                      project.status === "failed"
                        ? "destructive"
                        : project.status === "completed"
                          ? "default"
                          : "secondary"
                    }
                  >
                    {STATUS_LABELS[project.status] ?? project.status}
                  </Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${project.name}`}
                    disabled={deletingId === project.id}
                    onClick={() => setPendingDelete(project)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    {deletingId === project.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Project history, uploaded audio, and generated videos are automatically deleted 30 hours
        after creation.
      </p>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deletingId) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes <span className="font-medium">{pendingDelete?.name}</span>,
              including its uploaded audio and rendered videos. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!deletingId}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingId ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete project"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
