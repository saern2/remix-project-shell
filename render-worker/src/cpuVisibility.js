'use strict';

/**
 * CPU visibility (Round A, Item 4) — LOG ONLY, by explicit order.
 *
 * THE DISCREPANCY THIS SURFACES. config.js:28 sizes the worker from
 * os.cpus().length, which reports the HOST's CPUs (8 on the production box).
 * The container is capped at 6 (docker-compose `cpus: 6`, NanoCpus=6e9,
 * confirmed via docker inspect during the 22 August outage) — so the worker
 * believes it has 8 cores, sizes 4 chunk slots x 2 ffmpeg threads = 8 encode
 * threads, and runs them into 6, on a box Hostinger then CPU-limited further.
 *
 * WHY THIS MUST NOT FEED SIZING (operator's B9): with detectedCpuCount=6 the
 * auto-sizing would compute ffmpegThreads = min(2, floor(6/4)) = 1 — silently
 * halving encode threads — and ffmpegMaxProcesses 8 -> 6. Both are on the
 * round's must-not-change list. This module only prints the truth side by
 * side, at startup, so the two numbers stop being invisible.
 *
 * Where the truth lives:
 *   cgroup v2: /sys/fs/cgroup/cpu.max            -> "600000 100000" (= 6.0 CPUs)
 *                                                    or "max 100000" (no cap)
 *   cgroup v1: /sys/fs/cgroup/cpu/cpu.cfs_quota_us  (-1 = no cap)
 *              /sys/fs/cgroup/cpu/cpu.cfs_period_us
 * Node's os.availableParallelism() (>= 20.3) is cgroup-quota-aware and gives
 * the same answer through libuv; both are logged as a cross-check.
 */

const fs = require('fs');
const os = require('os');

/** Parses cgroup v2 cpu.max content. Returns quota in CPUs, or null. */
function parseCpuMax(content) {
  if (typeof content !== 'string') return null;
  const [quotaRaw, periodRaw] = content.trim().split(/\s+/);
  if (!quotaRaw) return null;
  if (quotaRaw === 'max') return null; // explicitly uncapped
  const quota = Number(quotaRaw);
  const period = Number(periodRaw ?? 100000);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

/** Parses cgroup v1 quota/period file contents. Returns quota in CPUs, or null. */
function parseCfsQuota(quotaContent, periodContent) {
  const quota = Number(String(quotaContent ?? '').trim());
  const period = Number(String(periodContent ?? '').trim());
  if (!Number.isFinite(quota) || quota <= 0) return null; // -1 = no cap
  if (!Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

/** Reads the container's real CPU quota from the cgroup filesystem. */
function readCgroupCpuQuota(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const raw = readFile('/sys/fs/cgroup/cpu.max');
    return { version: 'v2', raw: raw.trim(), quotaCpus: parseCpuMax(raw) };
  } catch {
    // Not cgroup v2; try v1.
  }
  try {
    const quota = readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const period = readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    return {
      version: 'v1',
      raw: `${quota.trim()}/${period.trim()}`,
      quotaCpus: parseCfsQuota(quota, period),
    };
  } catch {
    return { version: null, raw: null, quotaCpus: null };
  }
}

/**
 * One startup log line with every CPU number side by side. Changes nothing —
 * the values config.js sized from are printed AS SIZED, so a mismatch between
 * osCpus and cgroupQuotaCpus is readable straight off this line.
 */
function logCpuVisibility(logger, config) {
  const cgroup = readCgroupCpuQuota();
  logger.info(
    {
      osCpus: os.cpus().length,
      availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
      cgroupVersion: cgroup.version,
      cgroupCpuRaw: cgroup.raw,
      cgroupQuotaCpus: cgroup.quotaCpus,
      sizedFrom: config.detectedCpuCount,
      ffmpegThreads: config.ffmpegThreads,
      chunkConcurrency: config.workerConcurrencyChunks,
      ffmpegMaxProcesses: config.ffmpegMaxProcesses,
    },
    'CPU visibility: os.cpus() vs cgroup quota (log only; sizing unchanged by order)',
  );
}

module.exports = { parseCpuMax, parseCfsQuota, readCgroupCpuQuota, logCpuVisibility };
