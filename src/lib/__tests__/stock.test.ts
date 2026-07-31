import { describe, expect, it } from "vitest";
import { providerFamilyKey } from "../stock.server";

describe("stock footage diversity helpers", () => {
  it("groups nearby numeric Pexels ids into a stable family key", () => {
    expect(providerFamilyKey("9467043")).toBe("9467");
    expect(providerFamilyKey("9467097")).toBe("9467");
    expect(providerFamilyKey("pexels-custom-id")).toBe("pexels-custom-id");
    expect(providerFamilyKey("Artemis I Launches to the Moon")).toBe(
      "Artemis I Launches to the Moon",
    );
  });
});
