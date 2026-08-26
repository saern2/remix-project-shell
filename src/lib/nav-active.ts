/**
 * Which nav entry lights up (Round C, Item 1).
 *
 * Two entries share /projects/new — Audio to Video (no search param, the
 * default tab, so every legacy bare link still lands on it) and Script to
 * Video (?mode=script). The old matcher compared pathname only, which would
 * light both; the mode param is the discriminator, and exactly one matches.
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
  search?: { mode: "script" };
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
    const scriptMode = location.search["mode"] === "script";
    return item.search?.mode === "script" ? scriptMode : !scriptMode;
  }
  return true;
}
