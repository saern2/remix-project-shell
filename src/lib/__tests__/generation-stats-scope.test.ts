import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Scope is a privilege, not a parameter.
 *
 * `get_generation_stats` is SECURITY DEFINER and sees every row regardless of
 * RLS. It is granted to service_role only, so this handler is its sole caller —
 * which makes the admin check here the actual boundary between a signed-in user
 * and platform-wide data. These tests drive the real handler with the builder
 * mock this codebase already uses for server functions.
 */

type Handler = (args: {
  data: { scope: "user" | "platform"; timeZone?: string };
  context: { supabase: unknown; userId: string };
}) => Promise<unknown>;

let capturedHandler: Handler | null = null;
let capturedValidator: ((input: unknown) => unknown) | null = null;

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: (fn: unknown) => {
      capturedValidator = fn as typeof capturedValidator;
      return builder;
    },
    handler: (fn: unknown) => {
      capturedHandler = fn as Handler;
      return builder;
    },
  };
  return { createServerFn: () => builder };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin.functions", () => ({
  isCallerAdmin: async () => mockIsAdmin,
}));

const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcError: { code: string; message: string } | null = null;

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcError
        ? { data: null, error: rpcError }
        : { data: { scope: args.p_scope }, error: null };
    },
  },
}));

await import("../stats.functions");

const CALLER = "aaaaaaaa-1111-4111-8111-111111111111";
const context = { supabase: {}, userId: CALLER };

beforeEach(() => {
  rpcCalls.length = 0;
  rpcError = null;
  mockIsAdmin = false;
});

describe("getGenerationStats — scope authorization", () => {
  it("refuses platform scope for a non-admin, and does not touch the database", () => {
    mockIsAdmin = false;
    return expect(capturedHandler!({ data: { scope: "platform" }, context }))
      .rejects.toThrow(/forbidden/i)
      .then(() => {
        // The refusal must come BEFORE the query: a SECURITY DEFINER function
        // that has already run has already read the data.
        expect(rpcCalls).toHaveLength(0);
      });
  });

  it("allows platform scope for an admin", async () => {
    mockIsAdmin = true;
    await capturedHandler!({ data: { scope: "platform" }, context });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_scope).toBe("platform");
    // Platform scope must not be narrowed to one user by a stray id.
    expect(rpcCalls[0].args.p_user_id).toBeNull();
  });

  it("user scope always passes the CALLER's id, never one from the request", async () => {
    mockIsAdmin = false;
    await capturedHandler!({ data: { scope: "user" }, context });
    expect(rpcCalls[0].args.p_scope).toBe("user");
    expect(rpcCalls[0].args.p_user_id).toBe(CALLER);
  });

  it("an admin asking for their own stats still gets user scope", async () => {
    // Being an administrator does not silently widen "My stats".
    mockIsAdmin = true;
    await capturedHandler!({ data: { scope: "user" }, context });
    expect(rpcCalls[0].args.p_scope).toBe("user");
    expect(rpcCalls[0].args.p_user_id).toBe(CALLER);
  });

  it("defaults to user scope when none is supplied", () => {
    const parsed = capturedValidator!({}) as { scope: string };
    expect(parsed.scope).toBe("user");
  });

  it("rejects a scope that is neither user nor platform", () => {
    expect(() => capturedValidator!({ scope: "everyone" })).toThrow();
  });

  it("passes the caller's timezone through, defaulting to UTC", async () => {
    await capturedHandler!({ data: { scope: "user", timeZone: "America/Los_Angeles" }, context });
    expect(rpcCalls[0].args.p_tz).toBe("America/Los_Angeles");
    rpcCalls.length = 0;
    await capturedHandler!({ data: { scope: "user" }, context });
    expect(rpcCalls[0].args.p_tz).toBe("UTC");
  });

  it("reports a database failure as a plain message, not a driver error", async () => {
    rpcError = { code: "42883", message: "function public.get_generation_stats does not exist" };
    await expect(capturedHandler!({ data: { scope: "user" }, context })).rejects.toThrow(
      "Statistics could not be loaded.",
    );
  });
});
