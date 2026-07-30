import { createClient } from "@supabase/supabase-js";

const EXPIRY_HOURS = 30;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const STORAGE_REMOVE_BATCH_SIZE = 100;
const CANCEL_TIMEOUT_MS = 60_000;
const CANCEL_POLL_MS = 3_000;

const ACTIVE_RENDER_STATUSES = new Set(["rendering", "stitching"]);
const STOPPED_RENDER_STATUSES = new Set(["cancelled", "completed", "failed"]);

type CleanupProject = {
  id: string;
  name: string | null;
  status: string | null;
  created_at: string;
  audio_assets?: Array<{ storage_path: string | null }> | null;
  render_jobs?:
    | Array<{ id: string; status: string | null; created_at: string | null }>
    | null;
};

type StorageObject = {
  bucket_id: string;
  name: string;
  metadata: Record<string, unknown> | null;
};

type CleanupObject = {
  bucket: "audio" | "render-outputs";
  name: string;
  bytes: number;
  exists: boolean;
  source: "audio_assets" | "render_prefix";
};

type ProjectResult = {
  projectId: string;
  name: string | null;
  status: string | null;
  createdAt: string;
  activeRenderJobIds: string[];
  cancelledRenderJobIds: string[];
  fileCount: number;
  bytes: number;
  objects: CleanupObject[];
  action: "would_delete" | "deleted" | "skipped";
  skipReason: string | null;
};

type CleanupRequest = {
  dryRun?: boolean;
  limit?: number;
  projectIds?: string[];
};

// This function queries both the public schema and storage.objects. The app's
// generated Database type is not available in the Edge Function runtime.
type QueryError = { message: string };

type QueryResponse<T> = {
  data: T | null;
  error: QueryError | null;
};

type QueryBuilder<T> = PromiseLike<QueryResponse<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, values: unknown[]): QueryBuilder<T>;
  like(column: string, pattern: string): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
};

type SupabaseAdmin = {
  from<T>(table: string): QueryBuilder<T>;
  schema(schema: string): { from<T>(table: string): QueryBuilder<T> };
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<QueryResponse<unknown>>;
  storage: {
    from(bucket: string): {
      remove(paths: string[]): Promise<{ error: QueryError | null }>;
    };
  };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readJsonSecretMap(name: string, key: string): string | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed[key] ?? null;
  } catch {
    return null;
  }
}

function requiredEnv(name: string, fallback?: string | null): string {
  const value = Deno.env.get(name) ?? fallback ?? null;
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function serviceRoleKey(): string {
  return (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SB_SERVICE_ROLE_KEY") ??
      readJsonSecretMap("SUPABASE_SECRET_KEYS", "default") ??
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
  );
}

function clampBatchSize(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(input)));
}

function sanitizeProjectIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return unique(
    input
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => uuidPattern.test(id)),
  ).slice(0, MAX_BATCH_SIZE);
}

function objectBytes(
  object: Pick<StorageObject, "metadata"> | undefined,
): number {
  const size = object?.metadata?.size;
  const bytes = typeof size === "number"
    ? size
    : typeof size === "string"
    ? Number(size)
    : 0;
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadExpiredProjects(
  supabase: SupabaseAdmin,
  limit: number,
  projectIds: string[],
) {
  const cutoff = new Date(Date.now() - EXPIRY_HOURS * 60 * 60 * 1000)
    .toISOString();
  let query = supabase
    .from("projects")
    .select(
      "id, name, status, created_at, audio_assets(storage_path), render_jobs(id, status, created_at)",
    )
    .lt("created_at", cutoff);

  if (projectIds.length > 0) {
    query = query.in("id", projectIds);
  }

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load expired projects: ${error.message}`);
  }
  return { cutoff, projects: (data ?? []) as CleanupProject[] };
}

async function loadStorageObjects(
  supabase: SupabaseAdmin,
  project: CleanupProject,
): Promise<CleanupObject[]> {
  const audioPaths = unique(
    (project.audio_assets ?? [])
      .map((asset) => asset.storage_path)
      .filter((path): path is string => Boolean(path)),
  );

  const audioRows = new Map<string, StorageObject>();
  if (audioPaths.length > 0) {
    const { data, error } = await supabase
      .schema("storage")
      .from("objects")
      .select("bucket_id, name, metadata")
      .eq("bucket_id", "audio")
      .in("name", audioPaths);
    if (error) {
      throw new Error(
        `Failed to inspect audio storage objects: ${error.message}`,
      );
    }
    for (const row of (data ?? []) as StorageObject[]) {
      audioRows.set(row.name, row);
    }
  }

  const { data: renderRows, error: renderErr } = await supabase
    .schema("storage")
    .from("objects")
    .select("bucket_id, name, metadata")
    .eq("bucket_id", "render-outputs")
    .like("name", `${project.id}/%`);
  if (renderErr) {
    throw new Error(
      `Failed to inspect render output storage objects: ${renderErr.message}`,
    );
  }

  const audioObjects: CleanupObject[] = audioPaths.map((name) => {
    const row = audioRows.get(name);
    return {
      bucket: "audio",
      name,
      bytes: objectBytes(row),
      exists: Boolean(row),
      source: "audio_assets",
    };
  });

  const renderObjects: CleanupObject[] = ((renderRows ?? []) as StorageObject[])
    .map((row) => ({
      bucket: "render-outputs",
      name: row.name,
      bytes: objectBytes(row),
      exists: true,
      source: "render_prefix",
    }));

  return [...audioObjects, ...renderObjects];
}

async function removeStorageObjects(
  supabase: SupabaseAdmin,
  objects: CleanupObject[],
): Promise<void> {
  for (const bucket of ["audio", "render-outputs"] as const) {
    const paths = unique(
      objects
        .filter((object) => object.bucket === bucket)
        .map((object) => object.name)
        .filter(Boolean),
    );
    for (const batch of chunk(paths, STORAGE_REMOVE_BATCH_SIZE)) {
      const { error } = await supabase.storage.from(bucket).remove(batch);
      if (error) {
        throw new Error(
          `Failed to remove ${bucket} storage objects: ${error.message}`,
        );
      }
    }
  }
}

async function cancelRenderJob(jobId: string): Promise<void> {
  const workerUrl = requiredEnv("RENDER_WORKER_URL").replace(/\/+$/, "");
  const workerKey = requiredEnv("RENDER_WORKER_API_KEY");

  const cancelRes = await fetch(`${workerUrl}/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: { "X-Api-Key": workerKey },
  });
  if (!cancelRes.ok) {
    const detail = await cancelRes.text().catch(() => "");
    throw new Error(
      `Worker cancel failed for ${jobId} (${cancelRes.status}): ${
        detail.slice(0, 200)
      }`,
    );
  }

  const started = Date.now();
  while (Date.now() - started < CANCEL_TIMEOUT_MS) {
    await sleep(CANCEL_POLL_MS);
    const statusRes = await fetch(`${workerUrl}/jobs/${jobId}`, {
      method: "GET",
      headers: { "X-Api-Key": workerKey },
    });

    if (statusRes.status === 404) return;
    if (!statusRes.ok) {
      const detail = await statusRes.text().catch(() => "");
      throw new Error(
        `Worker poll failed for ${jobId} (${statusRes.status}): ${
          detail.slice(0, 200)
        }`,
      );
    }

    const payload = (await statusRes.json().catch(() => ({}))) as {
      status?: string;
    };
    const status = String(payload.status ?? "").toLowerCase();
    if (STOPPED_RENDER_STATUSES.has(status)) return;
  }

  throw new Error(
    `Timed out waiting for render job ${jobId} to stop after cancel.`,
  );
}

async function deleteProjectWithAudit(
  supabase: SupabaseAdmin,
  project: CleanupProject,
  objects: CleanupObject[],
  cancelledRenderJobIds: string[],
): Promise<void> {
  const existingObjects = objects.filter((object) => object.exists);
  const { error } = await supabase.rpc("cleanup_delete_project_with_audit", {
    p_project_id: project.id,
    p_project_name: project.name,
    p_project_created_at: project.created_at,
    p_project_status: project.status,
    p_file_count_removed: existingObjects.length,
    p_bytes_freed: existingObjects.reduce(
      (sum, object) => sum + object.bytes,
      0,
    ),
    p_active_render_cancelled: cancelledRenderJobIds.length > 0,
    p_cancelled_render_job_ids: cancelledRenderJobIds,
  });
  if (error) throw new Error(`Failed to delete project row: ${error.message}`);
}

async function processProject(
  supabase: SupabaseAdmin,
  project: CleanupProject,
  dryRun: boolean,
): Promise<ProjectResult> {
  const activeJobs = (project.render_jobs ?? []).filter((job) =>
    ACTIVE_RENDER_STATUSES.has(String(job.status ?? "").toLowerCase())
  );
  const objects = await loadStorageObjects(supabase, project);
  const existingObjects = objects.filter((object) => object.exists);
  const cancelledRenderJobIds: string[] = [];

  if (dryRun) {
    return {
      projectId: project.id,
      name: project.name,
      status: project.status,
      createdAt: project.created_at,
      activeRenderJobIds: activeJobs.map((job) => job.id),
      cancelledRenderJobIds,
      fileCount: existingObjects.length,
      bytes: existingObjects.reduce((sum, object) => sum + object.bytes, 0),
      objects,
      action: "would_delete",
      skipReason: null,
    };
  }

  try {
    for (const job of activeJobs) {
      await cancelRenderJob(job.id);
      cancelledRenderJobIds.push(job.id);
    }

    await removeStorageObjects(supabase, objects);
    await deleteProjectWithAudit(
      supabase,
      project,
      objects,
      cancelledRenderJobIds,
    );

    return {
      projectId: project.id,
      name: project.name,
      status: project.status,
      createdAt: project.created_at,
      activeRenderJobIds: activeJobs.map((job) => job.id),
      cancelledRenderJobIds,
      fileCount: existingObjects.length,
      bytes: existingObjects.reduce((sum, object) => sum + object.bytes, 0),
      objects,
      action: "deleted",
      skipReason: null,
    };
  } catch (err) {
    return {
      projectId: project.id,
      name: project.name,
      status: project.status,
      createdAt: project.created_at,
      activeRenderJobIds: activeJobs.map((job) => job.id),
      cancelledRenderJobIds,
      fileCount: existingObjects.length,
      bytes: existingObjects.reduce((sum, object) => sum + object.bytes, 0),
      objects,
      action: "skipped",
      skipReason: err instanceof Error
        ? err.message
        : "Project cleanup failed.",
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  try {
    const expectedSecret = requiredEnv("CLEANUP_CRON_SECRET");
    if (req.headers.get("x-cleanup-secret") !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as CleanupRequest;
    const dryRun = body.dryRun !== false;
    const limit = clampBatchSize(body.limit);
    const projectIds = sanitizeProjectIds(body.projectIds);
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey(),
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    ) as unknown as SupabaseAdmin;

    const { cutoff, projects } = await loadExpiredProjects(
      supabase,
      limit,
      projectIds,
    );
    const results: ProjectResult[] = [];
    for (const project of projects) {
      results.push(await processProject(supabase, project, dryRun));
    }

    const totals = results.reduce(
      (acc, result) => {
        if (result.action === "deleted") acc.projectsDeleted += 1;
        if (result.action === "would_delete") acc.projectsWouldDelete += 1;
        if (result.action === "skipped") acc.projectsSkipped += 1;
        acc.files += result.fileCount;
        acc.bytes += result.bytes;
        acc.activeRenderJobs += result.activeRenderJobIds.length;
        acc.cancelledRenderJobs += result.cancelledRenderJobIds.length;
        return acc;
      },
      {
        projectsDeleted: 0,
        projectsWouldDelete: 0,
        projectsSkipped: 0,
        files: 0,
        bytes: 0,
        activeRenderJobs: 0,
        cancelledRenderJobs: 0,
      },
    );

    const response = {
      ok: true,
      dryRun,
      expiryHours: EXPIRY_HOURS,
      cutoff,
      limit,
      projectIdsFilter: projectIds,
      scannedProjects: projects.length,
      totals: {
        ...totals,
        mb: Math.round((totals.bytes / 1024 / 1024) * 100) / 100,
      },
      projects: results,
    };

    console.log("[cleanup-expired-projects]", JSON.stringify(response));
    return json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cleanup failed.";
    console.error("[cleanup-expired-projects:error]", message);
    return json({ ok: false, error: message }, 500);
  }
});
