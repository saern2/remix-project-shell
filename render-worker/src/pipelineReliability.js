'use strict';

/**
 * pipelineReliability.js
 *
 * Domain service for render pipeline reliability concerns.
 * Central home for retry/timeout formulas, cancellation flag R/W,
 * and scoped AbortController factory.
 *
 * Architectural invariants:
 *  - buildChunkOpts is a pure function: no side effects, no I/O, no Redis/BullMQ imports.
 *  - writeCancelFlag is the sole writer of cancel:<jobId> keys in Redis.
 *  - createScopedAbortController returns a fresh AbortController per invocation;
 *    callers must never share a controller across downloads or FFmpeg processes.
 */

/**
 * buildChunkOpts(clips, cfg) → BullMQ opts object
 *
 * Pure function — no side effects, no I/O.
 *
 * Computes retry attempts, exponential backoff config, and a dynamic per-chunk
 * timeout that respects both a configured floor and a proportional budget derived
 * from the total clip duration in this chunk.
 *
 * @param {Array<{clip_url: string, start: number, end: number}>} clips
 *   The clips belonging to this specific chunk.
 * @param {{ chunkTimeoutSeconds: number, jobAttempts: number, jobBackoffDelayMs: number }} cfg
 *   Configuration values (subset of config.js output).
 * @returns {{ attempts: number, backoff: { type: string, delay: number }, timeout: number }}
 *   BullMQ opts fields: attempts, backoff, and timeout (in milliseconds).
 */
function buildChunkOpts(clips, cfg) {
  const totalDurationSeconds = clips.reduce((s, c) => s + (c.end - c.start), 0);
  const dynamicTimeoutSeconds = Math.max(
    cfg.chunkTimeoutSeconds,
    Math.ceil(totalDurationSeconds * 1.5) + 60
  );
  return {
    attempts: cfg.jobAttempts,
    backoff: { type: 'exponential', delay: cfg.jobBackoffDelayMs },
    timeout: dynamicTimeoutSeconds * 1000, // BullMQ expects milliseconds
  };
}

/**
 * writeCancelFlag(redis, jobId) → Promise<void>
 *
 * Sets `cancel:<jobId> = '1'` in Redis with a 3600-second TTL.
 * Called by the cancel endpoint for any active (running) job.
 *
 * @param {object} redis - ioredis client instance.
 * @param {string} jobId - BullMQ job ID (e.g. "abc123-chunk-0").
 * @returns {Promise<void>}
 */
async function writeCancelFlag(redis, jobId) {
  await redis.set(`cancel:${jobId}`, '1', 'EX', 3600);
}

/**
 * checkCancellation(redis, jobId) → Promise<boolean>
 *
 * Returns true if the Redis key `cancel:<jobId>` exists, indicating the job
 * has been requested to cancel.
 *
 * @param {object} redis - ioredis client instance.
 * @param {string} jobId - BullMQ job ID.
 * @returns {Promise<boolean>}
 */
async function checkCancellation(redis, jobId) {
  const val = await redis.get(`cancel:${jobId}`);
  return val !== null;
}

/**
 * createScopedAbortController() → AbortController
 *
 * Factory that returns a fresh AbortController scoped to a single operation
 * (one download batch or one FFmpeg invocation). Callers must never share the
 * returned controller across multiple concurrent operations.
 *
 * @returns {AbortController}
 */
function createScopedAbortController() {
  return new AbortController();
}

module.exports = {
  buildChunkOpts,
  writeCancelFlag,
  checkCancellation,
  createScopedAbortController,
};
