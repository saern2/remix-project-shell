'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiting = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new Error('Operation aborted while waiting for capacity'));
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abortHandler: null };
      waiter.abortHandler = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error('Operation aborted while waiting for capacity'));
      };
      signal?.addEventListener('abort', waiter.abortHandler, { once: true });
      this.waiting.push(waiter);
    });
  }

  release() {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.signal?.removeEventListener('abort', waiter.abortHandler);
      waiter.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

const ffmpegSemaphore = new Semaphore(config.ffmpegMaxProcesses);

async function acquireFfmpegSlot(jobId, signal) {
  await ffmpegSemaphore.acquire(signal);
  logger.info(
    {
      jobId,
      ffmpegActive: ffmpegSemaphore.active,
      ffmpegCapacity: ffmpegSemaphore.max,
      ffmpegThreads: config.ffmpegThreads,
    },
    'FFmpeg capacity acquired',
  );

  let released = false;
  return () => {
    if (released) return;
    released = true;
    ffmpegSemaphore.release();
    logger.info(
      { jobId, ffmpegActive: ffmpegSemaphore.active, ffmpegCapacity: ffmpegSemaphore.max },
      'FFmpeg capacity released',
    );
  };
}

async function readNumericFile(filePath) {
  try {
    const value = (await fsp.readFile(filePath, 'utf8')).trim();
    if (!value || value === 'max') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function availableMemoryBytes() {
  const cgroupV2Max = await readNumericFile('/sys/fs/cgroup/memory.max');
  const cgroupV2Current = await readNumericFile('/sys/fs/cgroup/memory.current');
  if (cgroupV2Max != null && cgroupV2Current != null) {
    return Math.max(0, cgroupV2Max - cgroupV2Current);
  }

  const cgroupV1Max = await readNumericFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const cgroupV1Current = await readNumericFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (cgroupV1Max != null && cgroupV1Current != null && cgroupV1Max < Number.MAX_SAFE_INTEGER) {
    return Math.max(0, cgroupV1Max - cgroupV1Current);
  }

  return os.freemem();
}

async function resourceSnapshot(baseDir) {
  await fsp.mkdir(baseDir, { recursive: true });
  const stats = await fsp.statfs(baseDir);
  return {
    cpuCount: config.detectedCpuCount,
    totalWorkerSlots: config.totalWorkerSlots,
    ffmpegThreads: config.ffmpegThreads,
    ffmpegCapacity: config.ffmpegMaxProcesses,
    diskFreeBytes: Number(stats.bavail) * Number(stats.bsize),
    memoryAvailableBytes: await availableMemoryBytes(),
    tempDir: path.resolve(baseDir),
  };
}

async function ensureResourceCapacity(baseDir, jobId) {
  const snapshot = await resourceSnapshot(baseDir);
  if (snapshot.diskFreeBytes < config.minFreeDiskBytes) {
    throw new Error(
      `RESOURCE_LIMIT: insufficient free disk for render ${jobId}; ` +
      `available=${snapshot.diskFreeBytes} required=${config.minFreeDiskBytes}`,
    );
  }
  if (snapshot.memoryAvailableBytes < config.minFreeMemoryBytes) {
    throw new Error(
      `RESOURCE_LIMIT: insufficient free memory for render ${jobId}; ` +
      `available=${snapshot.memoryAvailableBytes} required=${config.minFreeMemoryBytes}`,
    );
  }
  logger.info({ jobId, ...snapshot }, 'Render resource preflight passed');
  return snapshot;
}

async function readyChunkOutput(outputPath) {
  const markerPath = `${outputPath}.ready`;
  try {
    const [output, marker] = await Promise.all([fsp.stat(outputPath), fsp.stat(markerPath)]);
    return output.isFile() && output.size > 0 && marker.isFile();
  } catch {
    return false;
  }
}

function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Operation aborted while waiting for chunk lease'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operation aborted while waiting for chunk lease'));
    };
    const timer = setTimeout(() => {
      // Remove the abort listener on the normal path too — otherwise each poll
      // iteration leaks a listener on the (long-lived, per-phase) signal until it
      // is GC'd, which compounds the MaxListenersExceededWarning (round 6, Issue 5).
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function compareAndExpire(redis, key, token, ttlMs) {
  return redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    key,
    token,
    String(ttlMs),
  );
}

async function compareAndDelete(redis, key, token) {
  return redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );
}

/**
 * Claims the exclusive right to produce this chunk's output.
 *
 * THE FAILURE THIS IS HARDENED AGAINST: the returned `release()` used to be the
 * only thing that stopped the renewal interval, and renderJob never called it.
 * A chunk that failed therefore left an interval refreshing the Redis key every
 * 20s for the life of the worker process — an immortal lock. Every retry of that
 * chunk then waited out its full deadline and died with CHUNK_LOCK_TIMEOUT, so
 * the chunk could never complete and the render hung one chunk short, forever,
 * with no error. That is exactly the 12/13 hang.
 *
 * Two independent guards now, because "the caller always releases" is precisely
 * the assumption that failed:
 *   1. release() is idempotent and called from renderJob's finally on every path.
 *   2. Renewal is BOUNDED. It stops after maxLeaseMs regardless of whether
 *      anyone releases, so a leaked lease decays into an expiring key instead of
 *      an immortal one. A leak becomes a delay; it can no longer be a deadlock.
 */
async function acquireChunkLease({ redis, jobId, outputPath, signal, timeoutMs, maxLeaseMs }) {
  if (await readyChunkOutput(outputPath)) return { reused: true, release: async () => {} };

  const key = `render:chunk-lease:${jobId}`;
  const token = crypto.randomUUID();
  const ttlMs = Math.max(timeoutMs + 60_000, 120_000);
  const deadline = Date.now() + ttlMs;
  // Never renew past the watchdog's own deadline plus a grace margin: beyond
  // that point the holder is either dead or about to be killed, and the lease
  // must be allowed to lapse so somebody else can make progress.
  const renewUntil = Date.now() + (Number.isFinite(maxLeaseMs) ? maxLeaseMs : ttlMs) + 60_000;

  while (Date.now() < deadline) {
    const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      await fsp.rm(`${outputPath}.ready`, { force: true }).catch(() => {});

      let renewing = false;
      let released = false;
      const renewTimer = setInterval(async () => {
        if (renewing) return;
        if (Date.now() >= renewUntil) {
          // Backstop: stop propping the key up. Whatever holds it has outlived
          // any legitimate run, so let it expire on its own TTL.
          clearInterval(renewTimer);
          logger.warn({ jobId, key }, 'Chunk lease renewal budget exhausted; letting the lease expire');
          return;
        }
        renewing = true;
        try {
          const renewed = await compareAndExpire(redis, key, token, ttlMs);
          if (!renewed) logger.warn({ jobId }, 'Chunk lease renewal lost ownership');
        } catch (err) {
          logger.warn({ jobId, err: err.message }, 'Chunk lease renewal failed');
        } finally {
          renewing = false;
        }
      }, config.chunkLeaseRenewMs);
      renewTimer.unref?.();

      return {
        reused: false,
        get released() {
          return released;
        },
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(renewTimer);
          await compareAndDelete(redis, key, token).catch((err) => {
            logger.warn({ jobId, err: err.message }, 'Chunk lease release failed');
          });
          logger.debug({ jobId, key }, 'Chunk lease released');
        },
      };
    }

    if (await readyChunkOutput(outputPath)) return { reused: true, release: async () => {} };
    await abortableSleep(1000, signal);
  }

  throw new Error(`CHUNK_LOCK_TIMEOUT: another worker is still processing ${jobId}`);
}

// ── Job health (round 7) ────────────────────────────────────────────────────
// A chunk's trouble is invisible to the client: the client polls the STITCH job,
// whose status stays "rendering" and whose chunks_completed simply stops moving.
// The observed hang showed 12/13 with no error for minutes. Chunks publish their
// trouble here, keyed by parent job, so GET /jobs/:id can report it upward.
const JOB_HEALTH_TTL_MS = 10 * 60 * 1000;

const jobHealthKey = (parentJobId) => `render:job-health:${parentJobId}`;

async function publishJobHealth(redis, parentJobId, health) {
  try {
    await redis.set(
      jobHealthKey(parentJobId),
      JSON.stringify({ ...health, at: new Date().toISOString() }),
      'PX',
      JOB_HEALTH_TTL_MS,
    );
  } catch (err) {
    logger.warn({ parentJobId, err: err.message }, 'Job health publish failed');
  }
}

async function clearJobHealth(redis, parentJobId) {
  try {
    await redis.del(jobHealthKey(parentJobId));
  } catch {
    // Health is advisory; failing to clear it only means a stale notice expires
    // on its own TTL.
  }
}

async function readJobHealth(redis, parentJobId) {
  try {
    const raw = await redis.get(jobHealthKey(parentJobId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function markChunkReady(outputPath) {
  await fsp.writeFile(`${outputPath}.ready`, new Date().toISOString(), 'utf8');
}

function getFfmpegTelemetry() {
  return { active: ffmpegSemaphore.active, capacity: ffmpegSemaphore.max };
}

module.exports = {
  Semaphore,
  acquireFfmpegSlot,
  resourceSnapshot,
  ensureResourceCapacity,
  readyChunkOutput,
  acquireChunkLease,
  markChunkReady,
  getFfmpegTelemetry,
  publishJobHealth,
  clearJobHealth,
  readJobHealth,
};
