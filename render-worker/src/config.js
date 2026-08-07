'use strict';

/**
 * config.js - All configuration derived from environment variables.
 * Import this module; never read process.env directly in other modules.
 */

const os = require('os');

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function intEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return n;
}

function strEnv(name, defaultValue) {
  return process.env[name] ?? defaultValue;
}

const detectedCpuCount = Math.max(1, os.cpus().length);

const config = {
  port: intEnv('PORT', 3001),
  nodeEnv: strEnv('NODE_ENV', 'development'),
  logLevel: strEnv('LOG_LEVEL', 'info'),

  workerApiKey: requireEnv('WORKER_API_KEY'),

  redisUrl: strEnv('REDIS_URL', 'redis://localhost:6379'),
  workerConcurrency: intEnv('WORKER_CONCURRENCY', 2),
  jobAttempts: intEnv('JOB_ATTEMPTS', 3),
  jobBackoffDelayMs: intEnv('JOB_BACKOFF_DELAY_MS', 5000),
  bullStalledIntervalMs: intEnv('BULL_STALLED_INTERVAL_MS', 30_000),
  bullLockRenewTimeMs: intEnv('BULL_LOCK_RENEW_TIME_MS', 20_000),

  jobTimeoutSeconds: intEnv('JOB_TIMEOUT_SECONDS', 600),
  chunkTimeoutSeconds: intEnv('CHUNK_TIMEOUT_SECONDS', 300),
  stitchTimeoutSeconds: intEnv('STITCH_TIMEOUT_SECONDS', 600),
  chunkSize: intEnv('CHUNK_SIZE', 12),
  workerConcurrencyChunks: intEnv('WORKER_CONCURRENCY_CHUNKS', 4),
  workerConcurrencyStitches: intEnv('WORKER_CONCURRENCY_STITCHES', 2),
  maxClips: intEnv('MAX_CLIPS', 5000),
  maxDurationSeconds: intEnv('MAX_DURATION_SECONDS', 14400),
  maxDownloadBytes: intEnv('MAX_DOWNLOAD_BYTES', 2 * 1024 * 1024 * 1024),
  maxStitchDownloadBytes: intEnv('MAX_STITCH_DOWNLOAD_BYTES', 10 * 1024 * 1024 * 1024),
  // Hard per-clip size ceiling. A single stock clip above this is rejected before
  // its body is streamed (via the Content-Length pre-check), so an oversized source
  // fails fast with a clear message instead of timing out mid-transfer. Default 150 MB.
  maxClipBytes: intEnv('MAX_CLIP_BYTES', 150 * 1024 * 1024),
  // Total concurrent CDN downloads across the whole worker process. This is the
  // shared authority: as more chunks download at once, each gets a smaller fair
  // share via the semaphore queue rather than every stream contending for the pipe.
  // Lowered from 15 → 4 because a saturated pipe split 15 ways made large clips
  // time out deterministically (round 6, Issue 2).
  globalCdnConcurrency: intEnv('GLOBAL_CDN_CONCURRENCY', 4),
  ffmpegThreads: intEnv('FFMPEG_THREADS', 0),
  /**
   * x264 preset for CHUNK encodes. Stitch never re-encodes video, so this only
   * affects chunk throughput and output size.
   *
   * DEFAULT STAYS veryfast, against the initial plan, because the measurement
   * inverted the decision. Benchmarked at 1080p30 CRF 23, threads=2, on two
   * different content types:
   *
   *                 high-detail            smooth/photographic
   *   veryfast      20.9s   39.3 MB        26.2s    5.54 MB
   *   superfast     17.4s   74.9 MB        15.2s   11.88 MB
   *                 1.20x    1.91x         1.72x     2.14x
   *
   * superfast is 1.2-1.7x faster but produces roughly DOUBLE the bytes, on both
   * content types. Outputs are already 1.2-1.4 GB and uploads were about 30% of
   * wall-clock, so doubling the file adds more upload time than the encode
   * saves: at the observed split, superfast is a net loss unless upload is under
   * ~15% of the total.
   *
   * The benchmarks above are synthetic and were taken on different hardware, so
   * the absolute throughput does not transfer — the SIZE RATIO is the part that
   * does, and it reproduced across both sources. Settle it on real footage with
   * scripts/preset-benchmark.sh, then set FFMPEG_PRESET if it disagrees.
   */
  ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
  ffmpegMaxProcesses: intEnv('FFMPEG_MAX_PROCESSES', 0),
  minFreeDiskBytes: intEnv('MIN_FREE_DISK_BYTES', 2 * 1024 * 1024 * 1024),
  minFreeMemoryBytes: intEnv('MIN_FREE_MEMORY_BYTES', 256 * 1024 * 1024),
  chunkLeaseRenewMs: intEnv('CHUNK_LEASE_RENEW_MS', 20_000),
  fairnessPriorityStride: intEnv('FAIRNESS_PRIORITY_STRIDE', 1000),

  // Legacy total-duration download cap, kept for backward compatibility but no
  // longer the primary guard. The download path now aborts on *stall* (no bytes
  // for downloadStallTimeoutSeconds) with an absolute downloadMaxSeconds backstop,
  // so a slow-but-progressing transfer is allowed to finish (round 6, Issue 3).
  downloadTimeoutSeconds: intEnv('DOWNLOAD_TIMEOUT_SECONDS', 60),
  // Abort a download only when no bytes have arrived for this many seconds.
  downloadStallTimeoutSeconds: intEnv('DOWNLOAD_STALL_TIMEOUT_SECONDS', 30),
  // Absolute ceiling on any single download, regardless of progress (backstop).
  downloadMaxSeconds: intEnv('DOWNLOAD_MAX_SECONDS', 600),
  tempDir: strEnv('TEMP_DIR', '/tmp/render-tmp'),
  outputDir: strEnv('OUTPUT_DIR', '/tmp/renders'),

  urlAllowlist: strEnv('URL_ALLOWLIST', '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

const effectiveChunkConcurrency = Math.min(config.workerConcurrencyChunks, detectedCpuCount);
config.detectedCpuCount = detectedCpuCount;
config.totalWorkerSlots =
  config.workerConcurrency + effectiveChunkConcurrency + config.workerConcurrencyStitches;

/**
 * Slots that actually compete for ENCODE cpu.
 *
 * The thread budget used to divide by totalWorkerSlots, which counted two
 * things that do not encode:
 *
 *   - the legacy `render` queue (workerConcurrency, 2 slots). With CHUNK_SIZE
 *     set, every job is chunked and that queue never runs, so it reserved a
 *     quarter of the machine for nothing.
 *   - stitch slots. Stitch concatenates with -c:v copy — no re-encode — so it
 *     is I/O and muxing, not encode cpu.
 *
 * On the 8 vCPU host that produced floor(8/8) = 1 thread per chunk. Measured on
 * that hardware at 1080p30 CRF 23: threads=1 gives 1.44x realtime, threads=2
 * gives 3.2x, threads=4 gives 3.44x. Two threads is the knee — 2.2x the
 * throughput of one, while a fourth thread adds 7%.
 *
 * Dividing by chunk concurrency alone gives floor(8/4) = 2, which lands exactly
 * on that knee. The cap makes the relationship explicit rather than incidental:
 * past two threads x264 returns very little, so extra cpu is better spent on
 * another concurrent chunk.
 */
config.encodeWorkerSlots = Math.max(1, effectiveChunkConcurrency);
config.maxFfmpegThreads = intEnv('MAX_FFMPEG_THREADS', 2);
if (config.ffmpegThreads === 0) {
  config.ffmpegThreads = Math.max(
    1,
    Math.min(config.maxFfmpegThreads, Math.floor(detectedCpuCount / config.encodeWorkerSlots)),
  );
}
if (config.ffmpegMaxProcesses === 0) {
  config.ffmpegMaxProcesses = Math.max(1, Math.min(detectedCpuCount, config.totalWorkerSlots));
}

if (config.jobAttempts <= 0) throw new Error('JOB_ATTEMPTS must be > 0, got: ' + config.jobAttempts);
if (config.jobBackoffDelayMs < 0) throw new Error('JOB_BACKOFF_DELAY_MS must be >= 0, got: ' + config.jobBackoffDelayMs);
if (config.ffmpegThreads <= 0) throw new Error('FFMPEG_THREADS must be > 0 after auto sizing');
if (config.ffmpegMaxProcesses <= 0) throw new Error('FFMPEG_MAX_PROCESSES must be > 0 after auto sizing');
if (config.bullLockRenewTimeMs < 15_000 || config.bullLockRenewTimeMs > 30_000) {
  throw new Error('BULL_LOCK_RENEW_TIME_MS must be between 15000 and 30000');
}
if (config.chunkLeaseRenewMs < 15_000 || config.chunkLeaseRenewMs > 30_000) {
  throw new Error('CHUNK_LEASE_RENEW_MS must be between 15000 and 30000');
}
if (config.minFreeDiskBytes < 0 || config.minFreeMemoryBytes < 0) {
  throw new Error('MIN_FREE_DISK_BYTES and MIN_FREE_MEMORY_BYTES must be >= 0');
}
if (config.fairnessPriorityStride <= 0) {
  throw new Error('FAIRNESS_PRIORITY_STRIDE must be > 0');
}
if (config.globalCdnConcurrency <= 0) {
  throw new Error('GLOBAL_CDN_CONCURRENCY must be > 0, got: ' + config.globalCdnConcurrency);
}
if (config.maxClipBytes <= 0) {
  throw new Error('MAX_CLIP_BYTES must be > 0, got: ' + config.maxClipBytes);
}
if (config.downloadStallTimeoutSeconds <= 0) {
  throw new Error('DOWNLOAD_STALL_TIMEOUT_SECONDS must be > 0, got: ' + config.downloadStallTimeoutSeconds);
}
if (config.downloadMaxSeconds <= 0) {
  throw new Error('DOWNLOAD_MAX_SECONDS must be > 0, got: ' + config.downloadMaxSeconds);
}

module.exports = config;
