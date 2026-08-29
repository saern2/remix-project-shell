/**
 * All configuration from environment variables — the render worker's rule,
 * kept: import this module, never read process.env elsewhere.
 *
 * PORT IS EXPLICIT IN THE COMPOSE environment: BLOCK, never inherited: the
 * shared .env sets PORT=3001 for the render worker, and the tts-worker
 * inherited exactly that once. This container also mounts NO shared .env at
 * all (D9): it holds no Supabase key, no render credentials, no provider
 * key of its own — Chrome runs with --no-sandbox --disable-web-security
 * inside it (Anymotion's own launch flags), which is precisely why the
 * no-secrets rule is load-bearing rather than tidiness.
 */

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return n;
}

const config = {
  port: intEnv('PORT', 3003),
  apiKey: requireEnv('MOTION_WORKER_API_KEY'),
  /**
   * Encrypts the user's provider key before it enters the Redis job payload
   * (D5): plaintext never lands in Redis, a worker restart can still run the
   * job, and this container needs no Scene Smith credential to do it. This
   * secret exists ONLY in motion-worker's own env file on the box.
   */
  keySecret: requireEnv('MOTION_WORKER_KEY_SECRET'),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  /**
   * One job at a time (D7). The 42-minute measured job averaged ~13% of one
   * core, so 2 is defensible for throughput later — but the frame-capture
   * burst concurrent with a render is unproven until Item 5's capture
   * exists, and the box was host-throttled for sustained 100% on 22 August.
   * Env var; raising it is a separate decision with its own capture.
   */
  concurrency: intEnv('MOTION_CONCURRENCY', 1),

  /**
   * The caps (D3), imposed via AbortController through Anymotion's own
   * signal/emit seams — a clean 'aborted' return, not a process kill.
   * 60 turns: Anymotion's internal ceiling is 150, and a detailed brief that
   * has not converged by 60 is looping on its audit at one LLM round-trip
   * per turn. 3600s: 1.4x the measured 42-minute worst case, which was
   * itself inflated by provider rerouting — tighter than the honest P95
   * fails legitimate jobs.
   */
  maxTurns: intEnv('MOTION_MAX_TURNS', 60),
  wallClockSeconds: intEnv('MOTION_WALL_CLOCK_S', 3600),

  /**
   * The render gate (V4): motion jobs do not START while this many chunks
   * are active on the render worker. LLEN bull:render-chunk:active is an
   * O(1) read-only look at BullMQ's own list — no render state is touched.
   * The gate only prevents starting; mid-job overlap is protected by
   * nice 19 and, harder, by the container's cpus: 1.5 cgroup cap (D4).
   */
  renderGateMaxActiveChunks: intEnv('RENDER_GATE_MAX_ACTIVE_CHUNKS', 1),
  renderGateRecheckMs: intEnv('RENDER_GATE_RECHECK_MS', 60_000),

  /**
   * Queue ceiling: at ~42 minutes per job and concurrency 1, depth 4 means
   * the last user waits ~2.8 hours — stated plainly at refusal, per Item 2.
   */
  queueMaxDepth: intEnv('MOTION_QUEUE_MAX_DEPTH', 4),

  /**
   * Exactly ONE attempt. A retry of a 40-minute agent run silently spends
   * the USER'S provider credit a second time — a failed motion job is a
   * worded failure the user resubmits deliberately, never an automatic
   * re-spend.
   */
  jobAttempts: 1,
  // The shared Redis runs maxmemory 2gb with noeviction: bounds mandatory.
  removeOnComplete: intEnv('MOTION_REMOVE_ON_COMPLETE', 50),
  removeOnFail: intEnv('MOTION_REMOVE_ON_FAIL', 200),

  /**
   * Per-job workspaces live here and die with the job (V6): Anymotion keeps
   * frame directories on every failure path by design (video-renderer.js
   * removes them only when stitched), so the per-job delete in `finally`
   * plus the hourly orphan sweep are what stand between this worker and the
   * 6.2 GB orphan class. Needs >= 10 GB headroom (README).
   */
  tmpDir: process.env.MOTION_TMP_DIR || '/tmp/motion-tmp',
  sweepIntervalMs: intEnv('MOTION_SWEEP_INTERVAL_MS', 60 * 60 * 1000),
  sweepGraceMs: intEnv('MOTION_SWEEP_GRACE_MS', 2 * 60 * 60 * 1000),

  queueName: 'motion',
  /** Measured durations, newest first — the ETA source (D10). */
  jobSecondsKey: 'motion:job-seconds',
  jobSecondsSamples: 20,
  /** The one production measurement, 2026-08-26: 42m19s. Self-corrects. */
  jobSecondsSeed: 2539,
};

if (config.concurrency < 1) throw new Error('MOTION_CONCURRENCY must be >= 1');
if (config.maxTurns < 1) throw new Error('MOTION_MAX_TURNS must be >= 1');
if (config.wallClockSeconds < 60) throw new Error('MOTION_WALL_CLOCK_S must be >= 60');
if (config.queueMaxDepth < 1) throw new Error('MOTION_QUEUE_MAX_DEPTH must be >= 1');

export default config;
