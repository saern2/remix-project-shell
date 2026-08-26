import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNavItemActive } from "@/lib/nav-active";
import { initialProjectMode } from "@/lib/project-mode";

/**
 * Round C, Item 1: two nav entries, one route, the mode param as the
 * discriminator — and the legacy default nailed down: a bare /projects/new
 * must stay the audio tab, because every pre-existing link is bare.
 */

const AUDIO_ENTRY = { to: "/projects/new" };
const SCRIPT_ENTRY = { to: "/projects/new", search: { mode: "script" as const } };

describe("initialProjectMode — what each nav entry preselects (R1)", () => {
  it("?mode=script yields the script tab", () => {
    expect(initialProjectMode({ mode: "script" })).toBe("script");
  });

  it("a bare /projects/new yields audio — the legacy-link default must not move", () => {
    expect(initialProjectMode({})).toBe("audio");
  });

  it("anything unrecognised degrades to audio", () => {
    expect(initialProjectMode({ mode: "audio" })).toBe("audio");
    expect(initialProjectMode({ mode: "SCRIPT" })).toBe("audio");
    expect(initialProjectMode({ mode: 42 })).toBe("audio");
  });
});

describe("isNavItemActive — exactly one of the two entries highlights", () => {
  it("bare /projects/new: audio active, script not", () => {
    const location = { pathname: "/projects/new", search: {} };
    expect(isNavItemActive(location, AUDIO_ENTRY)).toBe(true);
    expect(isNavItemActive(location, SCRIPT_ENTRY)).toBe(false);
  });

  it("?mode=script: script active, audio not", () => {
    const location = { pathname: "/projects/new", search: { mode: "script" } };
    expect(isNavItemActive(location, SCRIPT_ENTRY)).toBe(true);
    expect(isNavItemActive(location, AUDIO_ENTRY)).toBe(false);
  });

  it("each entry's own link resolves to the mode it claims to open", () => {
    // The nav promise, end to end: the search each entry links with, fed to
    // the initial-mode decision, yields that entry's tab.
    expect(initialProjectMode(SCRIPT_ENTRY.search)).toBe("script");
    expect(initialProjectMode({})).toBe("audio");
  });

  it("neither entry lights up anywhere else", () => {
    for (const location of [
      { pathname: "/dashboard", search: {} },
      { pathname: "/projects", search: {} },
      { pathname: "/projects/abc123", search: {} },
    ]) {
      expect(isNavItemActive(location, AUDIO_ENTRY)).toBe(false);
      expect(isNavItemActive(location, SCRIPT_ENTRY)).toBe(false);
    }
  });

  it("pre-existing behaviour of the other entries is unchanged", () => {
    // Dashboard, exact: only its own path.
    const dash = { to: "/dashboard", exact: true };
    expect(isNavItemActive({ pathname: "/dashboard", search: {} }, dash)).toBe(true);
    expect(isNavItemActive({ pathname: "/projects/new", search: {} }, dash)).toBe(false);
    // Projects, non-exact: matches /projects/new via startsWith, exactly as
    // before this round — same-behaviour is the round's guarantee, so the
    // quirk is pinned, not fixed.
    const projects = { to: "/projects" };
    expect(isNavItemActive({ pathname: "/projects/new", search: {} }, projects)).toBe(true);
  });
});

describe("wiring pins", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("projects.new reads the URL only for the initial mode (R1's exact scope)", () => {
    const source = read("src/routes/_authenticated/projects.new.tsx");
    expect(source).toContain('useSearch({ strict: false })');
    expect(source).toContain("useState<\"audio\" | \"script\">(initialProjectMode(urlSearch))");
    // The mode switch itself is untouched:
    expect(source).toContain('onValueChange={(value) => setMode(value as "audio" | "script")}');
  });

  it("the shell carries both entries, adjacent, with the script one parameterised", () => {
    const source = read("src/components/app-shell.tsx");
    expect(source).toContain('{ label: "Audio to Video", to: "/projects/new", icon: AudioLines }');
    expect(source).toContain(
      '{ label: "Script to Video", to: "/projects/new", icon: FileText, search: { mode: "script" } }',
    );
  });

  it("the dashboard empty state offers both paths with the same links (R2)", () => {
    const source = read("src/components/project-overview.tsx");
    expect(source).toContain("Audio to Video");
    expect(source).toContain("Script to Video");
    expect(source).toContain('search={{ mode: "script" } as never}');
  });
});
