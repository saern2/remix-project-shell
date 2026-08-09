'use strict';

/**
 * A chunk that fails terminally must not orphan the project it belongs to.
 *
 * THE 5-HOUR STALL, 2026-08-09. Four projects sat at their final 1-2 chunks for
 * five hours on a completely idle machine. Redis, captured before any restart:
 *
 *   render-chunk    failed: 5      (728cf014-chunk-17, e1a1a052-chunk-17,
 *                                   7fa3bdf3-chunk-26, b2bd044a-chunk-7,
 *                                   b2bd044a-chunk-8)  -> FOUR distinct projects
 *   render-stitch   waiting-children: 4
 *
 * Four projects with a terminally failed chunk; four stitch parents waiting.
 * That is not a coincidence, it is the mechanism.
 *
 * In a BullMQ flow, a parent leaves `waiting-children` only when every child
 * COMPLETES. A child that exhausts its attempts moves to `failed` and its
 * dependency is never resolved — so the parent waits forever, by design, unless
 * `failParentOnFailure` or `ignoreDependencyOnFailure` is set on the child.
 * Neither appears anywhere in this codebase. The wait is unbounded and silent:
 * nothing is active, so the chunk watchdog never armed; nothing holds a lock, so
 * BullMQ's stalled detection had nothing to detect; the parent is not active, so
 * the stitch watchdog never armed either. Every alarm we own watches RUNNING
 * work, and this work had stopped running.
 *
 * WHY NOT JUST SET failParentOnFailure. It would make the stall impossible, and
 * it is one line — but it fails the whole project the instant one chunk gives
 * up, discarding 46 of 47 finished chunks and forcing a full re-render. The
 * cheaper and more honest order is: try the failed chunk again a bounded number
 * of times, and only then make it a visible failure. That is what this does.
 *
 * Recovery goes through job.retry(), which is BullMQ's own API for moving a job
 * out of `failed`. That matters beyond tidiness: the Lua behind it maintains the
 * queue marker that wakes an idle-blocked worker. Hand-rolled zset surgery does
 * not, and a job placed where no worker is watching is the same silence in a new
 * costume.
 */

const logger = require('./logger');

/** Recovery attempts per chunk, kept in Redis so a restart cannot reset them. */
const RECOVERY_KEY_PREFIX = 'render:chunk-recovery:';
/** Long enough to outlive any render, short enough not to accumulate. */
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many times a terminally-failed chunk is put back.
 *
 * Two, deliberately. Each recovery is a full fresh attempt cycle (jobAttempts
 * tries), so this is up to three cycles in total before the project is declared
 * broken. Past that the failure is not transient and repeating it only extends
 * the silence this exists to end.
 */
const MAX_CHUNK_RECOVERIES = 2;

const recoveryKey = (chunkJobId) => `${RECOVERY_KEY_PREFIX}${chunkJobId}`;

/**
 * The WHY of a terminal chunk failure, kept per project for the status API.
 *
 * MEASURED GAP, 2026-08-09: two projects failed the same segment across two
 * complete re-renders ("These 4 Nearby Planets" 20/21 twice, "Time Is Not
 * Permanent" 32/45 twice) and nothing durable recorded what the chunk actually
 * died of — the HARs carry only "N segment(s) could not be rendered" and the
 * job-health record had expired on its 10-minute TTL long before anyone looked.
 * A deterministic per-content failure was undiagnosable from the outside.
 *
 * A Redis hash keyed by project, one field per chunk index, written the moment
 * recovery is exhausted. HSET is atomic per field, so two chunks failing at
 * once cannot lose each other's reason the way a read-modify-write of the
 * stitch job's data could.
 */
const FAILURE_DETAIL_KEY_PREFIX = 'render:chunk-failure:';

const failureDetailKey = (projectId) => `${FAILURE_DETAIL_KEY_PREFIX}${projectId}`;

/** One readable line: a user sees this, not a log viewer. */
function trimFailureDetail(reason) {
  const text = String(reason ?? 'Unknown error').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Records why a chunk gave up, so the eventual project failure can say so. */
async function recordChunkFailureDetail(redis, projectId, chunkIndex, reason) {
  if (!projectId || chunkIndex == null) return;
  const key = failureDetailKey(projectId);
  await redis.hset(key, String(chunkIndex), trimFailureDetail(reason));
  await redis.pexpire(key, RECOVERY_TTL_MS);
}

/** A chunk that eventually completed did not kill the project: forget it. */
async function clearChunkFailureDetail(redis, projectId, chunkIndex) {
  if (!projectId || chunkIndex == null) return;
  await redis.hdel(failureDetailKey(projectId), String(chunkIndex)).catch(() => {});
}

/** All recorded reasons for a project, ordered by chunk index. */
async function readChunkFailureDetails(redis, projectId) {
  if (!projectId) return [];
  try {
    const raw = await redis.hgetall(failureDetailKey(projectId));
    return Object.entries(raw ?? {})
      .map(([index, reason]) => ({ chunkIndex: Number(index), reason }))
      .filter((entry) => Number.isFinite(entry.chunkIndex))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  } catch {
    // Advisory: a status poll must not fail because the detail was unreadable.
    return [];
  }
}

/** Has this chunk exhausted its ordinary BullMQ attempts? */
function isTerminalFailure(job) {
  const made = Number(job?.attemptsMade ?? 0);
  const allowed = Number(job?.opts?.attempts ?? 1);
  return made >= allowed;
}

/** Bumps and returns this chunk's recovery count. */
async function countRecovery(redis, chunkJobId) {
  const key = recoveryKey(chunkJobId);
  const count = await redis.incr(key);
  await redis.pexpire(key, RECOVERY_TTL_MS);
  return Number(count);
}

/** Forgets a chunk's recovery history once it succeeds. */
async function clearRecovery(redis, chunkJobId) {
  await redis.del(recoveryKey(chunkJobId)).catch(() => {});
}

/**
 * Puts a terminally-failed chunk back on the queue, or reports that it is done
 * trying.
 *
 * @returns {Promise<{action: 'retried'|'exhausted'|'skipped', recoveries: number}>}
 */
async function recoverFailedChunk({ redis, job, error }) {
  if (!job || !isTerminalFailure(job)) {
    // BullMQ still has attempts left; its own backoff will handle this.
    return { action: 'skipped', recoveries: 0 };
  }

  let recoveries = 0;
  try {
    recoveries = await countRecovery(redis, job.id);
  } catch (err) {
    // Without a counter we cannot bound the loop, so treat it as exhausted
    // rather than risk retrying forever.
    logger.warn({ jobId: job.id, err: err.message }, 'Chunk recovery counter unavailable');
    return { action: 'exhausted', recoveries: MAX_CHUNK_RECOVERIES + 1 };
  }

  if (recoveries > MAX_CHUNK_RECOVERIES) {
    logger.error(
      { jobId: job.id, recoveries, error: error?.message ?? null },
      'Chunk failed terminally and has exhausted recovery; its project cannot finish without intervention',
    );
    return { action: 'exhausted', recoveries };
  }

  try {
    // job.retry() — not a hand-rolled move. It maintains the queue marker that
    // wakes a worker blocked on an empty queue.
    await job.retry('failed');
    logger.error(
      { jobId: job.id, recoveries, maxRecoveries: MAX_CHUNK_RECOVERIES, error: error?.message ?? null },
      'Chunk failed terminally; requeued so its stitch parent is not left waiting forever',
    );
    return { action: 'retried', recoveries };
  } catch (err) {
    logger.error(
      { jobId: job.id, err: err.message },
      'Chunk recovery requeue failed; the reconciler is now the only path back',
    );
    return { action: 'exhausted', recoveries };
  }
}

module.exports = {
  MAX_CHUNK_RECOVERIES,
  RECOVERY_KEY_PREFIX,
  FAILURE_DETAIL_KEY_PREFIX,
  isTerminalFailure,
  countRecovery,
  clearRecovery,
  recoverFailedChunk,
  trimFailureDetail,
  recordChunkFailureDetail,
  clearChunkFailureDetail,
  readChunkFailureDetails,
};
