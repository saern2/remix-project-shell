import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

/**
 * Schema verification, run once for the life of the process.
 *
 * A missing migration used to surface only as a 400 loop in the browser console
 * — the render page just never loaded its status, and nothing server-side said
 * why. Checking here means the very first request answers with the list of
 * missing columns instead, and every later request is unaffected: the promise is
 * created once and its result reused.
 *
 * Deliberately fails closed. A build whose database cannot serve its own pages
 * must not look healthy; SCHEMA_CHECK=warn or =off opts out when deploying ahead
 * of a migration on purpose.
 */
let schemaCheckPromise: Promise<string | null> | undefined;

function checkSchemaOnce(): Promise<string | null> {
  if (!schemaCheckPromise) {
    schemaCheckPromise = import("./lib/schema-check.server")
      .then(async ({ runSchemaCheck }) => {
        await runSchemaCheck();
        return null;
      })
      .catch((error: unknown) => {
        // Backend credentials can be injected just after the dev worker starts.
        // Do not poison the worker for its entire lifetime when the first request
        // wins that race; keep failing closed, but allow the next request to retry.
        schemaCheckPromise = undefined;
        return error instanceof Error ? error.message : String(error);
      });
  }
  return schemaCheckPromise;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const schemaFailure = await checkSchemaOnce();
    if (schemaFailure) {
      return new Response(renderErrorPage(schemaFailure), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
