import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { persistScriptTranscript, startPipeline } from "@/lib/pipeline.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, ArrowLeft, FolderKanban, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { describeUserFacingError } from "@/lib/user-errors";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { PROJECTS_QUERY_KEY, useProjects } from "@/components/project-overview";
import { deleteProject } from "@/lib/deleteProject";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  isProjectLimitError,
  oldestProject,
  PROJECT_LIMIT,
  PROJECT_LIMIT_MESSAGE,
  projectUsage,
} from "@/lib/project-limit";
import {
  checkAudioLength,
  formatDuration,
  MAX_AUDIO_DURATION_SECONDS,
  readAudioDuration,
} from "@/lib/audio-limits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { checkWebGpu, type WebGpuVerdict } from "@/lib/tts/webgpu";
import {
  checkScript,
  estimateSpokenSeconds,
  extractScriptText,
  splitScriptIntoSentences,
} from "@/lib/tts/script-input";
import { TTS_VOICES, parseDtypeParam } from "@/lib/tts/generate";
import { isModelCached } from "@/lib/tts/model-host";
import {
  completeNarration,
  pollNarrationJob,
  submitNarrationJob,
} from "@/lib/tts/narration.functions";
import { driveNarration } from "@/lib/tts/narration-client";
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
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/projects/new")({
  component: NewProject,
});

const ACCEPTED =
  "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/m4a,audio/aac,audio/flac";
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

type CategoryValue = "none" | "war" | "crime" | "space";

function NewProject() {
  const navigate = useNavigate();
  const runStartPipeline = useServerFn(startPipeline);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<CategoryValue>("none");
  const [fixedClips, setFixedClips] = useState(false);
  const [clipDuration, setClipDuration] = useState(4);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<string>("");
  const [mode, setMode] = useState<"audio" | "script">("audio");
  const [script, setScript] = useState("");
  const [voice, setVoice] = useState<string>(TTS_VOICES[0].id);
  const [scriptWarning, setScriptWarning] = useState<string | null>(null);
  // null = not yet probed; the probe runs when the script tab is opened, so
  // the refusal appears BEFORE a script is written, not after. The ok verdict
  // carries the adapter survey (limits + vendor info) for the fleet line.
  const [webGpu, setWebGpu] = useState<WebGpuVerdict | null>(null);
  useEffect(() => {
    if (mode !== "script" || webGpu !== null) return;
    void checkWebGpu().then(setWebGpu);
  }, [mode, webGpu]);

  const { data: existingProjects = [], isLoading: projectsLoading } = useProjects();
  const { isAdmin } = useIsAdmin();
  const usage = projectUsage(existingProjects.length, { isAdmin });
  const oldest = oldestProject(existingProjects);
  const [confirmDeleteOldest, setConfirmDeleteOldest] = useState(false);
  const [deletingOldest, setDeletingOldest] = useState(false);
  const runDeleteProject = useServerFn(deleteProject);
  const queryClient = useQueryClient();

  /** Frees a slot in place, so the half-filled form below stays as it was. */
  const handleDeleteOldest = async () => {
    if (!oldest) return;
    setDeletingOldest(true);
    try {
      await runDeleteProject({ data: { projectId: oldest.id } });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
      toast.success(`Deleted "${oldest.name}". You can create a project now.`);
    } catch (err) {
      toast.error(describeUserFacingError(err, { fallback: "Could not delete the project." }));
    } finally {
      setDeletingOldest(false);
      setConfirmDeleteOldest(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      toast.error("Please select an audio file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File is larger than 500 MB.");
      return;
    }

    // Length is checked before the project row is created, so an over-long file
    // costs nothing — no row, no upload, no transcription bill.
    const durationSeconds = await readAudioDuration(file);
    const lengthCheck = checkAudioLength(durationSeconds);
    if (!lengthCheck.ok) {
      setBusy(false);
      toast.error(lengthCheck.message);
      return;
    }

    setBusy(true);
    setProgress(0);
    setStage("Creating project...");

    // 1. Create the project row (status: uploading)
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setBusy(false);
      toast.error("Not signed in.");
      return;
    }
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({
        name: name.trim() || "Untitled project",
        status: "uploading",
        user_id: userData.user.id,
        niche: category === "space" ? "space" : "general",
        category: category === "none" ? null : category,
        clip_duration_seconds: fixedClips ? clipDuration : null,
      })
      .select("id")
      .single();

    if (projectError || !project) {
      setBusy(false);
      toast.error(
        isProjectLimitError(projectError)
          ? PROJECT_LIMIT_MESSAGE
          : (projectError?.message ?? "Failed to create project."),
      );
      return;
    }

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
    const path = `${project.id}/${crypto.randomUUID()}.${ext}`;

    // 2. Get a signed upload URL from Storage (RLS on storage.objects gates this).
    setStage("Requesting signed upload URL...");
    const { data: signed, error: signedError } = await supabase.storage
      .from("audio")
      .createSignedUploadUrl(path);

    if (signedError || !signed) {
      await supabase
        .from("projects")
        .update({ status: "failed", error_message: "Could not get upload URL." })
        .eq("id", project.id);
      setBusy(false);
      toast.error(signedError?.message ?? "Could not get upload URL.");
      return;
    }

    // 3. Upload the file bytes directly to Storage via the signed URL.
    //    This does NOT proxy through a server function — bytes go straight to Supabase Storage.
    setStage("Uploading audio...");
    try {
      await uploadWithProgress(signed.signedUrl, file, setProgress);
    } catch (err) {
      await supabase
        .from("projects")
        .update({ status: "failed", error_message: "Upload failed." })
        .eq("id", project.id);
      setBusy(false);
      toast.error(describeUserFacingError(err));
      return;
    }

    // 4. Record the audio asset and mark the project as draft (ready for the render pipeline).
    setStage("Finalizing...");
    const { error: assetError } = await supabase.from("audio_assets").insert({
      project_id: project.id,
      storage_path: path,
      filename: file.name,
      file_size_bytes: file.size,
      mime_type: file.type || null,
    });

    if (assetError) {
      await supabase
        .from("projects")
        .update({ status: "failed", error_message: assetError.message })
        .eq("id", project.id);
      setBusy(false);
      toast.error(assetError.message);
      return;
    }

    await supabase.from("projects").update({ status: "uploaded" }).eq("id", project.id);

    // 5. Kick off transcription. Errors surface on the project detail page.
    setStage("Starting transcription...");
    try {
      await runStartPipeline({ data: { projectId: project.id } });
    } catch (err) {
      // If the pipeline call never reached the server, the project could sit at
      // "uploaded" indefinitely. Ensure it surfaces as "failed" either way.
      const message = (err as Error).message ?? "Failed to start transcription.";
      await supabase
        .from("projects")
        .update({ status: "failed", error_message: message })
        .eq("id", project.id)
        .in("status", ["uploaded", "draft"]);
      toast.error(message);
    }

    setBusy(false);
    toast.success("Project created.");
    navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
  };

  const runPersistScript = useServerFn(persistScriptTranscript);
  const runSubmitNarration = useServerFn(submitNarrationJob);
  const runPollNarration = useServerFn(pollNarrationJob);
  const runCompleteNarration = useServerFn(completeNarration);

  // ── The dtype comparison harness ──────────────────────────────────────────
  // Speaks PREVIEW_TEXT in the selected voice and plays it. Creates NOTHING —
  // no project, no upload, no rows. `?dtype=fp16|q8` on this page selects the
  // model variant (default fp32), so the operator can hear the dtypes on
  // identical input and read seconds-of-speech-per-second-of-compute for each
  // before one is chosen. Doubles as a voice-preview affordance for users.
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const handlePreviewVoice = async () => {
    if (webGpu && !webGpu.ok) {
      toast.error(webGpu.message);
      return;
    }
    setPreviewBusy(true);
    setPreviewNote(null);
    try {
      const dtype = parseDtypeParam(window.location.search);
      const { loadEngine, generateSpeech, PREVIEW_TEXT } = await import("@/lib/tts/generate");
      // Same label honesty as the main flow: the cache, not the events,
      // knows whether bytes will cross the network.
      const previewModelCached = await isModelCached(dtype);
      const engine = await loadEngine(
        (event) => {
          if (event.stage === "model") {
            const pct =
              event.totalBytes > 0 ? Math.round((event.loadedBytes / event.totalBytes) * 100) : 0;
            setPreviewNote(
              previewModelCached
                ? `Loading the ${dtype} voice model from your browser's cache — ${pct}%…`
                : `Downloading the ${dtype} voice model — ${pct}%… (one-time)`,
            );
          }
        },
        { dtype },
      );
      setPreviewNote("Generating the preview…");
      const startedAt = performance.now();
      const speech = await generateSpeech({
        sentences: splitScriptIntoSentences(PREVIEW_TEXT),
        voice,
        engine,
        onProgress: () => {},
        // Deliberately no onCalibration: the fixed three sentences ARE the
        // instrument, and a pause dialog would corrupt its timing.
      });
      const computeSec = (performance.now() - startedAt) / 1000;
      // Display direction: audio per compute — bigger is faster. The held
      // fleet measurements use the inverse (computeSecPerAudioSec, bigger is
      // slower); both are in the payload so nobody divides by memory.
      const audioSecPerComputeSec = speech.durationSec / computeSec;
      const note =
        `${speech.durationSec.toFixed(1)}s of speech in ${computeSec.toFixed(1)}s — ` +
        `${audioSecPerComputeSec.toFixed(1)}× realtime (${dtype})`;
      setPreviewNote(note);
      console.info("[tts-harness]", {
        dtype,
        voice,
        speechSec: Number(speech.durationSec.toFixed(2)),
        computeSec: Number(computeSec.toFixed(2)),
        // Kept name: this is audioSecPerComputeSec (the display ratio). Fleet
        // data already collected under this key; renaming would fork the survey.
        speedRatio: Number(audioSecPerComputeSec.toFixed(2)),
        computeSecPerAudioSec: Number((computeSec / speech.durationSec).toFixed(2)),
        modelCached: previewModelCached,
        // Fleet survey (A3): the adapter's size limits and identity, so a
        // defensible capability threshold can be set from data later.
        ...(webGpu?.ok
          ? {
              maxBufferSize: webGpu.survey.maxBufferSize,
              maxStorageBufferBindingSize: webGpu.survey.maxStorageBufferBindingSize,
              adapter: webGpu.survey.info,
            }
          : {}),
      });
      const url = URL.createObjectURL(speech.wavBlob);
      const player = new Audio(url);
      player.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await player.play();
    } catch (err) {
      setPreviewNote(null);
      toast.error(describeUserFacingError(err));
    } finally {
      setPreviewBusy(false);
    }
  };

  /**
   * The script path (Round B: server-side). Sanitisation and splitting run
   * HERE — the worker performs zero text processing, so the sentences the
   * scenes are built from are the sentences spoken, byte for byte. The
   * project row is created first in an honestly-named state
   * ('generating_narration'); the tts-worker synthesises and uploads the WAV
   * server-side; then the handoff replays the upload path's own tail:
   * audio_assets -> status 'uploading' -> the unchanged
   * persistScriptTranscript. A closed tab loses nothing: the project page
   * resumes this exact loop (narration-client.ts) on the next visit.
   *
   * No WebGPU gate here any more — the server renders speech for machines
   * the browser path refused or crawled on. The Preview button keeps its
   * browser engine (and its gate) as the measurement instrument.
   */
  const handleScriptSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const verdict = checkScript(script);
    if (!verdict.ok) {
      toast.error(verdict.message);
      return;
    }

    setBusy(true);
    setProgress(0);
    let projectId: string | null = null;
    try {
      const sentences = splitScriptIntoSentences(script);

      setStage("Creating project…");
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in.");
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({
          name: name.trim() || "Untitled project",
          status: "generating_narration",
          user_id: userData.user.id,
          niche: category === "space" ? "space" : "general",
          category: category === "none" ? null : category,
          clip_duration_seconds: fixedClips ? clipDuration : null,
        })
        .select("id")
        .single();
      if (projectError || !project) {
        throw new Error(
          isProjectLimitError(projectError)
            ? PROJECT_LIMIT_MESSAGE
            : (projectError?.message ?? "Failed to create project."),
        );
      }
      projectId = project.id;

      setStage("Sending the script to the narration server…");
      await runSubmitNarration({
        data: { projectId: project.id, sentences, voice, fullText: script.trim() },
      });

      const drive = await driveNarration({
        projectId: project.id,
        poll: (args) => runPollNarration(args),
        complete: (args) => runCompleteNarration(args),
        persist: async (completion) => {
          setStage("Setting up scenes…");
          await runPersistScript({
            data: {
              projectId: project.id,
              fullText: completion.fullText,
              voice: completion.voice,
              durationSec: completion.durationSec,
              sentences: completion.sentences,
            },
          });
        },
        onStage: setStage,
        estimatedAudioSec: estimateSpokenSeconds(script),
      });
      if (drive.outcome === "failed") throw new Error(drive.message);

      setBusy(false);
      toast.success("Project created.");
      navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    } catch (err) {
      setBusy(false);
      // Before the project row exists, failure leaves nothing to clean up.
      // After it, surface the failure on the project the user will find.
      if (projectId) {
        // generating_narration included: the server path's project sits there
        // while it fails. Terminal and pipeline states are left alone — the
        // poll may already have written a more specific message.
        await supabase
          .from("projects")
          .update({ status: "failed", error_message: describeUserFacingError(err) })
          .eq("id", projectId)
          .in("status", ["generating_narration", "uploading", "draft"]);
      }
      toast.error(describeUserFacingError(err));
    }
  };

  if (projectsLoading) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
        <Skeleton className="h-96 w-full" />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="mt-5 text-2xl font-semibold">New project</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {usage.exempt
            ? `${usage.count} project${usage.count === 1 ? "" : "s"} — no limit on this account`
            : `${usage.count} of ${PROJECT_LIMIT} project slots used`}
        </p>
      </div>

      {/*
        Being at the limit is a notice, not a wall. The form stays reachable and
        filled in: a user who arrives here with a file picked should be able to
        free a slot and submit, rather than be bounced to a dead-end page that
        discards everything they had entered.
      */}
      {usage.atLimit ? (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Both project slots are in use</AlertTitle>
          <AlertDescription className="mt-2 space-y-3">
            <p>{PROJECT_LIMIT_MESSAGE}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!oldest || deletingOldest}
                onClick={() => setConfirmDeleteOldest(true)}
              >
                {deletingOldest ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                {oldest ? `Delete "${oldest.name}"` : "Delete oldest project"}
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link to="/projects">
                  <FolderKanban className="mr-2 h-4 w-4" />
                  Choose another
                </Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/*
        Round B: the per-machine calibration dialog is gone with the local
        generation it measured — narration runs on the server at a known rate,
        and the progress card's queue position and ETA replace it. The
        measured-estimate machinery survives intact in generate.ts for the
        Preview instrument.
      */}
      <AlertDialog open={confirmDeleteOldest} onOpenChange={setConfirmDeleteOldest}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{oldest?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This is your oldest project, created{" "}
              {oldest ? formatDistanceToNow(new Date(oldest.created_at), { addSuffix: true }) : ""}.
              Its audio, scenes and any rendered video are permanently removed. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteOldest}>Delete project</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <CardTitle>Create a project</CardTitle>
          <CardDescription>
            Name it, upload an audio track, and we'll set it up. Rendering starts in a later phase.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={mode === "audio" ? handleSubmit : handleScriptSubmit}
            className="space-y-6"
          >
            <div className="space-y-2">
              <Label htmlFor="name">Project name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My awesome video"
                disabled={busy}
              />
            </div>

            <Tabs value={mode} onValueChange={(value) => setMode(value as "audio" | "script")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="audio" disabled={busy}>
                  Upload narration
                </TabsTrigger>
                <TabsTrigger value="script" disabled={busy}>
                  Write a script
                </TabsTrigger>
              </TabsList>

              <TabsContent value="audio" className="space-y-2 pt-2">
                <Label htmlFor="audio">Audio file</Label>
                <div className="rounded-md border border-dashed p-6 text-center">
                  <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                  <input
                    id="audio"
                    type="file"
                    accept={ACCEPTED}
                    disabled={busy}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-secondary file:px-4 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
                  />
                  <p className="text-xs text-muted-foreground">
                    Up to 500 MB and {formatDuration(MAX_AUDIO_DURATION_SECONDS)} of narration.
                    Longer scripts should be split into separate projects.
                  </p>
                  {file ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {file.name} — {(file.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      MP3, WAV, M4A, FLAC, OGG — up to 500 MB
                    </p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="script" className="space-y-4 pt-2">
                {/* Round B: no WebGPU refusal here any more — narration runs
                    on the server, so the machines the browser path refused
                    are exactly who this serves. Only Preview (the browser
                    instrument) still needs the gate. */}
                <div className="space-y-2">
                  <Label htmlFor="script">Script</Label>
                  <Textarea
                    id="script"
                    value={script}
                    onChange={(e) => {
                      setScript(e.target.value);
                      const verdict = checkScript(e.target.value);
                      setScriptWarning(verdict.ok ? (verdict.warning ?? null) : null);
                    }}
                    placeholder="Paste your narration script here…"
                    rows={10}
                    disabled={busy}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {script.trim()
                        ? `${script.trim().split(/\s+/).length} words, ~${splitScriptIntoSentences(script).length} scenes`
                        : `Spoken in the voice you pick below — up to ${formatDuration(MAX_AUDIO_DURATION_SECONDS)} of narration.`}
                    </p>
                    <label className="shrink-0 cursor-pointer text-xs font-medium text-primary hover:underline">
                      Load from .txt or .docx
                      <input
                        type="file"
                        accept=".txt,.docx,text/plain"
                        className="hidden"
                        disabled={busy}
                        onChange={async (e) => {
                          const chosen = e.target.files?.[0];
                          e.target.value = "";
                          if (!chosen) return;
                          try {
                            const text = await extractScriptText(chosen);
                            setScript(text);
                            const verdict = checkScript(text);
                            setScriptWarning(verdict.ok ? (verdict.warning ?? null) : null);
                          } catch (err) {
                            toast.error(describeUserFacingError(err));
                          }
                        }}
                      />
                    </label>
                  </div>
                  {scriptWarning ? (
                    <p className="text-xs text-amber-600 dark:text-amber-500">{scriptWarning}</p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="voice">Voice</Label>
                  <Select value={voice} onValueChange={setVoice} disabled={busy}>
                    <SelectTrigger id="voice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TTS_VOICES.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Narration is generated on our server — no download, and closing this tab
                    won't stop it. Preview uses your browser and needs WebGPU.
                  </p>
                  <div className="flex items-center gap-3 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={previewBusy || busy || (webGpu != null && !webGpu.ok)}
                      onClick={() => void handlePreviewVoice()}
                    >
                      {previewBusy ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                      Preview voice
                    </Button>
                    {previewNote ? (
                      <p className="text-xs text-muted-foreground">{previewNote}</p>
                    ) : null}
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="space-y-2">
              <Label htmlFor="category">Visual theme</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as CategoryValue)}
                disabled={busy}
              >
                <SelectTrigger id="category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (no thematic bias)</SelectItem>
                  <SelectItem value="war">War / military conflict</SelectItem>
                  <SelectItem value="crime">Crime / law enforcement</SelectItem>
                  <SelectItem value="space">Space / astronomy</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Biases every generated footage search toward this theme. Leave as None to keep
                queries literal.
              </p>
            </div>

            <div className="space-y-3 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="fixed-clips">Fixed clip length</Label>
                  <p className="text-xs text-muted-foreground">
                    Off: one clip per sentence, natural length. On: each scene is split into clips
                    of this length.
                  </p>
                </div>
                <Switch
                  id="fixed-clips"
                  checked={fixedClips}
                  onCheckedChange={setFixedClips}
                  disabled={busy}
                />
              </div>
              {fixedClips ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <Label htmlFor="clip-duration">Clip duration</Label>
                    <span className="font-medium tabular-nums">{clipDuration}s</span>
                  </div>
                  <Slider
                    id="clip-duration"
                    min={3}
                    max={6}
                    step={1}
                    value={[clipDuration]}
                    onValueChange={(v) => setClipDuration(v[0])}
                    disabled={busy}
                  />
                </div>
              ) : null}
            </div>

            {busy ? (
              <div className="space-y-2">
                <Progress value={progress} />
                <p className="text-xs text-muted-foreground">
                  {stage} {progress > 0 ? `(${progress}%)` : ""}
                </p>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" asChild disabled={busy}>
                <Link to="/dashboard">Cancel</Link>
              </Button>
              <Button
                type="submit"
                disabled={busy || (mode === "audio" ? !file : !script.trim())}
              >
                {busy ? "Working…" : "Create project"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}


function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}
