/**
 * The render gate (V4/D4): motion jobs do not START while the render worker
 * has active chunks.
 *
 * LLEN bull:render-chunk:active is an O(1) read of BullMQ's own active list
 * for the render worker's chunk queue — read-only, no locks, invisible to
 * admissionControl and every render:* key. The list can briefly include a
 * stalled job whose worker died; for a start-gate that errs toward holding,
 * which is the right direction.
 *
 * The gate can only prevent starting. A 42-minute job cannot pause when a
 * render begins mid-flight — that overlap is protected by nice 19
 * (scheduler share) and, harder, by the container's cpus: 1.5 cgroup cap
 * (D4: 6.0 + 1.5 + 1.0 = 8.5 committed on 8 cores, against the 9.0 that
 * mirrored the 22 August overcommit).
 */

import config from './config.js';

export const RENDER_CHUNK_ACTIVE_KEY = 'bull:render-chunk:active';

/** True when a motion job may start now. */
export async function renderGateOpen(redis) {
  try {
    const active = await redis.llen(RENDER_CHUNK_ACTIVE_KEY);
    return Number(active) < config.renderGateMaxActiveChunks;
  } catch {
    // An unreadable gate holds: starting a 42-minute burst blind into a
    // possibly-rendering box is the wrong default on this hardware.
    return false;
  }
}
