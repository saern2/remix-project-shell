'use strict';

/**
 * config.js — All configuration derived from environment variables.
 * Import this module; never read process.env directly in other modules.
 */

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

const config = {
  // Server
  port: intEnv('PORT', 3001),
  nodeEnv: strEnv('NODE_ENV', 'development'),
  logLevel: strEnv('LOG_LEVEL', 'info'),

  // Authentication
  workerApiKey: requireEnv('WORKER_API_KEY'),

  // Redis / BullMQ
  redisUrl: strEnv('REDIS_URL', 'redis://localhost:6379'),
  workerConcurrency: intEnv('WORKER_CONCURRENCY', 2),
  jobAttempts: intEnv('JOB_ATTEMPTS', 3),
  jobBackoffDelayMs: intEnv('JOB_BACKOFF_DELAY_MS', 5000),
  bullStalledIntervalMs: intEnv('BULL_STALLED_INTERVAL_MS', 30_000),

  // Resource limits
  jobTimeoutSeconds: intEnv('JOB_TIMEOUT_SECONDS', 600),
  chunkTimeoutSeconds: intEnv('CHUNK_TIMEOUT_SECONDS', 300),
  stitchTimeoutSeconds: intEnv('STITCH_TIMEOUT_SECONDS', 600),
  chunkSize: intEnv('CHUNK_SIZE', 25),
  workerConcurrencyChunks: intEnv('WORKER_CONCURRENCY_CHUNKS', 4),
  workerConcurrencyStitches: intEnv('WORKER_CONCURRENCY_STITCHES', 2),
  maxClips: intEnv('MAX_CLIPS', 5000),
  maxDurationSeconds: intEnv('MAX_DURATION_SECONDS', 14400),
  maxDownloadBytes: intEnv('MAX_DOWNLOAD_BYTES', 2 * 1024 * 1024 * 1024), // 2 GB
  maxStitchDownloadBytes: intEnv('MAX_STITCH_DOWNLOAD_BYTES', 10 * 1024 * 1024 * 1024), // 10 GB
  globalCdnConcurrency: intEnv('GLOBAL_CDN_CONCURRENCY', 15),

  // I/O
  downloadTimeoutSeconds: intEnv('DOWNLOAD_TIMEOUT_SECONDS', 60),
  tempDir: strEnv('TEMP_DIR', '/tmp/render-tmp'),
  outputDir: strEnv('OUTPUT_DIR', '/tmp/renders'),

  // SSRF allowlist — comma-separated hostnames
  urlAllowlist: strEnv('URL_ALLOWLIST', '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

module.exports = config;
