import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_ID = "user-abc";

let capturedHandlers: Array<(args: { data: unknown; context: unknown }) => Promise<unknown>> = [];
const renderClipSliceUpsert = vi.fn();
const renderJobInsert = vi.fn();
const adminUpdate = vi.fn();
const searchStockFootage = vi.fn();
let renderClipSliceRows: unknown[] = [];
let userScenes: Array<{
  id: string;
  idx: number;
  start_ts: number;
  end_ts: number;
  visual_query: string;
  selected_clips: null;
}> = [];

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: (args: { data: unknown; context: unknown }) => Promise<unknown>) => {
        capturedHandlers.push(fn);
        return builder;
      },
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));

vi.mock("@/lib/stock.server", () => ({
  orientationForAspect: () => "portrait",
  targetWidthForAspect: () => 1080,
  stockReservationKey: (provider: string, id: string, inPoint = 0) =>
    provider === "nasa" ? `${provider}:${id}:${Math.floor(inPoint / 5)}` : `${provider}:${id}`,
  searchStockFootage: (...args: unknown[]) => searchStockFootage(...args),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "render_clip_slices") {
        return {
          select: () => ({
            eq: async () => ({ data: renderClipSliceRows, error: null }),
          }),
          upsert: (rows: unknown, options: unknown) => {
            renderClipSliceRows = Array.isArray(rows) ? rows : [rows];
            return renderClipSliceUpsert(rows, options);
          },
        };
      }
      if (table === "render_jobs") {
        return {
          insert: (row: unknown) => ({
            select: () => ({
              single: () => renderJobInsert(row),
            }),
          }),
          update: (row: unknown) => ({
            eq: () => adminUpdate(table, row),
          }),
        };
      }
      if (table === "projects") {
        return {
          update: (row: unknown) => ({
            eq: () => adminUpdate(table, row),
          }),
        };
      }
      throw new Error(`Unexpected admin table: ${table}`);
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({
          data: { signedUrl: "https://upload.example.com/out.mp4" },
          error: null,
        }),
      }),
    },
  },
}));

function makeUserSupabase() {
  return {
    from: (table: string) => {
      if (table === "projects") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: PROJECT_ID,
                  status: "ready",
                  user_id: USER_ID,
                  aspect_ratio: "portrait",
                  clip_duration_seconds: 4,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "scenes") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: userScenes,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "audio_assets") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { storage_path: "audio/project.wav" },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected user table: ${table}`);
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://audio.example.com/in.wav" },
          error: null,
        }),
      }),
    },
  };
}

describe("submitRenderJob fixed-duration fallback", () => {
  beforeEach(async () => {
    vi.resetModules();
    capturedHandlers = [];
    renderClipSliceRows = [];
    userScenes = [
      {
        id: "scene-one",
        idx: 0,
        start_ts: 0,
        end_ts: 8,
        visual_query: "football practice",
        selected_clips: null,
      },
    ];
    renderClipSliceUpsert.mockReset().mockResolvedValue({ error: null });
    renderJobInsert.mockReset().mockResolvedValue({ data: { id: JOB_ID }, error: null });
    adminUpdate.mockReset().mockResolvedValue({ error: null });
    searchStockFootage
      .mockReset()
      .mockResolvedValueOnce({
        chosenFile: { url: "https://videos.example.com/a.mp4" },
        pick: { provider: "pexels", provider_clip_id: "pexels-a", thumbnail_url: null },
        inPoint: 0,
        reservationKey: "pexels:pexels-a",
      })
      .mockResolvedValueOnce({
        chosenFile: { url: "https://videos.example.com/b.mp4" },
        pick: { provider: "pexels", provider_clip_id: "pexels-b", thumbnail_url: null },
        inPoint: 0,
        reservationKey: "pexels:pexels-b",
      });
    process.env.RENDER_WORKER_URL = "https://worker.example.com";
    process.env.RENDER_WORKER_API_KEY = "test-worker-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
    } as Response);

    await import("../render.functions");
  });

  it("searches and renders when the fixed-duration slice cache is empty", async () => {
    const submitRenderJobHandler = capturedHandlers[0];
    expect(submitRenderJobHandler).toBeTypeOf("function");

    const result = await submitRenderJobHandler({
      data: { projectId: PROJECT_ID },
      context: { supabase: makeUserSupabase(), userId: USER_ID },
    });

    expect(result).toEqual({ ok: true, jobId: JOB_ID });
    expect(searchStockFootage).toHaveBeenCalledTimes(2);
    expect(renderClipSliceUpsert).toHaveBeenCalledOnce();

    const [rows, options] = renderClipSliceUpsert.mock.calls[0];
    expect(rows).toHaveLength(2);
    expect(options).toEqual({ onConflict: "project_id,scene_id,slice_index" });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const workerBody = JSON.parse(String(init.body));
    expect(workerBody.transition).toBe("hard-cut");
    // scene_id / provider_clip_id ride along so the worker can name the scene and
    // source in its freeze-frame and in-point warnings; the timing contract that
    // matters is still clip_url/start/end.
    expect(workerBody.clips).toEqual([
      expect.objectContaining({
        clip_url: "https://videos.example.com/a.mp4",
        start: 0,
        end: 4,
      }),
      expect.objectContaining({
        clip_url: "https://videos.example.com/b.mp4",
        start: 0,
        end: 4,
      }),
    ]);
    expect(workerBody.clips.every((clip: { scene_id?: string }) => !!clip.scene_id)).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        duration_seconds: 4,
        timeline_start_seconds: 0,
        timeline_end_seconds: 4,
      }),
      expect.objectContaining({
        duration_seconds: 4,
        timeline_start_seconds: 4,
        timeline_end_seconds: 8,
      }),
    ]);
  });

  it("fills and renders fixed-duration gaps before the next scene starts", async () => {
    userScenes = [
      {
        id: "scene-one",
        idx: 0,
        start_ts: 0,
        end_ts: 4,
        visual_query: "football kickoff",
        selected_clips: null,
      },
      {
        id: "scene-two",
        idx: 1,
        start_ts: 6,
        end_ts: 10,
        visual_query: "football crowd",
        selected_clips: null,
      },
    ];
    searchStockFootage
      .mockReset()
      .mockResolvedValueOnce({
        chosenFile: { url: "https://videos.example.com/a.mp4" },
        pick: { provider: "pexels", provider_clip_id: "pexels-a", thumbnail_url: null },
        inPoint: 0,
        reservationKey: "pexels:pexels-a",
      })
      .mockResolvedValueOnce({
        chosenFile: { url: "https://videos.example.com/b.mp4" },
        pick: { provider: "pexels", provider_clip_id: "pexels-b", thumbnail_url: null },
        inPoint: 0,
        reservationKey: "pexels:pexels-b",
      })
      .mockResolvedValueOnce({
        chosenFile: { url: "https://videos.example.com/c.mp4" },
        pick: { provider: "pexels", provider_clip_id: "pexels-c", thumbnail_url: null },
        inPoint: 0,
        reservationKey: "pexels:pexels-c",
      });

    const submitRenderJobHandler = capturedHandlers[0];
    await submitRenderJobHandler({
      data: { projectId: PROJECT_ID },
      context: { supabase: makeUserSupabase(), userId: USER_ID },
    });

    expect(searchStockFootage).toHaveBeenCalledTimes(3);
    const [rows] = renderClipSliceUpsert.mock.calls[0];
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      expect.objectContaining({
        scene_id: "scene-one",
        slice_index: 0,
        duration_seconds: 4,
        timeline_start_seconds: 0,
        timeline_end_seconds: 4,
      }),
      expect.objectContaining({
        scene_id: "scene-one",
        slice_index: 1,
        duration_seconds: 2,
        timeline_start_seconds: 4,
        timeline_end_seconds: 6,
      }),
      expect.objectContaining({
        scene_id: "scene-two",
        slice_index: 0,
        duration_seconds: 4,
        timeline_start_seconds: 6,
        timeline_end_seconds: 10,
      }),
    ]);

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const workerBody = JSON.parse(String(init.body));
    expect(workerBody.transition).toBe("hard-cut");
    expect(workerBody.clips.map((clip: { end: number }) => clip.end)).toEqual([4, 2, 4]);
  });
});
