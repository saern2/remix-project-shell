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
  /**
   * Projects allowed to RENDER at once. Beyond this they queue, and are told
   * where they are. Three keeps the four chunk slots busy while leaving the two
   * stitch slots enough headroom that a finishing project is not stuck behind
   * two other stitches — the 15m10s wait observed on 2026-08-07.
   */
  renderAdmissionLimit: intEnv('RENDER_ADMISSION_LIMIT', 3),
  /**
   * Slots any ONE user may hold at once. Total concurrency is unchanged; this
   * only decides whose work fills the slots.
   *
   * Admission counts projects, which is right for capacity and wrong for
   * fairness: first-come-first-served means one account submitting five
   * projects fills every slot and blocks everyone else until they finish. Two
   * keeps a heavy user moving while always leaving a slot for someone else.
   * 0 disables the cap, which is the right setting for a single-operator box.
   */
  renderAdmissionPerUserLimit: intEnv('RENDER_ADMISSION_PER_USER_LIMIT', 2),
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
  //
  // 15, BY MEASUREMENT — and 4 was a considered value this supersedes, not a
  // forgotten one. Round 6 (Issue 2) lowered 15 → 4 because a saturated pipe
  // split 15 ways made large clips time out deterministically. That change
  // landed in this file and .env.example but NEVER reached the production box:
  // its .env carried an explicit GLOBAL_CDN_CONCURRENCY=15 throughout
  // (confirmed 2026-08-15 via printenv on the box). Production has therefore
  // run at 15 the entire time — which means the WHOLE measured record belongs
  // to 15: kill rate 0.10% (2026-08-12→14), waitMs median 0, 9-10 MB/s per
  // stream, downloadSharePct 2-5%. Four has never been field-tested here.
  //
  // Round 6's failure mode is now covered by guards that attack it directly:
  // DOWNLOAD_MAX_SECONDS=120 per transfer, the 30s no-bytes stall guard,
  // CHUNK_TIMEOUT_SECONDS=300 and MAX_CLIP_BYTES=150MB.
  //
  // CORRECTED PREMISE for anyone re-reading the chunk-timeout investigation
  // (2026-08-12→14): that analysis was reasoned as if concurrency were 4. It
  // was 15. The conclusions survive — waitMs median 0 means download permits
  // were not the constraint even at 15 — but do not re-derive the old premise.
  globalCdnConcurrency: intEnv('GLOBAL_CDN_CONCURRENCY', 15),
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
  /**
   * Niceness for ffmpeg children (0-19; ignored on Windows). Default 10: the
   * encodes should soak up idle cpu but always yield to the node process.
   *
   * WHY. The 502s during the five-project run were not a blocked event loop —
   * the server handlers are all async I/O and the JSON body is capped at 1 MB.
   * They line up with OS-level saturation: at full tilt this box runs 4 encodes
   * x 2 threads plus stitches at the SAME priority as node, so node's accept
   * queue and timers get scheduled late and the reverse proxy gives up. Nicing
   * the encodes costs them nothing when the machine has headroom and keeps the
   * API responsive when it does not.
   */
  ffmpegNiceness: intEnv('FFMPEG_NICENESS', 10),
  minFreeDiskBytes: intEnv('MIN_FREE_DISK_BYTES', 2 * 1024 * 1024 * 1024),
  minFreeMemoryBytes: intEnv('MIN_FREE_MEMORY_BYTES', 256 * 1024 * 1024),
  /**
   * Free memory a chunk needs before it may START. Below this it is deferred,
   * not failed — waiting for headroom is not an error, and burning a retry
   * attempt on a transient spike is how a busy machine turns pressure into
   * permanent failures.
   *
   * Much higher than minFreeMemoryBytes (256 MB) because they answer different
   * questions: that one is the floor below which a render cannot work at all,
   * this one is the headroom a new chunk should leave for the stitches and
   * uploads already in flight. 2 GB is roughly one concurrent stitch's working
   * set plus margin, and it stays meaningful at the raised 24 GB container limit
   * — the spike scales with work in flight, not with the limit.
   */
  admissionMinFreeMemoryBytes: intEnv('ADMISSION_MIN_FREE_MEMORY_BYTES', 2 * 1024 * 1024 * 1024),
  chunkLeaseRenewMs: intEnv('CHUNK_LEASE_RENEW_MS', 20_000),
  fairnessPriorityStride: intEnv('FAIRNESS_PRIORITY_STRIDE', 1000),

  /**
   * Watchdog circuit breaker (Round A, after the 22 August outage): this many
   * watchdog kills inside the window opens the breaker for the open duration.
   *
   * 8 kills / 900s, derived rather than guessed: with 4 chunk slots and >=300s
   * per kill the physical ceiling is 12 kills per 900s window, baseline is
   * ~0.04 expected kills per window (kill rate 0.10%), one deterministic
   * bad-content chunk maxes ~3 per window and two concurrent bad chunks ~6 —
   * so 8 means three-plus chunks dying at once, which is systemic overload and
   * nothing else. See watchdogBreaker.js for the full derivation and the
   * outage numbers.
   */
  watchdogBreakerKills: intEnv('WATCHDOG_BREAKER_KILLS', 8),
  watchdogBreakerWindowSeconds: intEnv('WATCHDOG_BREAKER_WINDOW_S', 900),
  /**
   * How long the breaker stays open: a plain expiring Redis key, after which
   * normal retry resumes (it reopens if kills immediately re-breach). Two
   * watchdog budgets' worth — long enough for in-flight contention to drain,
   * short enough that a transient storm does not blank the platform for long.
   */
  watchdogBreakerOpenSeconds: intEnv('WATCHDOG_BREAKER_OPEN_S', 600),

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
if (config.ffmpegNiceness < 0 || config.ffmpegNiceness > 19) {
  // Negative niceness would put encodes ABOVE node, which is the inversion of
  // the point; > 19 is not a valid niceness.
  throw new Error('FFMPEG_NICENESS must be between 0 and 19, got: ' + config.ffmpegNiceness);
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
if (config.watchdogBreakerKills <= 0) {
  throw new Error('WATCHDOG_BREAKER_KILLS must be > 0, got: ' + config.watchdogBreakerKills);
}
if (config.watchdogBreakerWindowSeconds <= 0) {
  throw new Error('WATCHDOG_BREAKER_WINDOW_S must be > 0, got: ' + config.watchdogBreakerWindowSeconds);
}
if (config.watchdogBreakerOpenSeconds <= 0) {
  throw new Error('WATCHDOG_BREAKER_OPEN_S must be > 0, got: ' + config.watchdogBreakerOpenSeconds);
}

module.exports = config;
