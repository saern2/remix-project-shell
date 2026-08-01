/**
 * Unit tests for `deleteProject` handler
 * Requirements: 4.1, 4.2, 4.3, 4.6, 4.7
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ─── Capture the handler via the mocked createServerFn builder ────────────────

let capturedHandler:
  | ((args: {
      data: { projectId: string };
      context: { supabase: unknown; userId: string };
    }) => Promise<unknown>)
  | null = null;

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => {
      capturedHandler = fn as typeof capturedHandler;
      return builder;
    },
  };
  return { createServerFn: () => builder };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));

// ─── Mutable supabaseAdmin mock ───────────────────────────────────────────────

const mockAudioRemove = vi.fn();
const mockRenderOutputsRemove = vi.fn();
const mockProjectsDelete = vi.fn();
const mockProjectsUpdate = vi.fn();
const mockCancelRenderJob = vi.fn();

let mockActiveJob: { id: string; status: string } | null = null;
let mockAudioPaths: string[] = [];
let mockRenderJobIds: string[] = [];

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "render_jobs") {
        return {
          select: (cols: string) => {
            if (cols.includes("status")) {
              // Active job check
              return {
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({
                          data: mockActiveJob,
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              };
            }
            // Render job IDs for storage cleanup
            return {
              eq: () => ({
                data: mockRenderJobIds.map((id) => ({ id })),
                error: null,
              }),
            };
          },
        };
      }
      if (table === "audio_assets") {
        return {
          select: () => ({
            eq: () => ({
              data: mockAudioPaths.map((p) => ({ storage_path: p })),
              error: null,
            }),
          }),
        };
      }
      if (table === "projects") {
        return {
          update: (values: unknown) => ({
            eq: (column: string, value: string) => mockProjectsUpdate(values, column, value),
          }),
          delete: () => ({
            eq: () => mockProjectsDelete(),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === "audio") {
          return { remove: mockAudioRemove };
        }
        if (bucket === "render-outputs") {
          return { remove: mockRenderOutputsRemove };
        }
        throw new Error(`Unexpected bucket: ${bucket}`);
      },
    },
  },
}));

vi.mock("@/lib/render.functions", () => ({
  cancelRenderJob: mockCancelRenderJob,
}));

// ─── Load module ──────────────────────────────────────────────────────────────

import("../deleteProject");

// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "user-test-id";

function makeMockSupabase(ownerUserId: string = USER_ID) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({
            data: { id: PROJECT_ID, name: "Test Project", user_id: ownerUserId },
            error: null,
          }),
        }),
      }),
    }),
  };
}

async function callHandler(projectId: string, userId: string, supabase = makeMockSupabase(userId)) {
  if (!capturedHandler) throw new Error("Handler not captured");
  return capturedHandler({ data: { projectId }, context: { supabase, userId } });
}

describe("deleteProject handler", () => {
  beforeAll(async () => {
    await import("../deleteProject");
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockActiveJob = null;
    mockAudioPaths = [];
    mockRenderJobIds = [];
    mockProjectsDelete.mockResolvedValue({ error: null });
    mockProjectsUpdate.mockResolvedValue({ error: null });
    mockAudioRemove.mockResolvedValue({ error: null });
    mockRenderOutputsRemove.mockResolvedValue({ error: null });
    mockCancelRenderJob.mockResolvedValue({ ok: true });
  });

  it('throws "Forbidden." for wrong userId', async () => {
    expect(capturedHandler).not.toBeNull();
    const supabase = makeMockSupabase("different-user-id");
    await expect(callHandler(PROJECT_ID, USER_ID, supabase)).rejects.toThrow("Forbidden.");
    expect(mockProjectsDelete).not.toHaveBeenCalled();
  });

  it("calls cancelRenderJob when active render job exists, then proceeds to Storage cleanup", async () => {
    expect(capturedHandler).not.toBeNull();
    mockActiveJob = { id: "job-abc", status: "rendering" };
    mockAudioPaths = ["audio/path/1.mp3"];
    mockCancelRenderJob.mockResolvedValue({ ok: true });
    mockProjectsDelete.mockResolvedValue({ error: null });

    await callHandler(PROJECT_ID, USER_ID);

    expect(mockCancelRenderJob).toHaveBeenCalledOnce();
    expect(mockProjectsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline_cancel_requested_at: expect.any(String) }),
      "id",
      PROJECT_ID,
    );
    expect(mockAudioRemove).toHaveBeenCalledOnce();
    expect(mockProjectsDelete).toHaveBeenCalledOnce();
  });

  it("continues and deletes DB row even if Storage removal throws", async () => {
    expect(capturedHandler).not.toBeNull();
    mockAudioPaths = ["audio/path/1.mp3"];
    mockAudioRemove.mockResolvedValue({ error: { message: "Storage error" } });
    mockRenderOutputsRemove.mockResolvedValue({ error: { message: "Storage error 2" } });
    mockProjectsDelete.mockResolvedValue({ error: null });

    // Should not throw — storage errors are caught
    await expect(callHandler(PROJECT_ID, USER_ID)).resolves.toMatchObject({
      ok: true,
      projectId: PROJECT_ID,
    });

    // DB delete must still run
    expect(mockProjectsDelete).toHaveBeenCalledOnce();
  });

  it("calls projects.delete() as the final step", async () => {
    expect(capturedHandler).not.toBeNull();
    const callOrder: string[] = [];

    mockAudioRemove.mockImplementation(async () => {
      callOrder.push("audioRemove");
      return { error: null };
    });
    mockRenderOutputsRemove.mockImplementation(async () => {
      callOrder.push("renderOutputsRemove");
      return { error: null };
    });
    mockProjectsDelete.mockImplementation(async () => {
      callOrder.push("projectsDelete");
      return { error: null };
    });

    await callHandler(PROJECT_ID, USER_ID);

    expect(callOrder.at(-1)).toBe("projectsDelete");
    expect(mockProjectsDelete).toHaveBeenCalledOnce();
  });
});
