/**
 * The initial tab of /projects/new, from the URL (Round C R1; Round D adds
 * the motion mode).
 *
 * ?mode=script and ?mode=motion preselect their tabs — the nav entries'
 * whole mechanism. Anything else, including the bare URL every pre-existing
 * link uses, stays "audio": the legacy default must not move. This function
 * decides ONLY the initial value of the existing useState; the Tabs
 * mode-switch and every submit handler are untouched by construction.
 */
export type ProjectMode = "audio" | "script" | "motion";

export function initialProjectMode(search: Record<string, unknown>): ProjectMode {
  const mode = search["mode"];
  if (mode === "script") return "script";
  if (mode === "motion") return "motion";
  return "audio";
}
