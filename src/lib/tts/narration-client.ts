/**
 * The client-side drive loop for server narration — shared verbatim by the
 * creating tab (projects.new) and the resuming tab (the project page), so
 * tab-close survival is the SAME code path as the happy path, not a second
 * implementation that drifts.
 *
 * Transport errors are transient by policy: a network blip retries with the
 * stage line saying so; only the server's own verdicts ('failed', which the
 * poll has already written onto the project) end the loop unhappily.
 */

import { describeNarrationStage } from "@/lib/tts/narration";

const POLL_INTERVAL_MS = 2_500;

type PollResult =
  | { status: "failed"; error: string }
  | { status: "moved-on" }
  | { status: "completed" }
  | {
      status: "waiting";
      worker_status: string;
      queue_position: number | null;
      progress_pct: number | null;
    };

type CompleteResult =
  | { status: "already-handed-off"; projectStatus: string }
  | {
      status: "ready-to-persist";
      fullText: string;
      voice: string;
      durationSec: number;
      sentences: Array<{ text: string; start_ms: number; end_ms: number }>;
    };

export type DriveOutcome =
  | { outcome: "persisted" }
  | { outcome: "moved-on" }
  | { outcome: "failed"; message: string }
  | { outcome: "cancelled" };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function driveNarration(opts: {
  projectId: string;
  poll: (args: { data: { projectId: string } }) => Promise<PollResult>;
  complete: (args: { data: { projectId: string } }) => Promise<CompleteResult>;
  persist: (result: Extract<CompleteResult, { status: "ready-to-persist" }>) => Promise<void>;
  onStage: (stage: string) => void;
  isCancelled?: () => boolean;
  /** For the ETA line; the creating tab knows it, the resuming tab may not. */
  estimatedAudioSec?: number | null;
}): Promise<DriveOutcome> {
  const cancelled = opts.isCancelled ?? (() => false);
  for (;;) {
    if (cancelled()) return { outcome: "cancelled" };

    let poll: PollResult;
    try {
      poll = await opts.poll({ data: { projectId: opts.projectId } });
    } catch {
      // Transient by policy — the server fn throws only on transport/worker
      // unreachability, never on a job verdict.
      opts.onStage("Reconnecting to the narration service…");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (poll.status === "failed") return { outcome: "failed", message: poll.error };
    if (poll.status === "moved-on") return { outcome: "moved-on" };
    if (poll.status === "completed") {
      opts.onStage("Narration finished — saving it to your project…");
      const completion = await opts.complete({ data: { projectId: opts.projectId } });
      if (completion.status === "already-handed-off") return { outcome: "moved-on" };
      await opts.persist(completion);
      return { outcome: "persisted" };
    }

    opts.onStage(
      describeNarrationStage({
        status: poll.worker_status,
        queue_position: poll.queue_position,
        progress_pct: poll.progress_pct,
        estimatedAudioSec: opts.estimatedAudioSec ?? null,
      }),
    );
    await sleep(POLL_INTERVAL_MS);
  }
}
