'use strict';

/**
 * Cross-attempt chunk reuse, keyed by CONTENT, not by job id.
 *
 * MEASURED, 2026-08-09: a project failed at 34/36 rendered segments. The
 * retry re-encoded all 36 — the 34 finished outputs were sitting on disk the
 * whole time, invisible because reuse was keyed by chunk JOB id and a retry
 * submits a brand-new job id. ~20 minutes of encoding to re-produce files
 * that already existed, twice over across the two retried projects.
 *
 * The key here is a hash of everything that determines a chunk's output
 * bytes: the clip list (source url + trim window), geometry, fps, the
 * timeline offset (frame arithmetic is cumulative across chunks), transition
 * settings, and container format. Same content, same output — whichever job
 * id asks for it. fallback/alternate urls are deliberately NOT part of the
 * identity: they are recovery routes, not requested content.
 *
 * Reuse is strictly best-effort and verified at claim time: the cached file
 * must still exist, carry its .ready marker, and match its recorded size.
 * Anything less falls through to a normal render — a cache can save work,
 * never corrupt it.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const logger = require('./logger');
const { readyChunkOutput, markChunkReady } = require('./resourceControl');

const CHUNK_CACHE_KEY_PREFIX = 'render:chunk-cache:';
/** Long enough to survive an overnight retry; short enough not to accumulate. */
const CHUNK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Everything that determines the chunk's output, nothing that doesn't. */
function chunkContentHash(payload) {
  const identity = {
    clips: (payload.clips ?? []).map((clip) => ({
      u: clip.clip_url,
      s: clip.start,
      e: clip.end,
    })),
    w: payload.width,
    h: payload.height,
    fps: payload.fps,
    offset: payload.timeline_offset_seconds ?? 0,
    transition: payload.transition,
    td: payload.transition_duration,
    format: payload.format,
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const cacheKey = (hash) => `${CHUNK_CACHE_KEY_PREFIX}${hash}`;

/** Publishes a finished chunk output so a future attempt can claim it. */
async function registerChunkOutput(redis, payload, outputPath) {
  try {
    const stat = await fsp.stat(outputPath);
    await redis.set(
      cacheKey(chunkContentHash(payload)),
      JSON.stringify({ path: outputPath, bytes: stat.size, at: new Date().toISOString() }),
      'PX',
      CHUNK_CACHE_TTL_MS,
    );
  } catch (err) {
    // Advisory. A chunk that rendered must complete whether or not it could
    // be advertised for reuse.
    logger.warn({ err: err.message, outputPath }, 'Chunk cache registration failed');
  }
}

/**
 * Claims a previous attempt's output for this job, if an identical chunk was
 * already rendered. Returns true when outputPath now holds a verified,
 * ready-marked copy; false means render normally.
 */
async function reuseCachedChunkOutput({ redis, payload, outputPath }) {
  let cached;
  try {
    const raw = await redis.get(cacheKey(chunkContentHash(payload)));
    if (!raw) return false;
    cached = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!cached?.path || cached.path === outputPath) return false;

  try {
    // The source must still be a complete, marked output of the right size —
    // the janitor may have swept it, or it may never have finished. Declining
    // is fine; declining SILENTLY is not (a cache that quietly never hits is
    // indistinguishable from one that works), so say why.
    if (!(await readyChunkOutput(cached.path))) {
      logger.warn(
        { from: cached.path, chunkIndex: payload.chunk_index ?? null },
        'Chunk cache entry no longer on disk; rendering normally',
      );
      return false;
    }
    const src = await fsp.stat(cached.path);
    if (src.size !== cached.bytes) {
      logger.warn(
        { from: cached.path, expectedBytes: cached.bytes, actualBytes: src.size },
        'Chunk cache entry size mismatch; rendering normally',
      );
      return false;
    }

    await fsp.copyFile(cached.path, outputPath);
    // Verify the copy too: marking a truncated file ready would hand the
    // stitch a corrupt segment, which is worse than re-encoding.
    const dest = await fsp.stat(outputPath);
    if (dest.size !== cached.bytes) {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      return false;
    }
    await markChunkReady(outputPath);
    logger.info(
      {
        from: cached.path,
        to: outputPath,
        bytes: cached.bytes,
        chunkIndex: payload.chunk_index ?? null,
      },
      'Reused chunk output from a previous render attempt (content match)',
    );
    return true;
  } catch (err) {
    logger.warn({ err: err.message, from: cached.path }, 'Chunk cache reuse failed; rendering normally');
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    return false;
  }
}

module.exports = {
  CHUNK_CACHE_KEY_PREFIX,
  CHUNK_CACHE_TTL_MS,
  chunkContentHash,
  registerChunkOutput,
  reuseCachedChunkOutput,
};
