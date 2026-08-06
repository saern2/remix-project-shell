import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { pollPipeline, startPipeline, swapSceneClip } from "@/lib/pipeline.functions";
import { submitRenderJob, pollRenderJob, cancelRenderJob } from "@/lib/render.functions";
import { deleteProject } from "@/lib/deleteProject";
import { isMissingPollResult, nextPollDelayMs, pollIntervalWhileActive } from "@/lib/polling-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
import {
  ArrowLeft,
  RotateCcw,
  AlertTriangle,
  Shuffle,
  Film,
  Loader2,
  X,
  Trash2,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { describeMatchingProgress } from "@/lib/matching-progress";
import { getMatchingProgress } from "@/lib/matching-progress.functions";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  component: ProjectDetail,
});

type Project = {
  id: string;
  name: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  clip_duration_seconds: number | null;
};

type Scene = {
  id: string;
  idx: number;
  text: string;
  start_ts: number;
  end_ts: number;
  visual_query: string | null;
};

type ClipSlice = {
  id: string;
  scene_id: string;
  slice_index: number;
  clip_url: string;
  thumbnail_url: string | null;
  duration_seconds: number;
  timeline_start_seconds: number;
  timeline_end_seconds: number;
};

const STATUS_STEPS: Array<{ key: string; label: string; pct: number }> = [
  { key: "uploading", label: "Uploading audio", pct: 15 },
  { key: "draft", label: "Audio uploaded", pct: 25 },
  { key: "transcribing", label: "Transcribing", pct: 40 },
  { key: "generating_scenes", label: "Generating scenes", pct: 65 },
  { key: "matching_footage", label: "Matching footage", pct: 85 },
  { key: "ready", label: "Ready", pct: 100 },
];

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

const IN_PROGRESS = new Set(["transcribing", "generating_scenes", "matching_footage"]);
const RENDER_ACTIVE = new Set(["queued", "downloading", "rendering", "stitching", "uploading"]);
/** A render in one of these is over; polling it again only produces a 404. */
const RENDER_TERMINAL = new Set(["completed", "failed", "cancelled", "not_found"]);

function expectedFixedSlicesForScenes(scenes: Scene[], fixedDuration: number): number {
  return scenes.reduce((count, scene, index) => {
    const sceneStart = Number(scene.start_ts);
    const sceneEnd = Number(scene.end_ts);
    const nextStart = index + 1 < scenes.length ? Number(scenes[index + 1].start_ts) : sceneEnd;
    const visualEnd = nextStart > sceneEnd ? nextStart : sceneEnd;
    const duration = Math.max(0, visualEnd - sceneStart);
    return count + (duration > 0 ? Math.max(1, Math.ceil(duration / fixedDuration)) : 0);
  }, 0);
}

function ProjectDetail() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runPoll = useServerFn(pollPipeline);
  const runStart = useServerFn(startPipeline);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: async (): Promise<Project | null> => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, status, error_message, created_at, updated_at, clip_duration_seconds")
        .eq("id", projectId)
        .maybeSingle();
      if (error) throw error;
      return data ? (data as Project) : null;
    },
    // Refetch quickly while the pipeline is running.
    refetchInterval: (query) => pollIntervalWhileActive(query.state.data, IN_PROGRESS, 3000),
  });

  const project = projectQuery.data;
  useEffect(() => {
    if (!projectQuery.isSuccess || projectQuery.data !== null) return;
    toast.info(
      "This project no longer exists. It may have been deleted or removed by the 30-hour cleanup.",
    );
    void navigate({ to: "/dashboard", replace: true });
  }, [navigate, projectQuery.data, projectQuery.isSuccess]);

  const isReady = project?.status === "ready" || project?.status === "completed";

  const scenesQuery = useQuery({
    enabled:
      !!project &&
      (isReady || project.status === "generating_scenes" || project.status === "matching_footage"),
    queryKey: ["scenes", projectId],
    queryFn: async (): Promise<Scene[]> => {
      const { data, error } = await supabase
        .from("scenes")
        .select("id, idx, text, start_ts, end_ts, visual_query")
        .eq("project_id", projectId)
        .order("idx", { ascending: true });
      if (error) throw error;
      return data as Scene[];
    },
    refetchInterval: (query) =>
      project?.status === "generating_scenes" || project?.status === "matching_footage"
        ? 3000
        : false,
  });

  const clipsQuery = useQuery({
    enabled: !!project && (isReady || project.status === "matching_footage"),
    queryKey: ["selected-clips", projectId],
    queryFn: async () => {
      // Single query: join selected_clips → scenes (via scene_id FK) → clip_candidates.
      // This avoids the previous two-step pattern (fetch scene IDs first, then
      // fetch selected_clips with an IN filter) which caused a serial round-trip
      // and made the Timeline appear late.
      const { data, error } = await supabase
        .from("selected_clips")
        .select(
          "scene_id, in_point, out_point, clip_candidates!inner(id, url, thumbnail_url, duration_sec, provider, provider_clip_id), scenes!inner(project_id)",
        )
        .eq("scenes.project_id", projectId);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: (query) => (project?.status === "matching_footage" ? 3000 : false),
  });
  const clipSlicesQuery = useQuery({
    enabled: !!project && !!project.clip_duration_seconds,
    // Include project.status in the key so slices are re-fetched when a new
    // render completes (status: rendering -> completed) but NOT on every
    // focus event or poll cycle. staleTime: Infinity prevents background
    // refetches entirely — slices only change when submitRenderJob writes new
    // rows, which always triggers a status transition that changes this key.
    queryKey: ["clip-slices", projectId, project?.status],
    queryFn: async (): Promise<ClipSlice[]> => {
      const { data, error } = await supabase
        .from("render_clip_slices")
        .select(
          "id, scene_id, slice_index, clip_url, thumbnail_url, duration_seconds, timeline_start_seconds, timeline_end_seconds",
        )
        .eq("project_id", projectId);
      // NOTE: ordering by scene_id (UUID) is removed here — UUIDs are not sequential
      // and produce an effectively random scene order. Sorting is done client-side
      // in sortedClipSlices using the scene idx values from scenesQuery.
      if (error) throw error;
      return (data ?? []) as ClipSlice[];
    },
    refetchInterval: () => (project?.status === "matching_footage" ? 1500 : false),
  });

  const clipsByScene = useMemo(() => {
    const map = new Map<string, { thumb: string | null; url: string; duration: number }>();
    for (const row of clipsQuery.data ?? []) {
      const c = row as unknown as {
        scene_id: string;
        clip_candidates: { thumbnail_url: string | null; url: string; duration_sec: number };
      };
      map.set(c.scene_id, {
        thumb: c.clip_candidates.thumbnail_url,
        url: c.clip_candidates.url,
        duration: Number(c.clip_candidates.duration_sec),
      });
    }
    return map;
  }, [clipsQuery.data]);

  // Sort clip slices by scene idx (from scenesQuery) then slice_index.
  // render_clip_slices has no idx column — scene_id is a UUID, not a sequence,
  // so server-side ordering by scene_id produces a random scene order.
  const sortedClipSlices = useMemo(() => {
    const slices = clipSlicesQuery.data ?? [];
    if (slices.length === 0) return slices;
    // Build a scene_id -> idx map from the already-loaded scenesQuery
    const sceneIdxMap = new Map<string, number>();
    for (const s of scenesQuery.data ?? []) {
      sceneIdxMap.set(s.id, s.idx);
    }
    return [...slices].sort((a, b) => {
      const aIdx = sceneIdxMap.get(a.scene_id) ?? 0;
      const bIdx = sceneIdxMap.get(b.scene_id) ?? 0;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.slice_index - b.slice_index;
    });
  }, [clipSlicesQuery.data, scenesQuery.data]);

  const expectedFixedSliceCount = useMemo(() => {
    if (!project?.clip_duration_seconds || !scenesQuery.data) return 0;
    const fixedDuration = Number(project.clip_duration_seconds);
    return expectedFixedSlicesForScenes(scenesQuery.data, fixedDuration);
  }, [project?.clip_duration_seconds, scenesQuery.data]);

  const fixedSlicesComplete =
    !project?.clip_duration_seconds ||
    (expectedFixedSliceCount > 0 &&
      new Set(sortedClipSlices.map((s) => `${s.scene_id}:${s.slice_index}`)).size >=
        expectedFixedSliceCount);

  const runSwap = useServerFn(swapSceneClip);
  const [swappingId, setSwappingId] = useState<string | null>(null);
  const handleSwap = async (sceneId: string) => {
    setSwappingId(sceneId);
    try {
      await runSwap({ data: { sceneId } });
      await queryClient.invalidateQueries({ queryKey: ["selected-clips", projectId] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSwappingId(null);
    }
  };

  // ---- Delete project ----
  const runDeleteProject = useServerFn(deleteProject);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  const handleDeleteProject = async () => {
    setDeletingProject(true);
    try {
      await runDeleteProject({ data: { projectId } });
      navigate({ to: "/dashboard", replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeletingProject(false);
      setShowDeleteConfirm(false);
    }
  };

  // ---- Render job ----
  const runSubmitRender = useServerFn(submitRenderJob);
  const runPollRender = useServerFn(pollRenderJob);
  const [submittingRender, setSubmittingRender] = useState(false);

  const runCancelRender = useServerFn(cancelRenderJob);
  const [cancellingRender, setCancellingRender] = useState(false);

  const handleCancelRender = async () => {
    if (!renderJob) return;
    setCancellingRender(true);
    try {
      await runCancelRender({ data: { jobId: renderJob.id } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["render-job", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      ]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCancellingRender(false);
    }
  };

  const renderJobQuery = useQuery({
    enabled: !!project,
    queryKey: ["render-job", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("render_jobs")
        .select(
          "id, status, progress_pct, output_url, error, stall_notice, chunks_total, chunks_completed, created_at",
        )
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    refetchInterval: (q) => pollIntervalWhileActive(q.state.data, RENDER_ACTIVE, 3000),
  });
  const renderJob = renderJobQuery.data;
  const renderJobId = renderJob?.id;
  const renderJobStatus = renderJob?.status;
  const renderJobOutputUrl = renderJob?.output_url;
  const canSubmitRender =
    project?.status === "ready" &&
    fixedSlicesComplete &&
    (!renderJob || !RENDER_ACTIVE.has(renderJob.status));

  const handleRender = async () => {
    setSubmittingRender(true);
    try {
      await runSubmitRender({ data: { projectId } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["render-job", projectId] }),
      ]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmittingRender(false);
    }
  };

  // Poll worker while the current render job is active.
  useEffect(() => {
    if (!renderJobId || !renderJobStatus || !RENDER_ACTIVE.has(renderJobStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let reachedTerminalState = false;
      try {
        const result = await runPollRender({ data: { jobId: renderJobId } });
        if (isMissingPollResult(result)) {
          cancelled = true;
          toast.info("This render job no longer exists.");
          void navigate({ to: "/dashboard", replace: true });
          return;
        }
        // Stop as soon as the poll itself reports a settled render, rather than
        // waiting for the status query to round-trip and disable this effect.
        // A cancelled render's job is removed from the worker, so one more tick
        // is one more 404 (round 8, Problem 1).
        reachedTerminalState = RENDER_TERMINAL.has(result?.status ?? "");
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message);
      }
      if (!cancelled) {
        queryClient.invalidateQueries({ queryKey: ["render-job", projectId] });
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        if (reachedTerminalState) {
          cancelled = true;
          return;
        }
        timer = setTimeout(tick, 3000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [renderJobId, renderJobStatus, projectId, queryClient, runPollRender, navigate]);

  // One-shot poll for completed jobs whose stored output_url is missing or is a
  // pre-signed upload URL (not a playback URL). This happens when:
  //   (a) the page is loaded/refreshed after a render completes, or
  //   (b) a re-render completes and the DB still has the upload URL from the worker.
  // pollRenderJob's short-circuit path for completed jobs now re-signs the URL,
  // so a single call here is enough to get a fresh playback URL into the cache.
  useEffect(() => {
    if (!renderJobId || renderJobStatus !== "completed") return;
    const needsResign = !renderJobOutputUrl || renderJobOutputUrl.includes("/upload/sign/");
    if (!needsResign) return;

    let cancelled = false;
    (async () => {
      try {
        const result = await runPollRender({ data: { jobId: renderJobId } });
        if (isMissingPollResult(result)) {
          cancelled = true;
          toast.info("This render job no longer exists.");
          void navigate({ to: "/dashboard", replace: true });
          return;
        }
        if (!cancelled) {
          queryClient.invalidateQueries({ queryKey: ["render-job", projectId] });
        }
      } catch {
        // Silently ignore — worst case the video element shows no src
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    renderJobId,
    renderJobOutputUrl,
    renderJobStatus,
    projectId,
    queryClient,
    runPollRender,
    navigate,
  ]);

  // Poll the pipeline server function whenever the project is mid-flight.
  useEffect(() => {
    if (!project) return;
    if (!IN_PROGRESS.has(project.status)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveErrors = 0;

    const tick = async () => {
      let hadError = false;
      try {
        const result = await runPoll({ data: { projectId } });
        if (isMissingPollResult(result)) {
          cancelled = true;
          toast.info(
            "This project no longer exists. It may have been removed by the 30-hour cleanup.",
          );
          void navigate({ to: "/dashboard", replace: true });
          return;
        }
        consecutiveErrors = 0;
      } catch (err) {
        hadError = true;
        consecutiveErrors += 1;
        // Surface the error only on the first failure of a streak; the query
        // refetch will show the failed state and repeated toasts would be noise.
        if (!cancelled && consecutiveErrors === 1) toast.error((err as Error).message);
      }
      if (!cancelled) {
        // React Query is refetching the project row on its own interval;
        // just invalidate to pick up the new status.
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        // Back off on consecutive errors so a struggling matching invocation is
        // not piled on by fixed-interval retries (round 6, Issue 6).
        timer = setTimeout(tick, nextPollDelayMs(hadError ? consecutiveErrors : 0));
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [project?.status, projectId, queryClient, runPoll, project, navigate]);

  const fetchMatchingProgress = useServerFn(getMatchingProgress);
  const { data: matchingCounts } = useQuery({
    queryKey: ["matching-progress", projectId],
    queryFn: () => fetchMatchingProgress({ data: { projectIds: [projectId] } }),
    // Only while it matters, and at the poll cadence — four HEAD counts.
    enabled: project?.status === "matching_footage",
    refetchInterval: () => (project?.status === "matching_footage" ? 3000 : false),
  });
  const matchingView = matchingCounts?.[projectId]
    ? describeMatchingProgress(matchingCounts[projectId])
    : null;

  const progressPct = useMemo(() => {
    if (!project) return 0;
    if (project.status === "failed") return 0;
    return STATUS_STEPS.find((s) => s.key === project.status)?.pct ?? 0;
  }, [project]);

  const handleRetry = async () => {
    try {
      await supabase
        .from("projects")
        .update({ status: "draft", error_message: null })
        .eq("id", projectId);
      await runStart({ data: { projectId } });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["scenes", projectId] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/dashboard">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Link>
            </Button>
            <h1 className="text-lg font-semibold">{project?.name ?? "Loading..."}</h1>
          </div>
          {project ? (
            <div className="flex items-center gap-2">
              <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>
                {STATUS_LABELS[project.status] ?? project.status}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-4 w-4" />
                <span className="sr-only">Delete project</span>
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {projectQuery.isLoading || !project ? (
          <Skeleton className="h-40 w-full" />
        ) : project.status === "failed" ? (
          <Card className="border-destructive/50">
            <CardHeader>
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <CardTitle className="text-base">Pipeline failed</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {project.error_message ?? "An unknown error occurred."}
              </p>
              <Button onClick={handleRetry} variant="outline">
                <RotateCcw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              Project history, uploaded audio, and generated videos are automatically deleted 30
              hours after creation.
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Progress</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Matching runs for minutes with nothing else to show — the
                    corpus phase assigns no scenes at all, so the step list below
                    sits still and reads as stalled. These are the numbers the
                    poll already returns, said out loud. */}
                {project.status === "matching_footage" && matchingView ? (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{matchingView.headline}</p>
                      {matchingView.estimate ? (
                        <p className="text-xs text-muted-foreground">
                          {matchingView.estimate} (rough estimate)
                        </p>
                      ) : null}
                    </div>
                    <Progress
                      value={matchingView.percent ?? 0}
                      aria-label={matchingView.headline}
                    />
                    <p className="text-xs text-muted-foreground">{matchingView.detail}</p>
                  </div>
                ) : null}
                <Progress value={progressPct} aria-label="Pipeline progress" />
                <ul className="grid gap-2 text-sm sm:grid-cols-2">
                  {STATUS_STEPS.map((step) => {
                    const done = progressPct >= step.pct;
                    const active = project.status === step.key;
                    return (
                      <li
                        key={step.key}
                        className={`flex items-center gap-2 ${done || active ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            active
                              ? "bg-primary animate-pulse"
                              : done
                                ? "bg-primary"
                                : "bg-muted-foreground/30"
                          }`}
                        />
                        {step.label}
                      </li>
                    );
                  })}
                </ul>
                {project.status === "draft" ? (
                  <Button size="sm" onClick={handleRetry}>
                    Start transcription
                  </Button>
                ) : null}
              </CardContent>
            </Card>

            {(isReady || project.status === "matching_footage") &&
              scenesQuery.data &&
              scenesQuery.data.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Timeline{" "}
                      {project.clip_duration_seconds
                        ? `(${sortedClipSlices.length}${expectedFixedSliceCount ? `/${expectedFixedSliceCount}` : ""} clips, ${
                            scenesQuery.data.length
                          } scenes)`
                        : `(${scenesQuery.data.length} scenes)`}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {project.clip_duration_seconds && (clipSlicesQuery.data?.length ?? 0) > 0
                        ? // Fixed-duration path: render persisted clip slices in correct scene order
                          sortedClipSlices.map((slice, index) => {
                            const scene = scenesQuery.data.find((s) => s.id === slice.scene_id);
                            return (
                              <div
                                key={slice.id}
                                className="relative w-40 shrink-0 overflow-hidden rounded-md border bg-muted"
                              >
                                <div className="relative aspect-video w-full bg-muted-foreground/10">
                                  {slice.thumbnail_url ? (
                                    <img
                                      src={slice.thumbnail_url}
                                      alt=""
                                      className="h-full w-full object-cover"
                                      loading="lazy"
                                    />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                                      Matched
                                    </div>
                                  )}
                                </div>
                                <div className="p-2 text-xs">
                                  <div className="flex items-center justify-between text-muted-foreground">
                                    <span>Clip {index + 1}</span>
                                    <span>{Number(slice.duration_seconds).toFixed(1)}s</span>
                                  </div>
                                  {scene ? (
                                    <div className="mt-1 text-muted-foreground/80">
                                      Scene {scene.idx + 1}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })
                        : // Default path: scene-based timeline
                          scenesQuery.data.map((s) => {
                            const clip = clipsByScene.get(s.id);
                            const sceneDur = Number(s.end_ts) - Number(s.start_ts);
                            const isSwapping = swappingId === s.id;
                            return (
                              <div
                                key={s.id}
                                className="group relative w-40 shrink-0 overflow-hidden rounded-md border bg-muted"
                              >
                                <div className="relative aspect-video w-full bg-muted-foreground/10">
                                  {clip?.thumb ? (
                                    <img
                                      src={clip.thumb}
                                      alt={s.visual_query ?? ""}
                                      className="h-full w-full object-cover"
                                      loading="lazy"
                                    />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                                      {project.status === "matching_footage"
                                        ? "Matching…"
                                        : "No clip"}
                                    </div>
                                  )}
                                  {clip && isReady ? (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={isSwapping}
                                      onClick={() => handleSwap(s.id)}
                                      className="absolute right-1 top-1 h-7 px-2 opacity-0 shadow transition-opacity group-hover:opacity-100"
                                    >
                                      <Shuffle className="mr-1 h-3 w-3" />
                                      {isSwapping ? "…" : "Swap"}
                                    </Button>
                                  ) : null}
                                </div>
                                <div className="p-2 text-xs">
                                  <div className="flex items-center justify-between text-muted-foreground">
                                    <span>Scene {s.idx + 1}</span>
                                    <span>{sceneDur.toFixed(1)}s</span>
                                  </div>
                                  <p className="mt-1 line-clamp-2 text-foreground/90">{s.text}</p>
                                </div>
                              </div>
                            );
                          })}
                    </div>
                  </CardContent>
                </Card>
              )}

            {(isReady ||
              project.status === "rendering" ||
              project.status === "completed" ||
              (project.status === "failed" && renderJob)) && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-4">
                    <CardTitle className="text-base">Final video</CardTitle>
                    {canSubmitRender ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={handleRender}
                          disabled={submittingRender}
                          variant="outline"
                        >
                          {submittingRender ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Film className="mr-2 h-4 w-4" />
                          )}
                          Render video
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {renderJob && RENDER_ACTIVE.has(renderJob.status) ? (
                    <>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {renderJob.status === "queued"
                          ? "Queued on the render worker…"
                          : renderJob.status === "downloading"
                            ? "Downloading source clips…"
                            : "Rendering video…"}
                        <span className="ml-auto font-mono text-xs">
                          {(renderJob.chunks_total ?? 0) > 0
                            ? `${renderJob.chunks_completed ?? 0} of ${renderJob.chunks_total} segments rendered`
                            : `${renderJob.progress_pct}%`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <Progress
                          value={
                            (renderJob.chunks_total ?? 0) > 0
                              ? Math.max(
                                  renderJob.progress_pct,
                                  Math.round(
                                    ((renderJob.chunks_completed ?? 0) /
                                      (renderJob.chunks_total ?? 1)) *
                                      100,
                                  ),
                                )
                              : renderJob.progress_pct
                          }
                          aria-label="Render progress"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancellingRender}
                          onClick={handleCancelRender}
                          className="shrink-0"
                        >
                          {cancellingRender ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                          <span className="ml-1">Cancel</span>
                        </Button>
                      </div>
                      {renderJob.stall_notice ? (
                        // A render that is stuck must say so. Previously this
                        // panel showed "12 of 13 segments rendered" unchanged
                        // for minutes with no hint that anything was wrong.
                        <div
                          role="status"
                          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{renderJob.stall_notice}</span>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {renderJob?.status === "completed" && renderJob.output_url ? (
                    <div className="space-y-2">
                      <video
                        src={renderJob.output_url}
                        controls
                        playsInline
                        className="w-full max-h-[70vh] rounded-md bg-black"
                      />
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" asChild>
                          <a href={renderJob.output_url} download>
                            Download MP4
                          </a>
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {renderJob?.status === "failed" ? (
                    <p className="text-sm text-destructive">
                      {renderJob.error ?? "Render failed."}
                    </p>
                  ) : null}

                  {!renderJob && canSubmitRender ? (
                    <p className="text-sm text-muted-foreground">
                      Everything looks good. Click <span className="font-medium">Render video</span>{" "}
                      to stitch the timeline into an MP4.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            )}

            {(isReady ||
              project.status === "generating_scenes" ||
              project.status === "matching_footage") && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Transcript {scenesQuery.data ? `(${scenesQuery.data.length} scenes)` : ""}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {scenesQuery.isLoading ? (
                    <Skeleton className="h-40 w-full" />
                  ) : !scenesQuery.data || scenesQuery.data.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No scenes yet.</p>
                  ) : (
                    <ol className="space-y-4">
                      {scenesQuery.data.map((s) => (
                        <li key={s.id} className="rounded-md border p-4">
                          <div className="mb-2 text-xs text-muted-foreground">
                            <span>Scene {s.idx + 1}</span>
                          </div>
                          <p className="text-sm leading-relaxed">{s.text}</p>
                          <div className="mt-3">
                            {s.visual_query ? (
                              <Badge variant="outline" className="font-mono text-xs">
                                {s.visual_query}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Generating visual query…
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{project?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the project and all its associated files. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              disabled={deletingProject}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingProject ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
