/**
 * Property-based tests for `deleteProject`
 * Requirements: 4.4, 4.5, 4.6
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import * as fc from "fast-check";

// ─── Capture handler ──────────────────────────────────────────────────────────

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

vi.mock("@/lib/render.functions", () => ({
  cancelRenderJob: vi.fn().mockResolvedValue({ ok: true }),
}));

// ─── Configurable supabaseAdmin mock ─────────────────────────────────────────

let _audioPaths: string[] = [];
let _renderJobIds: string[] = [];
let _audioRemoveShouldFail = false;
let _renderRemoveShouldFail = false;

const capturedAudioRemoveArgs: string[][] = [];
const capturedRenderRemoveArgs: string[][] = [];
const mockProjectsDeleteCalls: number[] = [];

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "render_jobs") {
        return {
          select: (cols: string) => {
            if (cols.includes("status")) {
              return {
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({ data: null, error: null }),
                      }),
                    }),
                  }),
                }),
              };
            }
            return {
              eq: () => ({
                data: _renderJobIds.map((id) => ({ id })),
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
              data: _audioPaths.map((p) => ({ storage_path: p })),
              error: null,
            }),
          }),
        };
      }
      if (table === "projects") {
        return {
          update: () => ({
            eq: () => ({ error: null }),
          }),
          delete: () => ({
            eq: () => {
              mockProjectsDeleteCalls.push(1);
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === "audio") {
          return {
            remove: async (paths: string[]) => {
              capturedAudioRemoveArgs.push(paths);
              return _audioRemoveShouldFail
                ? { error: { message: "audio storage error" } }
                : { error: null };
            },
          };
        }
        if (bucket === "render-outputs") {
          return {
            remove: async (paths: string[]) => {
              capturedRenderRemoveArgs.push(paths);
              return _renderRemoveShouldFail
                ? { error: { message: "render storage error" } }
                : { error: null };
            },
          };
        }
        throw new Error(`Unexpected bucket: ${bucket}`);
      },
    },
  },
}));

// ─── Load module ──────────────────────────────────────────────────────────────

import("../deleteProject");

// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "user-test-id";

function makeMockSupabase() {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({
            data: { id: PROJECT_ID, name: "Test Project", user_id: USER_ID },
            error: null,
          }),
        }),
      }),
    }),
  };
}

async function callHandler(projectId = PROJECT_ID) {
  if (!capturedHandler) throw new Error("Handler not captured");
  return capturedHandler({
    data: { projectId },
    context: { supabase: makeMockSupabase(), userId: USER_ID },
  });
}

describe("deleteProject property tests", () => {
  beforeAll(async () => {
    await import("../deleteProject");
  });

  beforeEach(() => {
    _audioPaths = [];
    _renderJobIds = [];
    _audioRemoveShouldFail = false;
    _renderRemoveShouldFail = false;
    capturedAudioRemoveArgs.length = 0;
    capturedRenderRemoveArgs.length = 0;
    mockProjectsDeleteCalls.length = 0;
  });

  // ─── Property 9 ──────────────────────────────────────────────────────────
  // Feature: render-pipeline-reliability, Property 9: deleteProject forwards all audio storage paths to removal
  // Validates: Requirement 4.4
  it("Property 9: all audio storage paths are forwarded to audio.remove()", async () => {
    expect(capturedHandler).not.toBeNull();

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 }),
        async (audioPaths) => {
          _audioPaths = audioPaths;
          capturedAudioRemoveArgs.length = 0;

          await callHandler();

          expect(capturedAudioRemoveArgs.length).toBeGreaterThan(0);
          const removedPaths = capturedAudioRemoveArgs[0];
          // Every input path must appear in the remove call
          for (const p of audioPaths) {
            expect(removedPaths).toContain(p);
          }
          // No extra paths should be added
          expect(removedPaths.length).toBe(audioPaths.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ─── Property 10 ─────────────────────────────────────────────────────────
  // Feature: render-pipeline-reliability, Property 10: deleteProject forwards all render output paths to removal
  // Validates: Requirement 4.5
  it("Property 10: render output paths are constructed as {projectId}/{jobId}.mp4 for all job IDs", async () => {
    expect(capturedHandler).not.toBeNull();

    await fc.assert(
      fc.asyncProperty(fc.array(fc.uuid(), { minLength: 1, maxLength: 20 }), async (jobIds) => {
        _renderJobIds = jobIds;
        capturedRenderRemoveArgs.length = 0;

        await callHandler();

        const expectedPaths = jobIds.map((id) => `${PROJECT_ID}/${id}.mp4`);

        if (expectedPaths.length > 0) {
          expect(capturedRenderRemoveArgs.length).toBeGreaterThan(0);
          const removedPaths = capturedRenderRemoveArgs[0];
          for (const expected of expectedPaths) {
            expect(removedPaths).toContain(expected);
          }
          expect(removedPaths.length).toBe(expectedPaths.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  // ─── Property 11 ─────────────────────────────────────────────────────────
  // Feature: render-pipeline-reliability, Property 11: Storage failures do not prevent DB row deletion
  // Validates: Requirement 4.6
  it("Property 11: projects.delete() is always called even when Storage removals fail", async () => {
    expect(capturedHandler).not.toBeNull();

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // audio remove fails?
        fc.boolean(), // render-outputs remove fails?
        async (audioFails, renderFails) => {
          _audioRemoveShouldFail = audioFails;
          _renderRemoveShouldFail = renderFails;
          _audioPaths = ["some/audio/path.mp3"];
          _renderJobIds = ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"];
          mockProjectsDeleteCalls.length = 0;

          // Should not throw regardless of storage failure configuration
          await expect(callHandler()).resolves.toMatchObject({
            ok: true,
            projectId: PROJECT_ID,
          });

          // DB delete must always run
          expect(mockProjectsDeleteCalls.length).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
