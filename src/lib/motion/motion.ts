/**
 * Motion explainers (Round D): the pure logic and the mandated copy.
 *
 * The worker does the 30-60 minute work; this module owns what the app can
 * decide without it — the poll verdict (failure honesty at read time, the
 * narration round's shape), the stage line, the model list with its honesty
 * labels, and the Item 4 copy blocks, exported as constants so tests pin
 * them character for character.
 */

/** Deterministic ids: resuming needs nothing a closed tab knew. */
export function motionJobId(projectId: string): string {
  return `motion-${projectId}`;
}

/** Matches pollRenderJob's re-sign convention: `${project_id}/${render_job_id}.mp4`. */
export function motionStoragePath(projectId: string, renderJobId: string): string {
  return `${projectId}/${renderJobId}.mp4`;
}

/**
 * The whole generating_motion state's ceiling, applied at read time — the
 * same C3 lesson as narration. Worst legitimate case: a full queue (4 jobs
 * at the measured ~42 min) ahead of a 60-minute-capped job ≈ 3.8 h; 8 h is
 * double that.
 */
export const MOTION_STALE_AFTER_HOURS = 8;

export const MOTION_STALE_MESSAGE =
  "The explainer did not finish in a reasonable time, so this project was stopped. " +
  "Your API key was not charged further — please create the project again.";

export const MOTION_LOST_MESSAGE =
  "The explainer service lost track of this job. Please create the project again.";

/**
 * The models offered, with honesty labels from the measured runs
 * (2026-08-26/28): GLM and DeepSeek (v4 Flash — the id that actually ran
 * the 28 Aug job) completed end to end; Claude was unavailable both
 * earlier times — AgentRouter releases Claude in daily batches (23:00 and
 * 11:00 UTC) and returns 402 in between. Opus 4.8 is offered as the
 * fallback when Opus 5 is batch-limited. The worker passes the id through
 * to the provider verbatim, so every id here must match AgentRouter's
 * exactly — a wrong string is a failed job.
 */
export const MOTION_MODELS: Array<{ id: string; label: string }> = [
  { id: "glm-5.3", label: "GLM 5.3 — verified working" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash — verified working" },
  { id: "claude-opus-5", label: "Claude Opus 5 — released in daily batches, may be unavailable" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — fallback when Opus 5 is unavailable" },
];

/** The AgentRouter signup link (referral; disclosure line sits beneath it). */
export const AGENTROUTER_SIGNUP_URL = "https://agentrouter.org/register?aff=sF1j";

/** Item 4's mandated copy, verbatim — pinned by test. */
export const MOTION_KEY_COPY = {
  intro:
    "You'll need your own API key. Motion explainers are generated using your own AI provider account, so you control the cost.",
  linkLabel: "Get a free AgentRouter key →",
  /** D10: plain disclosure beneath the link. */
  referralDisclosure: "We may earn a referral credit if you sign up through this link.",
  steps:
    "Sign up, open API Token, create a token, and paste it below. Your key is encrypted and never shown again.",
  claudeBatches:
    "Claude models are released in daily batches and may be temporarily unavailable — if that happens, choose GLM or DeepSeek instead. Both are verified working.",
} as const;

/**
 * D10: the queue copy states the real shape. No end-to-end promise beyond
 * the honest range; the live ETA comes from measured durations.
 */
export const MOTION_DURATION_COPY =
  "Generation typically takes 30–60 minutes. You can close this tab — the job keeps running, " +
  "and your project will be here when you come back.";

/** What the worker's GET /jobs/:id returns, as far as the app reads it. */
export type MotionWorkerPayload = {
  status: string;
  queue_position?: number | null;
  eta_seconds?: number | null;
  progress_pct?: number | null;
  wall_seconds?: number | null;
  mp4_bytes?: number | null;
  error?: string | null;
};

export type MotionPollVerdict =
  | { action: "moved-on" }
  | { action: "fail"; message: string }
  | { action: "wait"; payload: MotionWorkerPayload }
  | { action: "complete" };

/** The narration round's verdict shape: one pure decision owns the honesty. */
export function motionPollVerdict(input: {
  projectStatus: string;
  stateEnteredAtIso: string;
  nowMs: number;
  worker: { kind: "ok"; payload: MotionWorkerPayload } | { kind: "not-found" };
}): MotionPollVerdict {
  if (input.projectStatus !== "generating_motion") return { action: "moved-on" };
  if (input.worker.kind === "not-found") return { action: "fail", message: MOTION_LOST_MESSAGE };
  const payload = input.worker.payload;
  if (payload.status === "failed") {
    return {
      action: "fail",
      message: payload.error?.trim() || "The explainer failed. Please try again.",
    };
  }
  if (payload.status === "completed") return { action: "complete" };
  const entered = Date.parse(input.stateEnteredAtIso);
  const stale =
    !Number.isFinite(entered) || input.nowMs - entered > MOTION_STALE_AFTER_HOURS * 60 * 60 * 1000;
  if (stale) return { action: "fail", message: MOTION_STALE_MESSAGE };
  return { action: "wait", payload };
}

/** The progress card's line, from the poll payload. */
export function describeMotionStage(payload: MotionWorkerPayload): string {
  if (payload.status === "queued") {
    const position =
      typeof payload.queue_position === "number" && payload.queue_position > 0
        ? ` — position ${payload.queue_position} in line`
        : "";
    const eta =
      typeof payload.eta_seconds === "number" && payload.eta_seconds > 0
        ? ` (about ${Math.max(1, Math.round(payload.eta_seconds / 60))} min, from measured jobs)`
        : "";
    return `Waiting for the explainer server${position}${eta}…`;
  }
  if (payload.status === "processing") {
    const pct =
      typeof payload.progress_pct === "number" && payload.progress_pct > 0
        ? ` — ${Math.round(payload.progress_pct)}%`
        : "";
    return `Generating your explainer on the server${pct}. ${MOTION_DURATION_COPY}`;
  }
  return "Checking explainer progress…";
}

/** sk-abc…x4Kd — enough to recognise a saved key without exposing it. */
export function keyTail(key: string): string {
  const trimmed = String(key ?? "").trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : "";
}
