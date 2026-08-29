/**
 * Which nav entry lights up (Round C, Item 1).
 *
 * The project-creation entries share /projects/new — Audio to Video (no
 * search param, the default tab, so every legacy bare link still lands on
 * it), Script to Video (?mode=script) and Motion Explainer (?mode=motion).
 * The old matcher compared pathname only, which would light them all; the
 * mode param is the discriminator, and exactly one matches.
 *
 * DECISION, NOT OVERSIGHT (operator's R4): the highlight follows the URL,
 * not the live tab. A user who arrives via "Audio to Video" and clicks the
 * Script tab in-page keeps the Audio highlight — syncing tab state back into
 * the URL would touch mode-switch behaviour, which Round C is forbidden to
 * change. Cosmetic, transient, accepted.
 *
 * Pre-existing and deliberately untouched: "Projects" (/projects, non-exact)
 * also matches on /projects/new via the startsWith rule, exactly as before
 * this round — same-behaviour is the round's guarantee.
 */

export type NavTarget = {
  to: string;
  exact?: boolean;
  search?: { mode: "script" | "motion" };
};

export type NavLocation = {
  pathname: string;
  search: Record<string, unknown>;
};

export function isNavItemActive(location: NavLocation, item: NavTarget): boolean {
  const { pathname } = location;
  if (item.to === "/dashboard" && !item.exact) {
    return pathname === "/dashboard" || pathname.startsWith("/projects/");
  }
  const pathMatches = item.exact
    ? pathname === item.to
    : pathname === item.to || pathname.startsWith(`${item.to}/`);
  if (!pathMatches) return false;
  if (item.to === "/projects/new") {
    // Three entries share the route (audio bare, script and motion via the
    // mode param); an unrecognised param counts as the audio default, the
    // same rule initialProjectMode applies — so highlight and content agree.
    const raw = location.search["mode"];
    const urlMode = raw === "script" || raw === "motion" ? raw : undefined;
    return urlMode === item.search?.mode;
  }
  return true;
}
