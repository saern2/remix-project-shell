import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_PRODUCT_NAME, LANDING_PRODUCT_NAME } from "@/lib/branding";

/**
 * Round C, Item 4 (R3): the product names move behind constants so the
 * eventual rename is one edit per surface — but THIS round changes no
 * displayed name. Written before the swap, per the operator's order, so any
 * character that moves fails here. Every composed string below is the exact
 * pre-swap literal, byte for byte — including "Auto Video Creator v2"'s
 * suffix, the hyphen in the users title and the em dash in the admin title.
 */

describe("the two product names, exactly as they display today", () => {
  it("pins the landing surface name", () => {
    expect(LANDING_PRODUCT_NAME).toBe("Auto Video Creator");
  });

  it("pins the app-shell surface name", () => {
    expect(APP_PRODUCT_NAME).toBe("Scene Smith");
  });
});

describe("every composed string is byte-identical to its pre-swap literal", () => {
  it("__root.tsx APP_TITLE keeps the v2 suffix", () => {
    expect(`${LANDING_PRODUCT_NAME} v2`).toBe("Auto Video Creator v2");
  });

  it("__root.tsx APP_DESCRIPTION", () => {
    expect(
      `Turn audio into scene-matched video. Upload a track and let ${LANDING_PRODUCT_NAME} draft a video for you.`,
    ).toBe(
      "Turn audio into scene-matched video. Upload a track and let Auto Video Creator draft a video for you.",
    );
  });

  it("users.tsx title (hyphen, not em dash)", () => {
    expect(`User management - ${LANDING_PRODUCT_NAME}`).toBe("User management - Auto Video Creator");
  });

  it("admin.tsx title (em dash, not hyphen)", () => {
    expect(`Admin panel — ${LANDING_PRODUCT_NAME}`).toBe("Admin panel — Auto Video Creator");
  });

  it("settings.tsx appearance line", () => {
    expect(`Choose how ${APP_PRODUCT_NAME} looks on this device.`).toBe(
      "Choose how Scene Smith looks on this device.",
    );
  });
});

describe("no literal product name survives outside branding.ts", () => {
  it("greps the whole src tree", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules") continue;
          walk(path);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry)) continue;
        if (path.endsWith(join("lib", "branding.ts"))) continue;
        const source = readFileSync(path, "utf8");
        if (source.includes("Auto Video Creator") || source.includes("Scene Smith")) {
          offenders.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
