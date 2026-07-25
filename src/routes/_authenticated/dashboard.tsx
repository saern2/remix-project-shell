import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deleteProject } from "@/lib/projects.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Plus, LogOut, Video, Trash2, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

type Project = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  uploading: "secondary",
  transcribing: "secondary",
  generating_scenes: "secondary",
  matching_footage: "secondary",
  ready: "default",
  rendering: "secondary",
  completed: "default",
  failed: "destructive",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  uploading: "Uploading",
  transcribing: "Transcribing",
  generating_scenes: "Generating scenes",
  matching_footage: "Matching footage",
  ready: "Ready",
  rendering: "Rendering",
  completed: "Completed",
  failed: "Failed",
};

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runDelete = useServerFn(deleteProject);

  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: async (): Promise<Project[]> => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, status, created_at, updated_at, error_message")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as Project[];
    },
  });

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setDeletingId(id);
    try {
      await runDelete({ data: { projectId: id } });
      toast.success(`Deleted "${pendingDelete.name}"`);
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Video className="h-5 w-5" />
            <h1 className="text-lg font-semibold">Auto Video Creator</h1>
          </div>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Your projects</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload audio and Auto Video Creator drafts a video for you.
            </p>
          </div>
          <Button asChild>
            <Link to="/projects/new">
              <Plus className="mr-2 h-4 w-4" />
              New project
            </Link>
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-destructive">Failed to load projects: {(error as Error).message}</p>
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : !projects || projects.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Video className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="mb-4 text-sm text-muted-foreground">
                No projects yet. Create your first one to get started.
              </p>
              <Button asChild>
                <Link to="/projects/new">
                  <Plus className="mr-2 h-4 w-4" />
                  New project
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <div key={p.id} className="relative group">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: p.id }}
                  className="block"
                >
                  <Card className="h-full transition-colors hover:bg-accent/40">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base pr-8">{p.name}</CardTitle>
                        <Badge variant={STATUS_VARIANTS[p.status] ?? "outline"}>
                          {STATUS_LABELS[p.status] ?? p.status}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-muted-foreground">
                        Updated {formatDistanceToNow(new Date(p.updated_at), { addSuffix: true })}
                      </p>
                      {p.error_message ? (
                        <p className="mt-2 text-xs text-destructive">{p.error_message}</p>
                      ) : null}
                    </CardContent>
                  </Card>
                </Link>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${p.name}`}
                  disabled={deletingId === p.id}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setPendingDelete(p);
                  }}
                  className="absolute right-2 top-2 h-8 w-8 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                >
                  {deletingId === p.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </main>

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
              including its uploaded audio and any rendered videos. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!deletingId}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingId ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete project"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
