'use strict';

/**
 * Maintenance mode, worker side: freeze in-flight work without losing it.
 *
 * FREEZE, NOT DRAIN — the operator's call, and the right one. Draining lets one
 * stuck project hold maintenance hostage indefinitely, and whether a project
 * will ever finish is exactly what cannot be known in advance. Freezing is
 * bounded by definition: it takes effect at the next safe boundary of whatever
 * is running.
 *
 * The danger this module is built around is that "paused" and "hung" look
 * identical to every safety mechanism the worker has. The chunk watchdog kills
 * anything past its budget; BullMQ fails a job that stops renewing its lock;
 * the cleanup path deletes tempDir on the way out. A naive freeze — block the
 * loop, sleep until unfrozen — would trip all three and turn a deploy into 51
 * failed chunks.
 *
 * So a frozen job does not pause in place. It EXITS, promptly and cleanly, and
 * parks itself in BullMQ's delayed set:
 *
 *   - Exiting runs the normal `finally`, which cancels the watchdog. A timer
 *     that is not armed cannot fire, so the freeze cannot be killed by the
 *     mechanism meant to catch hangs. No suspend/resume of the watchdog is
 *     needed, and none is trustworthy: a suspended timer is one restart away
 *     from being a leaked one.
 *   - Parking with moveToDelayed + DelayedError does not consume a retry
 *     attempt. Waiting out a deploy is not a failure and must not spend one of
 *     the three attempts a genuine error will need.
 *   - On resume the job re-enters from the top with a FRESH watchdog budget, so
 *     time spent frozen is never charged against the chunk's deadline.
 *
 * What makes that a pause rather than a restart is that completed chunk outputs
 * stay on disk. A frozen job skips cleanup entirely, and `readyChunkOutput`
 * (size + marker, the machinery the retry-reuse work already proved) lets the
 * resumed run skip every chunk that finished before the freeze. Frozen at 30 of
 * 51 means resuming at 31.
 */

const config = require('./config');
const logger = require('./logger');
const admission = require('./admissionControl');

/** Operator-visible state, written by the admin dashboard through the worker API. */
const STATE_KEY = 'maintenance:state';
/** Projects parked by a freeze: projectId -> JSON. Drives the admin's frozen list. */
const FROZEN_KEY = 'maintenance:frozen';
/** Admission queue as it stood at freeze, so resume restores the order. */
const ADMISSION_SNAPSHOT_KEY = 'maintenance:admission-snapshot';

/** How long a frozen job waits before re-checking. */
const FREEZE_RECHECK_MS = 15_000;
/** How often a running job checks whether a freeze has begun. */
const FREEZE_POLL_INTERVAL_MS = 4_000;

/**
 * The env var, as a tri-state.
 *
 * Tri-state and not truthiness, because the override has to work in BOTH
 * directions: MAINTENANCE_MODE=false must force maintenance OFF even when the
 * database says on. Treating "false" as merely absent would leave the emergency
 * brake unable to release the brake.
 *
 * @returns {boolean|null} null when unset — the database decides.
 */
function envOverride(env = process.env) {
  const raw = env.MAINTENANCE_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(value)) return true;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(value)) return false;
  // An unrecognised value is not a licence to guess. The safe reading of a
  // malformed emergency brake is "the operator meant to pull it".
  logger.warn({ MAINTENANCE_MODE: raw }, 'Unrecognised MAINTENANCE_MODE; treating as enabled');
  return true;
}

/**
 * Merges the stored flag with the env override.
 *
 * Pure, so the precedence rule is testable without Redis — and so the admin UI
 * and the worker cannot drift into disagreeing about which source won.
 */
function resolveState(stored, override) {
  const storedEnabled = stored?.enabled === true;
  const enabled = override == null ? storedEnabled : override;
  return {
    enabled,
    message: stored?.message ?? null,
    enabledBy: stored?.enabledBy ?? null,
    enabledAt: stored?.enabledAt ?? null,
    source: override == null ? 'database' : 'env',
    envOverride: override,
    // True when the env var is actively contradicting the stored flag. The admin
    // UI must SAY this rather than showing a toggle that does nothing.
    overridden: override != null && override !== storedEnabled,
    storedEnabled,
  };
}

async function readStoredState(redis) {
  try {
    const raw = await redis.get(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn({ err: err.message }, 'Maintenance state read failed');
    return null;
  }
}

/** Full resolved state, for the status endpoint. */
async function readState(redis) {
  return resolveState(await readStoredState(redis), envOverride());
}

/**
 * Is work frozen right now?
 *
 * Fails OPEN — an unreachable Redis reports "not frozen" and work continues.
 * The opposite default would let a Redis blip freeze the whole platform, which
 * is a much worse failure than a deploy that briefly overlaps a running chunk;
 * the env var covers the case where the operator needs a guarantee.
 */
async function isFrozen(redis) {
  const override = envOverride();
  if (override != null) return override;
  try {
    const raw = await redis.get(STATE_KEY);
    return raw ? JSON.parse(raw).enabled === true : false;
  } catch (err) {
    logger.warn({ err: err.message }, 'Freeze check unavailable; work continues');
    return false;
  }
}

/**
 * Turns maintenance on or off and moves the admission queue with it.
 *
 * On freeze the admission queue is snapshotted; on resume it is restored with
 * fresh timestamps. See `restoreAdmission` for why the slots are not simply
 * held.
 */
async function setState(redis, { enabled, message = null, enabledBy = null }) {
  const next = {
    enabled: enabled === true,
    message: message || null,
    enabledBy: enabledBy || null,
    enabledAt: enabled === true ? new Date().toISOString() : null,
  };

  if (next.enabled) await snapshotAdmission(redis);
  await redis.set(STATE_KEY, JSON.stringify(next));
  if (!next.enabled) await restoreAdmission(redis);

  // The frozen list is NOT cleared on resume. Each job takes its own note down
  // when it starts running again, so whatever is still listed a few minutes
  // after maintenance ends is precisely the set of projects that did not come
  // back — which is the only reason to have the list at all. Clearing it here
  // would make every resume look successful.

  logger.warn(
    { enabled: next.enabled, enabledBy: next.enabledBy, message: next.message },
    next.enabled ? 'MAINTENANCE MODE ENABLED — freezing render work' : 'Maintenance mode disabled — resuming render work',
  );
  return readState(redis);
}

/**
 * Records the admission queue so resume can rebuild it.
 *
 * WHY SNAPSHOT RATHER THAN HOLD. Holding a slot through a freeze means
 * heartbeating it, and a slot that heartbeats while no work is running is
 * indistinguishable from the leak the heartbeat exists to catch — it would
 * survive an OOM kill and a worker restart as a permanently occupied slot with
 * nothing behind it. A snapshot gets the outcome the operator wants (a frozen
 * project resumes in place, not at the back of the queue) with none of that:
 * the queue is data at rest during the freeze, and the TTL machinery keeps
 * doing its job for everything else.
 */
async function snapshotAdmission(redis) {
  try {
    const snapshot = await admission.admissionSnapshot(redis);
    await redis.set(
      ADMISSION_SNAPSHOT_KEY,
      JSON.stringify({ active: snapshot.active, waiting: snapshot.waiting }),
    );
    logger.info(
      { active: snapshot.activeCount, waiting: snapshot.waitingCount },
      'Admission queue snapshotted for maintenance',
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Admission snapshot failed; resume will re-queue by arrival');
  }
}

/** Rebuilds the admission queue in its pre-freeze order. */
async function restoreAdmission(redis) {
  try {
    const raw = await redis.get(ADMISSION_SNAPSHOT_KEY);
    if (!raw) return;
    const { active = [], waiting = [] } = JSON.parse(raw);
    const now = Date.now();

    // Scores preserve ORDER, not the original timestamps: a project must not
    // resume already older than its own admission TTL, which is what replaying
    // pre-freeze timestamps after a long maintenance window would do.
    const pipeline = redis.pipeline();
    pipeline.del(admission.ACTIVE_KEY, admission.WAITING_KEY, admission.WAITING_SEEN_KEY);
    active.forEach((projectId, index) => {
      pipeline.zadd(admission.ACTIVE_KEY, now + index, projectId);
    });
    waiting.forEach((projectId, index) => {
      pipeline.zadd(admission.WAITING_KEY, now + index, projectId);
      pipeline.hset(admission.WAITING_SEEN_KEY, projectId, String(now));
    });
    await pipeline.exec();
    await redis.del(ADMISSION_SNAPSHOT_KEY);

    logger.info(
      { active: active.length, waiting: waiting.length },
      'Admission queue restored; frozen projects keep their place',
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Admission restore failed; projects re-queue by arrival');
  }
}

/**
 * Publishes that a job parked, so the admin can see it and — more usefully —
 * see it fail to come back.
 */
async function noteFrozen(redis, { projectId, jobId, phase, chunkIndex = null, chunksTotal = null }) {
  if (!projectId) return;
  try {
    await redis.hset(
      FROZEN_KEY,
      projectId,
      JSON.stringify({
        projectId,
        jobId,
        phase,
        chunkIndex,
        chunksTotal,
        frozenAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ jobId, err: err.message }, 'Frozen-job note failed');
  }
}

/**
 * Clears the note once the job is running again.
 *
 * Unconditional, and deliberately so. Guarding it on a worker-local "have I
 * frozen anything" flag would save one HDEL per chunk — unmeasurable beside a
 * 45-second chunk and the GET it already sits next to — at the cost of a
 * restarted worker never clearing notes it did not write, leaving the admin
 * looking at projects listed as frozen that resumed hours ago.
 */
async function clearFrozen(redis, projectId) {
  if (!projectId) return;
  await redis.hdel(FROZEN_KEY, projectId).catch(() => {});
}

/** The admin dashboard's frozen list. */
async function listFrozen(redis) {
  try {
    const rows = await redis.hgetall(FROZEN_KEY);
    return Object.values(rows ?? {})
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'Frozen list read failed');
    return [];
  }
}

/**
 * A sleep that notices the job finished.
 *
 * The job's `finally` awaits this loop, so a plain 4s sleep would add up to
 * four seconds to the completion of EVERY chunk — a real slowdown of working
 * renders, paid permanently, to support a feature that is off almost always.
 * Waking every `stepMs` to re-check bounds that cost at a tenth of a second
 * while keeping the actual Redis check at its 4s cadence.
 */
function interruptibleSleep(totalMs, done, stepMs = 100) {
  return new Promise((resolve) => {
    const deadline = Date.now() + totalMs;
    const tick = () => {
      const remaining = deadline - Date.now();
      if (done.value || remaining <= 0) return resolve();
      setTimeout(tick, Math.min(stepMs, remaining)).unref?.();
    };
    setTimeout(tick, Math.min(stepMs, totalMs)).unref?.();
  });
}

/**
 * Watches for a freeze while a job runs, and aborts its phase controllers when
 * one begins — the same shape as the cancellation poll, deliberately, because
 * "stop what you are doing at the next boundary" is the same problem.
 *
 * Sets `frozen.value` BEFORE aborting. The catch block distinguishes a freeze
 * from a cancellation by that flag alone, exactly as `timedOut` distinguishes a
 * hard timeout: an aborted signal on its own cannot tell them apart, and every
 * previous round that tried lost the distinction and mislabelled a retryable
 * event as terminal.
 */
async function pollFreezeUntilDone(redis, jobId, abortControllers, done, frozen) {
  while (!done.value) {
    await interruptibleSleep(FREEZE_POLL_INTERVAL_MS, done);
    if (done.value) break;
    if (await isFrozen(redis)) {
      frozen.value = true;
      logger.warn({ jobId }, 'Maintenance freeze detected; stopping at the next safe boundary');
      for (const controller of abortControllers) {
        try {
          controller.abort();
        } catch {
          // already aborted
        }
      }
      return true;
    }
  }
  return false;
}

module.exports = {
  STATE_KEY,
  FROZEN_KEY,
  ADMISSION_SNAPSHOT_KEY,
  FREEZE_RECHECK_MS,
  FREEZE_POLL_INTERVAL_MS,
  envOverride,
  resolveState,
  readState,
  isFrozen,
  setState,
  snapshotAdmission,
  restoreAdmission,
  noteFrozen,
  clearFrozen,
  listFrozen,
  pollFreezeUntilDone,
};
