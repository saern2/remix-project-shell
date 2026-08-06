import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  pacePexelsValidation,
  pexelsKeyActiveAfterValidation,
  validatePexelsKey,
} from "@/lib/pexels-keys.server";

type UploadStatus = "inserted" | "reactivated" | "invalid" | "unverified" | "duplicate" | "error";

type UploadRow = {
  line: number;
  masked: string;
  status: UploadStatus;
  detail?: string;
};

function maskKey(key: string): string {
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function parsePexelsKeyCsv(csv: string): string[] {
  const headers = new Set(["api_key", "key", "apikey", "pexels_key"]);
  return [
    ...new Set(
      csv
        .split(/[\r\n,]+/)
        .map((token) => token.trim().replace(/^["']|["']$/g, ""))
        .filter((token) => token.length > 0 && !headers.has(token.toLowerCase())),
    ),
  ];
}

async function requireAdmin(context: {
  supabase: SupabaseClient<Database>;
  userId: string;
}): Promise<void> {
  const { data, error } = await context.supabase
    .from("users")
    .select("role")
    .eq("id", context.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.role !== "admin") throw new Error("Forbidden.");
}

async function setKeyActive(id: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("pexels_api_keys")
    .update({
      is_active: true,
      last_error: null,
      last_error_at: null,
      rate_limit_remaining: null,
      rate_limit_reset_at: null,
    })
    .eq("id", id);
  return error?.message ?? null;
}

export const uploadPexelsKeysResilient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      // safetyThreshold is gone: it gated a replacement that no longer happens.
      // The pool floor it became is a display preference, not an upload input.
      .object({ csv: z.string().min(1).max(200_000) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const parsed = parsePexelsKeyCsv(data.csv);
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("pexels_api_keys")
      .select("id, api_key, is_active");
    if (existingError) throw new Error(existingError.message);

    const existingByKey = new Map((existing ?? []).map((row) => [row.api_key, row]));
    const activeKeys = parsed.filter((key) => existingByKey.get(key)?.is_active);
    const inactiveKeys = parsed.filter((key) => {
      const row = existingByKey.get(key);
      return row != null && !row.is_active;
    });
    const newKeys = parsed.filter((key) => !existingByKey.has(key));
    const results: UploadRow[] = activeKeys.map((key) => ({
      line: parsed.indexOf(key) + 1,
      masked: maskKey(key),
      status: "duplicate",
      detail: "Key is already active in the pool.",
    }));
    const validations = new Map<string, Awaited<ReturnType<typeof validatePexelsKey>>>();

    const keysToValidate = [...inactiveKeys, ...newKeys];
    for (let index = 0; index < keysToValidate.length; index++) {
      if (index > 0) await pacePexelsValidation();
      const key = keysToValidate[index];
      const validation = await validatePexelsKey(key);
      validations.set(key, validation);
      if (validation.status !== "valid") {
        results.push({
          line: parsed.indexOf(key) + 1,
          masked: maskKey(key),
          status: validation.status,
          detail: validation.detail,
        });
      }
    }

    const validInactive = inactiveKeys.filter((key) =>
      pexelsKeyActiveAfterValidation(false, validations.get(key)?.status ?? "unverified"),
    );
    const validNew = newKeys.filter((key) => validations.get(key)?.status === "valid");
    let reactivated = 0;
    let inserted = 0;

    // ── ADDITIVE ONLY ────────────────────────────────────────────────────────
    //
    // This used to be a REPLACE: after a batch met a safety threshold, every
    // active key NOT in the upload was deactivated with "Replaced by validated
    // upload batch". Adding two keys silently retired the rest of the pool.
    //
    // An upload now only ever adds or reactivates. Removing a key is a separate,
    // explicit action, because losing the pool to a routine top-up is not a
    // mistake anyone should be able to make by accident.
    //
    // The old safety threshold also gated INSERTS, so a small upload validated
    // its keys and then discarded them. Nothing is gated now: a valid key that
    // was uploaded gets added.

    for (const key of validInactive) {
      const row = existingByKey.get(key);
      const updateError = row ? await setKeyActive(row.id) : "Existing key row disappeared.";
      results.push({
        line: parsed.indexOf(key) + 1,
        masked: maskKey(key),
        status: updateError ? "error" : "reactivated",
        detail: updateError ?? "Inactive key passed validation and was reactivated.",
      });
      if (!updateError) reactivated++;
    }

    for (const key of validNew) {
      const { error } = await supabaseAdmin
        .from("pexels_api_keys")
        .insert({ api_key: key, is_active: true });
      results.push({
        line: parsed.indexOf(key) + 1,
        masked: maskKey(key),
        status: error ? "error" : "inserted",
        detail: error?.message ?? "New key passed validation and was activated.",
      });
      if (!error) inserted++;
    }

    const { count: activePoolSize } = await supabaseAdmin
      .from("pexels_api_keys")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    return {
      // Always committed: an upload cannot be rejected as a whole any more,
      // because it can no longer take anything away.
      committed: true as const,
      activePoolSize: activePoolSize ?? 0,
      total: parsed.length,
      inserted,
      reactivated,
      alreadyPresent: activeKeys.length,
      invalid: results.filter((row) => row.status === "invalid").length,
      unverified: results.filter((row) => row.status === "unverified").length,
      duplicates: results.filter((row) => row.status === "duplicate").length,
      errors: results.filter((row) => row.status === "error").length,
      results,
    };
  });

export const revalidateAllPexelsKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: keys, error } = await supabaseAdmin
      .from("pexels_api_keys")
      .select("id, api_key, is_active")
      .order("added_at", { ascending: true });
    if (error) throw new Error(error.message);
    const results: Array<{
      masked: string;
      status: "active" | "inactive" | "unverified";
      detail: string;
    }> = [];

    for (let index = 0; index < (keys ?? []).length; index++) {
      if (index > 0) await pacePexelsValidation();
      const key = keys![index];
      const validation = await validatePexelsKey(key.api_key);
      if (validation.status === "valid") {
        const updateError = await setKeyActive(key.id);
        results.push({
          masked: maskKey(key.api_key),
          status: updateError ? "unverified" : "active",
          detail: updateError ?? validation.detail,
        });
      } else if (validation.status === "invalid") {
        const { error: updateError } = await supabaseAdmin
          .from("pexels_api_keys")
          .update({
            is_active: false,
            last_error: validation.detail,
            last_error_at: new Date().toISOString(),
          })
          .eq("id", key.id);
        results.push({
          masked: maskKey(key.api_key),
          status: "inactive",
          detail: updateError?.message ?? validation.detail,
        });
      } else {
        results.push({
          masked: maskKey(key.api_key),
          status: "unverified",
          detail: `${validation.detail} Existing active state was preserved.`,
        });
      }
    }

    return {
      total: results.length,
      active: results.filter((row) => row.status === "active").length,
      inactive: results.filter((row) => row.status === "inactive").length,
      unverified: results.filter((row) => row.status === "unverified").length,
      results,
    };
  });
