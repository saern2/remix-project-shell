import { createHmac, randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie, getRequest } from "@tanstack/react-start/server";
import { TRUSTED_CLIENT_HEADER } from "@/lib/trusted-client";

export const ACCESS_COOKIE_NAME = "ss_trusted_client";

function pepper() {
  const value = process.env.ACCESS_SECRET_PEPPER;
  if (!value || value.length < 32) {
    throw new Error("ACCESS_SECRET_PEPPER must be configured with at least 32 characters.");
  }
  return value;
}

export function secureHash(value: string) {
  return createHmac("sha256", pepper()).update(value, "utf8").digest("hex");
}

export function generateAccessSecret() {
  return `ss_${randomBytes(32).toString("base64url")}`;
}

export function generateClientToken() {
  return randomBytes(32).toString("base64url");
}

export function readTrustedClientToken() {
  const headerToken = getRequest()?.headers.get(TRUSTED_CLIENT_HEADER);
  if (headerToken && /^[a-f0-9]{64}$/.test(headerToken)) return headerToken;
  return getCookie(ACCESS_COOKIE_NAME);
}

export function writeTrustedClientToken(token: string) {
  setCookie(ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function clearTrustedClientToken() {
  deleteCookie(ACCESS_COOKIE_NAME, { path: "/" });
}

export async function hasTrustedAccess(userId: string) {
  const token = readTrustedClientToken();
  if (!token) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("check_access_activation", {
    p_user_id: userId,
    p_client_token_hash: secureHash(token),
  });
  if (error) throw new Error(`Access verification failed: ${error.message}`);
  return data === true;
}
