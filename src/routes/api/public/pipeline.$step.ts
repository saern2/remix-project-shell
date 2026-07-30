import { createFileRoute } from "@tanstack/react-router";

// Stub endpoint for the render pipeline. A separate rendering service will
// implement transcription, stock-footage matching, and FFmpeg rendering in a
// later phase. Kept here so the UI has a stable URL to POST to without 404s.
export const Route = createFileRoute("/api/public/pipeline/$step")({
  server: {
    handlers: {
      POST: async ({ params }: { params: { step: string } }) => {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "not_implemented",
            step: params.step,
            message: "The render pipeline is not implemented in this phase.",
          }),
          { status: 501, headers: { "content-type": "application/json" } },
        );
      },
    },
  },
} as never);

