import { describe, expect, it, vi } from "vitest";
import { pexelsKeyActiveAfterValidation, validatePexelsKey } from "../pexels-keys.server";

describe("Pexels key validation", () => {
  it("reactivates an inactive key only after a valid response", () => {
    expect(pexelsKeyActiveAfterValidation(false, "valid")).toBe(true);
    expect(pexelsKeyActiveAfterValidation(false, "unverified")).toBe(false);
    expect(pexelsKeyActiveAfterValidation(true, "unverified")).toBe(true);
  });

  it.each([401, 403])("marks HTTP %s as invalid without retrying", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("rejected", { status }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);

    await expect(validatePexelsKey("key", { fetchImpl, sleep })).resolves.toMatchObject({
      status: "invalid",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 and accepts the same key when the next validation succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);

    await expect(validatePexelsKey("key", { fetchImpl, sleep })).resolves.toMatchObject({
      status: "valid",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("preserves a key as unverified after inconclusive failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);

    await expect(validatePexelsKey("key", { fetchImpl, sleep })).resolves.toMatchObject({
      status: "unverified",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000, 4_000]);
  });
});
