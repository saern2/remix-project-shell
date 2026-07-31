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

export function projectUsage(count: number) {
  return {
    count,
    remaining: Math.max(0, PROJECT_LIMIT - count),
    atLimit: count >= PROJECT_LIMIT,
  };
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
