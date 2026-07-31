import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { startPipeline } from "@/lib/pipeline.functions";
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
import { ArrowLeft, Upload } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/projects/new")({
  component: NewProject,
});

const ACCEPTED =
  "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/m4a,audio/aac,audio/flac";
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

type CategoryValue = "none" | "war" | "crime";
type NicheValue = "general" | "space";

function NewProject() {
  const navigate = useNavigate();
  const runStartPipeline = useServerFn(startPipeline);
  const [name, setName] = useState("");
  const [niche, setNiche] = useState<NicheValue>("general");
  const [category, setCategory] = useState<CategoryValue>("none");
  const [fixedClips, setFixedClips] = useState(false);
  const [clipDuration, setClipDuration] = useState(4);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<string>("");

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
        niche,
        category: category === "none" ? null : category,
        clip_duration_seconds: fixedClips ? clipDuration : null,
      })
      .select("id")
      .single();

    if (projectError || !project) {
      setBusy(false);
      toast.error(projectError?.message ?? "Failed to create project.");
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
      toast.error((err as Error).message);
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

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/dashboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">New project</h1>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Create a project</CardTitle>
            <CardDescription>
              Name it, upload an audio track, and we'll set it up. Rendering starts in a later
              phase.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
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

              <div className="space-y-2">
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
              </div>

              <div className="space-y-2">
                <Label htmlFor="niche">Footage source niche</Label>
                <Select
                  value={niche}
                  onValueChange={(v) => setNiche(v as NicheValue)}
                  disabled={busy}
                >
                  <SelectTrigger id="niche">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">General stock libraries</SelectItem>
                    <SelectItem value="space">Space (NASA first, stock fallback)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Space projects try NASA's public video library first for each scene, then fall
                  back when no usable clip fits.
                </p>
              </div>

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
                <Button type="submit" disabled={busy || !file}>
                  {busy ? "Uploading..." : "Create project"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
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
