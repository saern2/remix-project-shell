/**
 * The initial tab of /projects/new, from the URL (Round C, R1).
 *
 * ?mode=script preselects the script tab — the "Script to Video" nav entry's
 * whole mechanism. Anything else, including the bare URL every pre-existing
 * link uses, stays "audio": the legacy default must not move. This function
 * decides ONLY the initial value of the existing useState; the Tabs
 * mode-switch and both submit handlers are untouched by construction.
 */
export function initialProjectMode(search: Record<string, unknown>): "audio" | "script" {
  return search["mode"] === "script" ? "script" : "audio";
}
