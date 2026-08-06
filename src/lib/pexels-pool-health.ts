/**
 * Whether the Pexels key pool is big enough to keep working.
 *
 * WHAT THIS REPLACED. The same number used to be an upload gate: "minimum valid
 * keys before replacing pool". That gate is gone — uploads are additive now and
 * cannot take capacity away, so there is nothing left to gate. The number itself
 * was still worth keeping, because the risk it was aimed at is real; it just was
 * not the risk it was wired to.
 *
 * The pool does not shrink from uploads. It shrinks from keys expiring, being
 * revoked at Pexels, or being deactivated mid-run when they start returning 401
 * or 429. None of those announce themselves — the first symptom is matching
 * getting slower, then failing to find footage, on a project that looks fine
 * everywhere else. A floor turns that into something visible before it bites.
 */

/** Default floor. Five keys is enough to absorb one or two dying mid-run. */
export const DEFAULT_POOL_FLOOR = 5;

/**
 * Where the admin's chosen floor is kept.
 *
 * Browser-local rather than a database column: it is a notification preference
 * for whoever is watching the pool, not a property of the pool itself, and it
 * changes nothing about how the system behaves. A column and a migration would
 * be a lot of machinery for a number that only decides when a banner appears.
 */
export const POOL_FLOOR_STORAGE_KEY = "scene_smith_pexels_pool_floor";

export type PoolHealth = {
  level: "ok" | "low" | "empty";
  headline: string;
  detail: string;
};

/**
 * Compares the live pool against the floor.
 *
 * Three levels rather than two: an empty pool is not a warning, it is an
 * outage — matching cannot search Pexels at all — and it should not be dressed
 * in the same amber as "getting thin".
 */
export function describePoolHealth(activeKeys: number, floor: number): PoolHealth {
  const safeFloor = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : DEFAULT_POOL_FLOOR;

  if (activeKeys <= 0) {
    return {
      level: "empty",
      headline: "No active Pexels keys",
      detail:
        "Matching cannot search Pexels at all. Add keys now, or projects will fail to find footage.",
    };
  }

  if (activeKeys < safeFloor) {
    return {
      level: "low",
      headline: `Only ${activeKeys} active Pexels key${activeKeys === 1 ? "" : "s"} — below your floor of ${safeFloor}`,
      // Names the causes, because "add more keys" without them invites the
      // assumption that something deleted them.
      detail:
        "Keys drop out when they expire, are revoked at Pexels, or start failing mid-run and are deactivated. Add more before the pool runs out.",
    };
  }

  return {
    level: "ok",
    headline: `${activeKeys} active Pexels key${activeKeys === 1 ? "" : "s"}`,
    detail: `At or above your floor of ${safeFloor}.`,
  };
}

/** Whether the health level warrants showing a banner at all. */
export function shouldWarnAboutPool(health: PoolHealth): boolean {
  return health.level !== "ok";
}

/**
 * Clamps a floor typed into the admin field, or read back from storage.
 *
 * "Not set" has to be distinguished from "set to something small" BEFORE
 * Number() sees it: Number(null) and Number("") are both 0, which would clamp to
 * a floor of 1 and quietly disable the warning on a first visit — the one case
 * where nobody has yet chosen anything.
 */
export function normalizePoolFloor(value: unknown): number {
  if (value == null || value === "") return DEFAULT_POOL_FLOOR;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POOL_FLOOR;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}
