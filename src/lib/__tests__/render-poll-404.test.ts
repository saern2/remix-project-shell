/**
 * A worker 404 is a terminal state, not an error.
 *
 * Deployed sequence: the user cancelled at 12/13 chunks, the project correctly
 * became failed ("Render was cancelled."), the worker correctly removed the job
 * — and the app kept polling and surfaced
 *
 *   Render worker poll failed (404): {"error":"Job not found","job_id":"..."}
 *
 * Both sides behaved correctly. Only the client's reading of 404 was wrong.
 * These pin the two cases apart: an expected disappearance says nothing, an
 * unexpected one fails in plain language with no raw payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    job: {} as Record<string, unknown>,
    projectStatus: "rendering" as string,
    workerStatus: 404,
    workerBody: '{"error":"Job not found","job_id":"job-1"}',
    updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { options: {} },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      update: (values: Record<string, unknown>) => {
        state.updates.push({ table, values });
        return q;
      },
      maybeSingle: async () => ({ data: { status: state.projectStatus }, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
    };
    return q;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => chain(table),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
    },
  };
});

const supabaseStub = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: state.job, error: null }),
      }),
    }),
  }),
};

describe("worker poll 404 handling", () => {
  beforeEach(() => {
    process.env.RENDER_WORKER_URL = "https://worker.test";
    process.env.RENDER_WORKER_API_KEY = "k";
    state.updates = [];
    state.workerStatus = 404;
    state.workerBody = '{"error":"Job not found","job_id":"job-1"}';
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(state.workerBody, {
          status: state.workerStatus,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  async function poll() {
    const { pollRenderJob } = await import("../render.functions");
    return (pollRenderJob as unknown as (a: unknown) => Promise<Record<string, unknown>>)({
      data: { jobId: "job-1" },
      context: { supabase: supabaseStub, userId: "user-1" },
    });
  }

  it("says nothing when the render was already cancelled", async () => {
    state.job = {
      id: "job-1",
      project_id: "p1",
      status: "cancelled",
      progress_pct: 42,
      output_url: null,
      error: null,
      chunks_total: 13,
      chunks_completed: 12,
      projects: { user_id: "user-1" },
    };
    state.projectStatus = "failed";

    const result = await poll();
    // Terminal, and reported as such so the client stops polling.
    expect(result.status).toBe("failed");
    // No new failure written — the cancellation already settled this.
    expect(state.updates).toEqual([]);
    // And nothing resembling the worker's payload reaches the user.
    expect(JSON.stringify(result)).not.toContain("Job not found");
  });

  it("says nothing when the project already completed", async () => {
    state.job = {
      id: "job-1",
      project_id: "p1",
      status: "rendering",
      progress_pct: 100,
      output_url: null,
      error: null,
      chunks_total: 13,
      chunks_completed: 13,
      projects: { user_id: "user-1" },
    };
    state.projectStatus = "completed";

    const result = await poll();
    expect(result.status).toBe("rendering");
    expect(state.updates).toEqual([]);
  });

  it("fails in plain language when a job we believed was running disappears", async () => {
    state.job = {
      id: "job-1",
      project_id: "p1",
      status: "rendering",
      progress_pct: 40,
      output_url: null,
      error: null,
      chunks_total: 13,
      chunks_completed: 5,
      projects: { user_id: "user-1" },
    };
    state.projectStatus = "rendering";

    const result = await poll();
    expect(result.status).toBe("failed");
    expect(String(result.error)).toMatch(/stopped unexpectedly/i);
    // Plain language only: no status codes, no JSON, no job ids.
    expect(String(result.error)).not.toMatch(/404|\{|Job not found/);
    // Both rows settled so the UI and the project agree.
    expect(state.updates.map((u) => u.table).sort()).toEqual(["projects", "render_jobs"]);
  });

  it("keeps the submission-rejection message free of worker internals", async () => {
    // The third worker call site, audited alongside poll and cancel. It used to
    // interpolate the worker's body into both the thrown error and
    // render_jobs.error, so a queue-full stack trace became the user's status.
    const { renderSubmitFailureMessage } = await import("../render.functions");
    expect(renderSubmitFailureMessage(404)).toMatch(/unavailable right now/i);
    expect(renderSubmitFailureMessage(404)).not.toMatch(/404/);
    expect(renderSubmitFailureMessage(500)).toMatch(/could not be started \(HTTP 500\)/);
    // The status is the only machine detail allowed through.
    expect(renderSubmitFailureMessage(500)).not.toMatch(/[{}]|stack|error":/);
  });

  it("does not leak the worker payload on a non-404 failure either", async () => {
    state.job = {
      id: "job-1",
      project_id: "p1",
      status: "rendering",
      progress_pct: 10,
      output_url: null,
      error: null,
      chunks_total: 13,
      chunks_completed: 1,
      projects: { user_id: "user-1" },
    };
    state.projectStatus = "rendering";
    state.workerStatus = 500;
    state.workerBody = '{"error":"boom","stack":"internal detail"}';

    await expect(poll()).rejects.toThrow(/could not be reached \(HTTP 500\)/);
    await expect(poll()).rejects.not.toThrow(/internal detail/);
  });
});
