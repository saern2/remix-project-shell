import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { pollPipeline, startPipeline, swapSceneClip } from "@/lib/pipeline.functions";
import { submitRenderJob, pollRenderJob, cancelRenderJob } from "@/lib/render.functions";
import { deleteProject } from "@/lib/deleteProject";
import {
  EMPTY_SCENE_CARD_HINT,
  EMPTY_SCENE_CARD_NOTICE,
  describeFootageCoverage,
} from "@/lib/footage-coverage";
import {
  isMissingPollResult,
  nextPipelinePollDelayMs,
  nextPollDelayMs,
  pollIntervalWhileActive,
  type PipelinePollResult,
} from "@/lib/polling-state";
import { describeChunkPhase, describeQueuePosition, describeStitchPhase } from "@/lib/render-queue";
import { pollWithAuthRetry } from "@/lib/auth-retry.browser";
import { retryModeForProject } from "@/lib/render-retry";
import { describeUserFacingError, TRANSIENT_RETRYING } from "@/lib/user-errors";
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
import { describeMatchingProgress, expectedFixedSlicesForScenes } from "@/lib/matching-progress";
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

/**
 * How long a poll may be outstanding before its claim is treated as abandoned.
 *
 * Comfortably above the 51.9s worst case measured on 2026-08-12 under four-way
 * load, so a merely slow poll is never pre-empted and the guard keeps doing its
 * job; well below the point where a person would give up and reload.
 */
const STALE_POLL_CLAIM_MS = 90_000;

/**
 * How long a server-function failure stays relevant to the paused banner.
 * Five minutes spans several ~90s crash cycles while forgetting a lone blip.
 */
const SERVER_ERROR_WINDOW_MS = 5 * 60_000;

const IN_PROGRESS = new Set(["transcribing", "generating_scenes", "matching_footage"]);
const RENDER_ACTIVE = new Set(["queued", "downloading", "rendering", "stitching", "uploading"]);
/** A render in one of these is over; polling it again only produces a 404. */
const RENDER_TERMINAL = new Set(["completed", "failed", "cancelled", "not_found"]);

// expectedFixedSlicesForScenes moved to matching-progress.ts so the timeline
// header, the progress panel and the server count clip slots identically.

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

  // The timeline's row queries poll on a 3s interval WHILE matching and stop the
  // instant the status leaves matching_footage — so the final assignment slice,
  // which lands moments before that transition, was systematically absent from
  // the page they were left holding. On 2026-08-15 a complete 356-scene project
  // drew six "No clip" cards that way. The transition itself is the refetch
  // trigger that was missing (clipSlicesQuery never had this bug because its
  // queryKey includes project.status; these two are invalidated instead so the
  // stale rows stay on screen until the fresh ones arrive, rather than
  // flashing an empty state through a key change).
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = project?.status;
    if (prev === "matching_footage" && project?.status === "ready") {
      void queryClient.invalidateQueries({ queryKey: ["selected-clips", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["scenes", projectId] });
    }
  }, [project?.status, projectId, queryClient]);

  const scenesQuery = useQuery({
    enabled:
      !!project &&
      (isReady ||
        project.status === "generating_scenes" ||
        project.status === "matching_footage" ||
        // A failed project needs its scenes too: Retry decides between a
        // render-only resubmit and a full pipeline re-run by checking whether
        // the timeline (scenes × slices) is still complete.
        project.status === "failed"),
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

  // Matching completes a project even when a few scenes found no footage — under
  // the 10% failure threshold that is deliberate. What was NOT deliberate is that
  // nothing said so: the timeline showed bare "No clip" cards and the panel below
  // still read "Everything looks good". The holes are counted here and stated
  // wherever the user could otherwise act on a timeline that is not whole.
  //
  // Counted from two exact head-only aggregates, never from the timeline's rows
  // — rows lied twice (a mid-flight page outliving the ready transition, and
  // PostgREST's max-rows cap past ~1000 scenes; see footage-coverage.ts). The
  // status in the queryKey is the clipSlicesQuery precedent: the transition to
  // ready changes the key, so the counts are re-read at exactly the moment they
  // are about to be trusted.
  const coverageQuery = useQuery({
    enabled: !!project && isReady && !project.clip_duration_seconds,
    queryKey: ["footage-coverage", projectId, project?.status],
    queryFn: async () => {
      const [sceneCount, selectionCount] = await Promise.all([
        supabase
          .from("scenes")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId),
        supabase
          .from("selected_clips")
          .select("scene_id, scenes!inner(project_id)", { count: "exact", head: true })
          .eq("scenes.project_id", projectId),
      ]);
      if (sceneCount.error) throw sceneCount.error;
      if (selectionCount.error) throw selectionCount.error;
      return {
        totalScenes: sceneCount.count ?? 0,
        scenesWithClips: selectionCount.count ?? 0,
      };
    },
  });

  const footageCoverage = useMemo(
    () =>
      describeFootageCoverage({
        counts: coverageQuery.data,
        fixedDurationSeconds: project?.clip_duration_seconds,
      }),
    [coverageQuery.data, project?.clip_duration_seconds],
  );

  const runSwap = useServerFn(swapSceneClip);
  const [swappingId, setSwappingId] = useState<string | null>(null);
  const handleSwap = async (sceneId: string) => {
    setSwappingId(sceneId);
    try {
      await runSwap({ data: { sceneId } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["selected-clips", projectId] }),
        // A swap that fills an empty scene changes the coverage verdict; without
        // this the gate would stay closed after the user did the one thing the
        // notice asked of them.
        queryClient.invalidateQueries({ queryKey: ["footage-coverage", projectId] }),
      ]);
    } catch (err) {
      toast.error(describeUserFacingError(err));
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
      toast.error(describeUserFacingError(err));
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
      toast.error(describeUserFacingError(err));
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
          "id, status, progress_pct, output_url, error, stall_notice, chunks_total, chunks_completed, queue_position, queue_estimate_seconds, stitch_state, stitches_ahead, chunk_state, chunks_ahead, upload_total_bytes, upload_sent_bytes, created_at",
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
    // A timeline with holes cannot become a whole video. submitRenderJob already
    // refuses one, but it refused AFTER the click and named a single scene; the
    // button simply should not be offered.
    footageCoverage.complete &&
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
      toast.error(describeUserFacingError(err));
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
        const result = await pollWithAuthRetry(() =>
          runPollRender({ data: { jobId: renderJobId } }),
        );
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
        if (!cancelled)
          toast.error(describeUserFacingError(err, { transient: TRANSIENT_RETRYING }));
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
        const result = await pollWithAuthRetry(() =>
          runPollRender({ data: { jobId: renderJobId } }),
        );
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

  // Survives effect restarts on purpose. The setTimeout chain below only
  // prevents overlap WITHIN one effect instance; a restart begins a fresh chain
  // while the previous request is still in flight, and nothing aborts it.
  // MEASURED 2026-08-12: 31 of 83 pollPipeline launches in a single tab
  // overlapped a still-running predecessor, against a median call of 5.56s and
  // a maximum of 51.9s. A ref outlives the restart, so a second chain cannot
  // start a call while one is outstanding whatever churns the dependencies.
  // Confirmed in production on the same day: 0 of 12 launches overlapped.
  //
  // Holds the claim TIME, not a boolean, so the claim can expire. Nothing on
  // this path can time out — there is no AbortSignal in auth-retry.browser.ts
  // or polling-state.ts, and browser fetch waits forever — so a request that
  // never settles (server wedged, connection black-holed, laptop suspended
  // mid-flight) would hold a boolean claim permanently. Every other exit
  // releases it, including the early return on a deleted project, because the
  // release is in a `finally`; this is the one path that does not, and before
  // the guard existed a hung request was harmlessly overtaken by the next
  // poll. That accidental recovery is what the guard removes, so it has to be
  // replaced deliberately.
  const pollInFlight = useRef<number | null>(null);

  // Server-function failures THIS CLIENT saw recently, for the paused banner.
  // The banner is computed from database timestamps, which know that nothing
  // progressed but cannot know why. On 2026-08-14 a crash-looping runtime sat
  // under "Paused — resuming now. Nothing was lost." for five minutes; the
  // client had watched four of its own polls die in that window and said
  // nothing. This is the saying of it.
  const serverFnErrorTimes = useRef<number[]>([]);
  const noteServerFnError = () => {
    const now = Date.now();
    serverFnErrorTimes.current = [
      ...serverFnErrorTimes.current.filter((at) => now - at < SERVER_ERROR_WINDOW_MS),
      now,
    ];
  };

  // Poll the pipeline server function whenever the project is mid-flight.
  //
  // Depends on the STATUS STRING, never on the project object. `project` is a
  // react-query result whose identity changes whenever the row changes, and
  // trg_projects_updated_at bumps updated_at on every matching write — two to
  // three per invocation — so the selected row changed roughly every 3s and
  // tore this effect down and restarted it at the same rate.
  const projectStatus = project?.status;
  useEffect(() => {
    if (!projectStatus || !IN_PROGRESS.has(projectStatus)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveErrors = 0;

    const tick = async () => {
      // A tick that arrives while the previous call is still running is
      // dropped, not queued: piling a second invocation onto a struggling
      // server function is what turned a slow poll into a saturated runtime.
      //
      // Unless the claim has gone stale, in which case the holder is treated
      // as lost and this tick proceeds. Without that, one unsettling request
      // would stop this project advancing for the rest of the session while
      // the loop spun harmlessly, checking a flag that would never clear.
      const startedAt = Date.now();
      const heldFor = pollInFlight.current == null ? 0 : startedAt - pollInFlight.current;
      if (pollInFlight.current != null && heldFor < STALE_POLL_CLAIM_MS) {
        if (!cancelled) timer = setTimeout(tick, nextPollDelayMs(0));
        return;
      }
      if (pollInFlight.current != null) {
        // Loud, because it means a request never came back. Silent recovery
        // here would hide exactly the condition worth knowing about.
        console.warn("[pipeline-poll] abandoning a stale in-flight claim", {
          projectId,
          heldForMs: heldFor,
        });
      }
      // The claim is the timestamp itself, which doubles as its own identity.
      const claim = startedAt;
      pollInFlight.current = claim;
      let hadError = false;
      // What the last invocation returned decides when the next one goes out.
      let lastResult: PipelinePollResult = null;
      try {
        const result = await pollWithAuthRetry(() => runPoll({ data: { projectId } }));
        lastResult = result as PipelinePollResult;
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
        if (!cancelled && consecutiveErrors === 1) {
          toast.error(describeUserFacingError(err, { transient: TRANSIENT_RETRYING }));
        }
        noteServerFnError();
      } finally {
        // Released on every path, including the early return above — a claim
        // left set would stop this project polling for the rest of the session.
        //
        // Only OUR claim: a hung predecessor that finally settles after being
        // declared stale must not clear the claim a newer poll is holding, or
        // it would reopen the overlap it was abandoned for.
        if (pollInFlight.current === claim) pollInFlight.current = null;
      }
      if (!cancelled) {
        // React Query is refetching the project row on its own interval;
        // just invalidate to pick up the new status.
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        // An invocation that just spent its whole 12s budget advancing matching
        // is followed immediately: the work is server-side and a fixed client
        // cadence is unrelated to it. MEASURED 2026-08-14: the 4s wait after
        // each one cost 118.0s of a 474.5s run and 209.6s of an 833.5s run.
        //
        // Everything else — errors, maintenance, a peer holding the lock, or
        // any response that came back too fast to have done work — keeps the
        // 4s beat and its error backoff (round 6, Issue 6).
        timer = setTimeout(
          tick,
          nextPipelinePollDelayMs({
            result: lastResult,
            elapsedMs: Date.now() - startedAt,
            consecutiveErrors: hadError ? consecutiveErrors : 0,
          }),
        );
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectStatus, projectId, queryClient, runPoll, navigate]);

  const fetchMatchingProgress = useServerFn(getMatchingProgress);
  const { data: matchingCounts } = useQuery({
    queryKey: ["matching-progress", projectId],
    queryFn: () =>
      pollWithAuthRetry(() => fetchMatchingProgress({ data: { projectIds: [projectId] } })),
    // Only while it matters, and at the poll cadence — four HEAD counts.
    enabled: project?.status === "matching_footage",
    refetchInterval: () => (project?.status === "matching_footage" ? 3000 : false),
  });
  const recentServerErrors = serverFnErrorTimes.current.filter(
    (at) => Date.now() - at < SERVER_ERROR_WINDOW_MS,
  ).length;
  const matchingView = matchingCounts?.[projectId]
    ? describeMatchingProgress(matchingCounts[projectId], { recentServerErrors })
    : null;

  const progressPct = useMemo(() => {
    if (!project) return 0;
    if (project.status === "failed") return 0;
    return STATUS_STEPS.find((s) => s.key === project.status)?.pct ?? 0;
  }, [project]);

  const handleRetry = async () => {
    try {
      // A render failure keeps its finished timeline: resubmit the RENDER
      // only. The old behavior reset to draft and re-ran the whole pipeline —
      // measured on 2026-08-09 at 5-6 minutes of matching re-done for a
      // project whose failure message had just said "Nothing was lost".
      // submitRenderJob accepts a failed project and moves it back through
      // rendering itself; no draft reset, no matching re-run.
      const mode = retryModeForProject({
        latestRenderJobStatus: renderJob?.status,
        timelineComplete: fixedSlicesComplete,
      });
      if (mode === "render-only") {
        setSubmittingRender(true);
        try {
          await runSubmitRender({ data: { projectId } });
        } finally {
          setSubmittingRender(false);
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["render-job", projectId] }),
        ]);
        return;
      }
      await supabase
        .from("projects")
        .update({ status: "draft", error_message: null })
        .eq("id", projectId);
      await runStart({ data: { projectId } });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["scenes", projectId] });
    } catch (err) {
      toast.error(describeUserFacingError(err));
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
                    {/* Paused is a NOTE beside the progress, never a
                        replacement for it: the counts stay visible so it is
                        obvious how far the work got. */}
                    {matchingView.paused ? (
                      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                        {matchingView.pausedNotice}
                      </p>
                    ) : null}
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
                                  ) : project.status === "matching_footage" ? (
                                    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                                      Matching…
                                    </div>
                                  ) : (
                                    // Matching has finished and this scene still has
                                    // nothing. "No clip" left the user to guess whether
                                    // that was a bug, a wait, or their own doing.
                                    <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
                                      <span className="text-xs font-medium text-foreground">
                                        {EMPTY_SCENE_CARD_NOTICE}
                                      </span>
                                      <span className="text-[10px] leading-tight text-muted-foreground">
                                        {EMPTY_SCENE_CARD_HINT}
                                      </span>
                                    </div>
                                  )}
                                  {isReady ? (
                                    // Also offered on an EMPTY card, which is where it
                                    // matters most: swapSceneClip needs only the scene's
                                    // visual query and runs a fresh provider search, so
                                    // it is exactly the way out of a scene the stored
                                    // corpus had nothing for. Kept visible without hover
                                    // there, since a card with no image gives no hint
                                    // that anything is hidden on it.
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={isSwapping}
                                      onClick={() => handleSwap(s.id)}
                                      className={
                                        clip
                                          ? "absolute right-1 top-1 h-7 px-2 opacity-0 shadow transition-opacity group-hover:opacity-100"
                                          : "absolute right-1 top-1 h-7 px-2 shadow"
                                      }
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
                        {/* Most specific first. "Rendering video…" is the
                            fallback and was, for 36 minutes, the only thing a
                            waiting project ever said. */}
                        {describeStitchPhase(renderJob.stitch_state, renderJob.stitches_ahead, {
                          chunksTotal: renderJob.chunks_total,
                          uploadSentBytes: renderJob.upload_sent_bytes,
                          uploadTotalBytes: renderJob.upload_total_bytes,
                        }) ??
                          describeChunkPhase(
                            renderJob.chunk_state,
                            renderJob.chunks_ahead,
                            renderJob.queue_estimate_seconds,
                            renderJob.queue_position,
                          ) ??
                          (renderJob.status === "queued"
                            ? "Queued on the render worker…"
                            : renderJob.status === "downloading"
                              ? "Downloading source clips…"
                              : "Rendering video…")}
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
                      {describeQueuePosition(
                        renderJob.queue_position,
                        renderJob.queue_estimate_seconds,
                      ) ? (
                        // Neutral, not amber: being third in line is normal and
                        // temporary. Before the render cap existed this looked
                        // identical to a hang — queued, 0 segments, nothing
                        // moving, no reason given.
                        <div
                          role="status"
                          className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground"
                        >
                          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            {describeQueuePosition(
                              renderJob.queue_position,
                              renderJob.queue_estimate_seconds,
                            )}
                          </span>
                        </div>
                      ) : null}
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

                  {/*
                    Stated before anything else in this panel, because it is the
                    reason the Render button is absent. Without it the panel simply
                    showed nothing where the button had been.
                  */}
                  {footageCoverage.notice ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                      <p className="text-sm font-medium text-foreground">
                        {footageCoverage.missingScenes === 1
                          ? "1 scene has no footage"
                          : `${footageCoverage.missingScenes} scenes have no footage`}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{footageCoverage.notice}</p>
                    </div>
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
