export const PROJECT_LIMIT = 2;
export const PROJECT_LIMIT_ERROR = "PROJECT_LIMIT_REACHED";
export const PROJECT_LIMIT_MESSAGE =
  "You're using 2 of 2 project slots. Delete a project to create another.";

export function isProjectLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [candidate.message, candidate.details, candidate.hint].some(
    (value) => typeof value === "string" && value.includes(PROJECT_LIMIT_ERROR),
  );
}

/**
 * @param options.isAdmin Administrators are exempt from the limit — they operate
 *   the platform and need projects to reproduce user problems. Mirrors the
 *   database trigger, which is the real gate: the client inserts straight into
 *   PostgREST, so a UI-only exemption would still be rejected.
 */
export function projectUsage(count: number, options: { isAdmin?: boolean } = {}) {
  const exempt = options.isAdmin === true;
  return {
    count,
    exempt,
    remaining: exempt ? Number.POSITIVE_INFINITY : Math.max(0, PROJECT_LIMIT - count),
    atLimit: !exempt && count >= PROJECT_LIMIT,
  };
}

/**
 * The project a "free up a slot" action should offer to delete: the oldest.
 *
 * Oldest rather than, say, the least recently touched, because it is the one
 * choice a user can predict without opening anything — and the action always
 * names it and asks before deleting.
 */
export function oldestProject<T extends { created_at: string }>(projects: T[]): T | null {
  if (projects.length === 0) return null;
  return [...projects].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )[0];
}

export function summarizeProjectStatuses(projects: Array<{ status: string }>) {
  const activeStatuses = new Set([
    "uploading",
    "uploaded",
    "transcribing",
    "generating_scenes",
    "matching_footage",
    "ready",
    "rendering",
  ]);
  return {
    total: projects.length,
    active: projects.filter((project) => activeStatuses.has(project.status)).length,
    completed: projects.filter((project) => project.status === "completed").length,
    attention: projects.filter(
      (project) => project.status === "failed" || project.status === "cancelled",
    ).length,
  };
}
