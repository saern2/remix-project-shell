/**
 * Unit tests for `cancelRenderJob` handler
 *
 * Requirements: 3.9, 3.10
 *
 * Strategy: mock `createServerFn` to capture the handler function, then call
 * it directly with a mocked `{ data, context }` object â€” bypassing the
 * TanStack Start runtime entirely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// â”€â”€â”€ Module-level captured handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// We capture it via the mocked createServerFn chain before importing the module.

let capturedHandler: ((args: { data: { jobId: string }; context: { supabase: unknown; userId: string } }) => Promise<unknown>) | null = null;

// â”€â”€â”€ Mock @tanstack/react-start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => {
      capturedHandler = fn as typeof capturedHandler;
      return builder; // return something callable as the server fn export
    },
  };
  return {
    createServerFn: () => builder,
  };
});

// â”€â”€â”€ Mock requireSupabaseAuth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));

// â”€â”€â”€ Mock zod (inputValidator is no-op in our mock, so this is just insurance) â”€
// zod is a real dep and doesn't need mocking.

// â”€â”€â”€ supabaseAdmin mock (dynamic import) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const mockRenderJobsUpdate = vi.fn();
const mockProjectsUpdate = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "render_jobs") {
        return {
          update: (vals: unknown) => ({
            eq: (_col: string, _val: string) => ({
              in: (_col2: string, _vals: unknown[]) => mockRenderJobsUpdate(vals),
            }),
          }),
        };
      }
      if (table === "projects") {
        return {
          update: (vals: unknown) => ({
            eq: (_col: string, _val: string) => mockProjectsUpdate(vals),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  },
}));

// â”€â”€â”€ Set env vars for workerBase() / workerKey() â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const WORKER_URL = "https://worker.example.com";
const WORKER_KEY = "test-api-key";

// â”€â”€â”€ Load the module under test AFTER mocks are set up â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Dynamic import is used so module is loaded after vi.mock hoisting is complete.
// We re-import each time via resetModules in beforeEach if needed; here a single
// import is enough since the captured handler is module-scoped.
import("../render.functions"); // trigger module load; handler capture happens at import time

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("cancelRenderJob handler", () => {
  const JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
  const USER_ID = "user-abc";

  /** Build a fake user-scoped supabase client for the context */
  function makeMockSupabase(overrides?: {
    jobErr?: { message: string };
    job?: unknown | null;
    ownerUserId?: string;
  }) {
    const ownerUserId = overrides?.ownerUserId ?? USER_ID;
    const job = overrides?.job !== undefined
      ? overrides.job
      : {
          id: JOB_ID,
          project_id: PROJECT_ID,
          status: "rendering",
          projects: { user_id: ownerUserId },
        };
    const jobErr = overrides?.jobErr ?? null;

    return {
      from: (_table: string) => ({
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            maybeSingle: async () => ({ data: job, error: jobErr }),
          }),
        }),
      }),
    };
  }

  function makeContext(supabaseOverrides?: Parameters<typeof makeMockSupabase>[0], userId = USER_ID) {
    return {
      supabase: makeMockSupabase(supabaseOverrides),
      userId,
    };
  }

  /** Helper â€” runs the captured handler. Throws if handler was not captured. */
  async function callHandler(data: { jobId: string }, context: ReturnType<typeof makeContext>) {
    if (!capturedHandler) {
      throw new Error("Handler was not captured â€” check createServerFn mock");
    }
    return capturedHandler({ data, context });
  }

  beforeEach(() => {
    process.env.RENDER_WORKER_URL = WORKER_URL;
    process.env.RENDER_WORKER_API_KEY = WORKER_KEY;
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.RENDER_WORKER_URL;
    delete process.env.RENDER_WORKER_API_KEY;
  });

  // â”€â”€â”€ Test 1: updates render_jobs.status to 'cancelled' on worker 200 â”€â”€â”€â”€â”€

  it("updates render_jobs.status to 'cancelled' when worker returns 200", async () => {
    // Make sure module is loaded and handler captured
    await import("../render.functions");
    expect(capturedHandler).not.toBeNull();

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    } as Response);

    mockRenderJobsUpdate.mockResolvedValueOnce({});
    mockProjectsUpdate.mockResolvedValueOnce({});

    const result = await callHandler({ jobId: JOB_ID }, makeContext());

    expect(result).toMatchObject({ ok: true, jobId: JOB_ID });

    // Verify the update to render_jobs included status: 'cancelled'
    expect(mockRenderJobsUpdate).toHaveBeenCalledOnce();
    const renderJobsUpdateArg = mockRenderJobsUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(renderJobsUpdateArg.status).toBe("cancelled");
    expect(renderJobsUpdateArg.completed_at).toBeDefined();
  });

  // â”€â”€â”€ Test 2: updates projects.status to 'failed' with correct error_message

  it("updates projects.status to 'failed' with error_message 'Render was cancelled.'", async () => {
    await import("../render.functions");
    expect(capturedHandler).not.toBeNull();

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    } as Response);

    mockRenderJobsUpdate.mockResolvedValueOnce({});
    mockProjectsUpdate.mockResolvedValueOnce({});

    await callHandler({ jobId: JOB_ID }, makeContext());

    expect(mockProjectsUpdate).toHaveBeenCalledOnce();
    const projectsUpdateArg = mockProjectsUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(projectsUpdateArg.status).toBe("failed");
    expect(projectsUpdateArg.error_message).toBe("Render was cancelled.");
  });

  // â”€â”€â”€ Test 3: throws on non-200 worker response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("throws when the worker returns a non-200 response", async () => {
    await import("../render.functions");
    expect(capturedHandler).not.toBeNull();

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    } as unknown as Response);

    await expect(callHandler({ jobId: JOB_ID }, makeContext())).rejects.toThrow(
      /The render could not be cancelled/,
    );

    // DB should NOT be updated on worker failure
    expect(mockRenderJobsUpdate).not.toHaveBeenCalled();
    expect(mockProjectsUpdate).not.toHaveBeenCalled();
  });

  // â”€â”€â”€ Test 4: throws "Forbidden." when user_id does not match â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('throws "Forbidden." when the authenticated user does not own the job', async () => {
    await import("../render.functions");
    expect(capturedHandler).not.toBeNull();

    // ownerUserId differs from the authenticated userId
    const context = makeContext({ ownerUserId: "other-user-id" }, USER_ID);

    // fetch should never be called in this path
    global.fetch = vi.fn();

    await expect(callHandler({ jobId: JOB_ID }, context)).rejects.toThrow("Forbidden.");

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockRenderJobsUpdate).not.toHaveBeenCalled();
    expect(mockProjectsUpdate).not.toHaveBeenCalled();
  });

  // â”€â”€â”€ Test 5: calls fetch with correct URL and X-Api-Key header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("calls the worker cancel endpoint with the correct URL and X-Api-Key header", async () => {
    await import("../render.functions");
    expect(capturedHandler).not.toBeNull();

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    } as Response);
    global.fetch = fetchMock;

    mockRenderJobsUpdate.mockResolvedValueOnce({});
    mockProjectsUpdate.mockResolvedValueOnce({});

    await callHandler({ jobId: JOB_ID }, makeContext());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WORKER_URL}/jobs/${JOB_ID}/cancel`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(WORKER_KEY);
  });
});
