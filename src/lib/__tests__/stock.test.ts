import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerFamilyKey, searchStockFootage } from "../stock.server";

const { searchNasaFootage } = vi.hoisted(() => ({
  searchNasaFootage: vi.fn(),
}));

vi.mock("../nasaStock.server", () => ({
  searchNasaFootage,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const cacheQuery = {
    eq: () => cacheQuery,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return {
    supabaseAdmin: {
      from: () => ({
        select: () => cacheQuery,
        upsert: async () => ({ error: null }),
      }),
      rpc: async () => ({ error: null }),
    },
  };
});

describe("stock footage diversity helpers", () => {
  beforeEach(() => {
    searchNasaFootage.mockReset();
  });

  it("groups nearby numeric Pexels ids into a stable family key", () => {
    expect(providerFamilyKey("9467043")).toBe("9467");
    expect(providerFamilyKey("9467097")).toBe("9467");
    expect(providerFamilyKey("pexels-custom-id")).toBe("pexels-custom-id");
    expect(providerFamilyKey("Artemis I Launches to the Moon")).toBe(
      "Artemis I Launches to the Moon",
    );
  });

  it("does not call the default stock provider when a space search has no NASA result", async () => {
    searchNasaFootage.mockResolvedValue([]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await searchStockFootage({
      query: "finger hitting subscribe button",
      orientation: "landscape",
      minDurationSec: 4,
      targetWidth: 1280,
      usedIds: [],
      niche: "space",
    });

    expect(result).toBeNull();
    expect(searchNasaFootage).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
