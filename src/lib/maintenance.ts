/**
 * Maintenance mode policy: what is allowed, and what a refusal says.
 *
 * Pure and dependency-free, so every rule here is testable without a database,
 * a session or a request — and so the server guard and the UI cannot drift into
 * disagreeing about what is blocked. A hidden button is not a permission: the
 * UI uses this to decide what to grey out, the server uses the SAME function to
 * decide what to reject, and the server is the one that counts.
 */

/** Everything a caller might try to do that maintenance has an opinion about. */
export type MaintenanceAction =
  // Read-only: allowed during maintenance. Someone who wants yesterday's video
  // should not be blocked by a deploy.
  | "sign_in"
  | "view_dashboard"
  | "view_project"
  | "download_video"
  // Mutating: blocked.
  | "create_project"
  | "upload_audio"
  | "start_pipeline"
  | "retry_pipeline"
  | "swap_clip"
  | "start_render"
  | "cancel_render"
  | "delete_project"
  | "admin_action";

/**
 * The actions that survive a freeze.
 *
 * An allowlist, not a blocklist. A new mutating action added later is blocked
 * by default, which is the safe direction to be wrong in: the cost of wrongly
 * blocking something is an operator noticing during maintenance, and the cost
 * of wrongly allowing it is a write landing mid-migration.
 */
export const READ_ONLY_ACTIONS: readonly MaintenanceAction[] = [
  "sign_in",
  "view_dashboard",
  "view_project",
  "download_video",
];

export type MaintenanceState = {
  enabled: boolean;
  message: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
  /** Which source decided `enabled`. */
  source: "env" | "database";
  /** The env var's value, or null when unset. */
  envOverride: boolean | null;
  /** True when the env var is actively contradicting the stored flag. */
  overridden: boolean;
  /** What the database row says, regardless of who won. */
  storedEnabled: boolean;
};

/**
 * The env var, as a tri-state.
 *
 * Tri-state and not truthiness, because the override has to work in BOTH
 * directions: MAINTENANCE_MODE=false must force maintenance OFF even when the
 * database says on. Treating "false" as merely absent would leave the emergency
 * brake unable to release the brake — and the case it exists for is the one
 * where the dashboard that would turn it off is itself unreachable.
 */
export function parseMaintenanceEnv(raw: string | undefined | null): boolean | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "on", "yes", "enabled"].includes(value)) return true;
  if (["0", "false", "off", "no", "disabled"].includes(value)) return false;
  // An unrecognised value is not a licence to guess. The safe reading of a
  // malformed emergency brake is "the operator meant to pull it".
  return true;
}

/** Merges the stored row with the env override. Mirrors the worker's copy exactly. */
export function resolveMaintenanceState(
  stored: { enabled?: boolean | null; message?: string | null; enabled_at?: string | null; enabled_by?: string | null } | null,
  envOverride: boolean | null,
): MaintenanceState {
  const storedEnabled = stored?.enabled === true;
  return {
    enabled: envOverride == null ? storedEnabled : envOverride,
    message: stored?.message ?? null,
    enabledAt: stored?.enabled_at ?? null,
    enabledBy: stored?.enabled_by ?? null,
    source: envOverride == null ? "database" : "env",
    envOverride,
    overridden: envOverride != null && envOverride !== storedEnabled,
    storedEnabled,
  };
}

export type MaintenanceDecision = {
  allowed: boolean;
  /** Why it was refused, in plain language. Null when allowed. */
  reason: string | null;
};

/**
 * May this caller do this, right now?
 *
 * The single authority. Admins bypass entirely — the operator has to be able to
 * use the platform during maintenance to check that the fix actually worked,
 * and a maintenance mode that locks out the person doing the maintenance is a
 * maintenance mode nobody will turn on.
 */
export function decideMaintenance({
  state,
  action,
  isAdmin,
}: {
  state: Pick<MaintenanceState, "enabled" | "message">;
  action: MaintenanceAction;
  isAdmin: boolean;
}): MaintenanceDecision {
  if (!state.enabled) return { allowed: true, reason: null };
  if (isAdmin) return { allowed: true, reason: null };
  if (READ_ONLY_ACTIONS.includes(action)) return { allowed: true, reason: null };
  return { allowed: false, reason: describeBlockedAction(action, state.message) };
}

/** Human phrasing for the actions worth naming specifically. */
const ACTION_PHRASING: Partial<Record<MaintenanceAction, string>> = {
  create_project: "New projects cannot be started",
  upload_audio: "Uploads are paused",
  start_pipeline: "Starting a project is paused",
  retry_pipeline: "Retrying is paused",
  swap_clip: "Changing clips is paused",
  start_render: "Starting a render is paused",
  cancel_render: "Cancelling a render is paused",
  delete_project: "Deleting projects is paused",
  admin_action: "Admin changes are paused",
};

/**
 * The refusal a user reads.
 *
 * A clear message, not an error: nothing has gone wrong, and the words should
 * not suggest it has. Says what is paused, that their work is safe, and that it
 * resumes on its own — because the question a blocked user actually has is "did
 * I just lose something", and the answer is no.
 */
export function describeBlockedAction(
  action: MaintenanceAction,
  message: string | null,
): string {
  const what = ACTION_PHRASING[action] ?? "That action is paused";
  const when = message ? ` ${message.trim().replace(/\.$/, "")}.` : "";
  return `${what} while the platform is being updated.${when} Anything already running is safe and will continue automatically — nothing has been lost.`;
}

/**
 * The banner and notice text.
 *
 * Admins get a different line on purpose: theirs has to be impossible to
 * ignore, because the failure mode for an admin is forgetting maintenance is on
 * and leaving users frozen out for hours.
 */
export function describeMaintenanceNotice({
  state,
  isAdmin,
}: {
  state: Pick<MaintenanceState, "enabled" | "message" | "source" | "overridden">;
  isAdmin: boolean;
}): { headline: string; detail: string } | null {
  if (!state.enabled) return null;

  const estimate = state.message?.trim() ? state.message.trim() : null;

  if (isAdmin) {
    return {
      headline: "Maintenance mode is ON — users are in read-only mode",
      detail: state.overridden
        ? "Set by the MAINTENANCE_MODE environment variable, which overrides the dashboard toggle. You have full access."
        : `You have full access; everyone else can sign in, browse and download but cannot start work.${estimate ? ` Users are told: “${estimate}”.` : ""}`,
    };
  }

  return {
    headline: "The platform is being improved",
    detail: estimate
      ? `${estimate.replace(/\.$/, "")}. Anything already running is safe and paused — it will continue automatically. You can still browse your projects and download finished videos.`
      : "Anything already running is safe and paused — it will continue automatically. You can still browse your projects and download finished videos.",
  };
}

/**
 * What a frozen project's owner sees on the project itself.
 *
 * Shows how far it got, because "paused" without a position is indistinguishable
 * from "stuck" — the same confusion that made a working 90%-complete project
 * look broken twice before.
 */
export function describeFrozenProject({
  chunksCompleted,
  chunksTotal,
}: {
  chunksCompleted?: number | null;
  chunksTotal?: number | null;
}): string {
  const base = "Paused for maintenance — your project is safe and will continue automatically.";
  if (chunksTotal == null || chunksTotal <= 0 || chunksCompleted == null || chunksCompleted < 0) {
    return base;
  }
  return `${base} It reached ${Math.min(chunksCompleted, chunksTotal)} of ${chunksTotal} segments, and will pick up from there.`;
}

/**
 * The confirmation shown before freezing.
 *
 * Names what is about to be interrupted. Turning maintenance on is not
 * dangerous, but doing it without knowing three renders are mid-flight is how
 * an operator ends up surprised.
 */
export function describeFreezeImpact({
  rendering,
  matching,
}: {
  rendering: number;
  matching: number;
}): string {
  const parts: string[] = [];
  if (rendering > 0) parts.push(`${rendering} project${rendering === 1 ? "" : "s"} rendering`);
  if (matching > 0) parts.push(`${matching} matching`);
  if (parts.length === 0) {
    return "Nothing is running right now, so nothing will be interrupted.";
  }
  return `${parts.join(" and ")} will pause. Work already done is kept — renders resume from the segment they reached, not from the beginning.`;
}
