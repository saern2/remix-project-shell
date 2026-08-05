'use strict';

/**
 * A hang must always become a failure, and a failure must always retry.
 *
 * The deployed incident: a render sat at 12/13 chunks for minutes with status
 * "rendering", progress 0, and no error. Two independent defects produced it.
 *
 *  1. No per-chunk deadline. CHUNK_TIMEOUT_SECONDS was only ever enforced by
 *     BullMQ's lock/stalled machinery, which fires when the WORKER dies. A chunk
 *     that hangs inside a live process renews its lock forever.
 *
 *  2. The chunk lease was never released. Its renewal interval kept the Redis
 *     key alive for the life of the process, so every retry of that chunk
 *     waited out its full deadline and died with CHUNK_LOCK_TIMEOUT.
 *
 * These tests pin both, plus the bounded ffprobe that prevents a third route to
 * the same symptom.
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-key';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/watchdog-test-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/watchdog-test-out';
process.env.JOB_TIMEOUT_SECONDS = '120';
process.env.MAX_DURATION_SECONDS = '600';
process.env.JOB_ATTEMPTS = '3';
process.env.JOB_BACKOFF_DELAY_MS = '1';
// A 3s watchdog budget keeps these tests fast. chunkDeadlineMs takes the max of
// this and the clip-duration-derived budget, so clips stay short below.
process.env.CHUNK_TIMEOUT_SECONDS = '3';

const IORedis = require('ioredis');
const { processRenderJob } = require('../../src/renderJob');
const { acquireChunkLease, markChunkReady } = require('../../src/resourceControl');
const { probeMedia, probeDurationSeconds } = require('../../src/mediaProbe');

const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const FIXTURE = path.join(FIXTURES, 'clip_720_24fps.mp4');
const fileUrl = (p) => `file://${p}`;

function makeMockJob(jobId, payload, { attemptsMade = 0, attempts = 3 } = {}) {
  const data = { ...payload };
  return {
    id: jobId,
    data,
    progress: 0,
    attemptsMade,
    opts: { attempts },
    timestamp: Date.now(),
    updateData: async (d) => { Object.assign(data, d); },
    updateProgress: async (p) => { data._progress = p; },
    getState: async () => 'active',
    failedReason: null,
  };
}

function chunkPayload(clips, extra = {}) {
  return {
    clips,
    audio_url: null,
    width: 320,
    height: 180,
    fps: 30,
    transition: 'hard-cut',
    transition_duration: 0.5,
    format: 'mp4',
    is_chunk: true,
    chunk_index: 3,
    chunks_total: 13,
    ...extra,
  };
}

let redis;
beforeAll(() => {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(`Test fixture not found: ${FIXTURE}\nRun: bash scripts/generate_test_clips.sh`);
  }
  redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });
});
afterAll(async () => { if (redis) await redis.quit(); });

const leaseKey = (jobId) => `render:chunk-lease:${jobId}`;

describe('chunk lease is released on every exit path', () => {
  const cleanup = async (jobId) =>
    fsp.rm(path.join(process.env.TEMP_DIR, jobId), { recursive: true, force: true });

  test('success', async () => {
    const jobId = `lease-success-${Date.now()}`;
    const job = makeMockJob(jobId, chunkPayload([{ clip_url: fileUrl(FIXTURE), start: 0, end: 1 }]));
    await expect(processRenderJob(job)).resolves.toBeDefined();
    expect(await redis.get(leaseKey(jobId))).toBeNull();
    await cleanup(jobId);
  }, 120000);

  test('ordinary failure with a retry pending (the keep-files-for-retry path)', async () => {
    const jobId = `lease-fail-retry-${Date.now()}`;
    const job = makeMockJob(
      jobId,
      chunkPayload([{ clip_url: 'file:///nonexistent/definitely-missing.mp4', start: 0, end: 1 }]),
      { attemptsMade: 0, attempts: 3 },
    );
    await expect(processRenderJob(job)).rejects.toThrow();
    // This is the exact path the deployed hang took: a chunk that failed with
    // attempts remaining. It kept its files — and used to keep its lease too.
    expect(await redis.get(leaseKey(jobId))).toBeNull();
    await cleanup(jobId);
  }, 120000);

  test('terminal failure on the final attempt', async () => {
    const jobId = `lease-fail-final-${Date.now()}`;
    const job = makeMockJob(
      jobId,
      chunkPayload([{ clip_url: 'file:///nonexistent/definitely-missing.mp4', start: 0, end: 1 }]),
      { attemptsMade: 2, attempts: 3 },
    );
    await expect(processRenderJob(job)).rejects.toThrow();
    expect(await redis.get(leaseKey(jobId))).toBeNull();
    await cleanup(jobId);
  }, 120000);

  test('reused output short-circuit (lease never taken, nothing left behind)', async () => {
    const jobId = `lease-reused-${Date.now()}`;
    const tempDir = path.join(process.env.TEMP_DIR, jobId);
    await fsp.mkdir(tempDir, { recursive: true });
    // Pre-stage a finished chunk output plus its ready marker.
    await fsp.copyFile(FIXTURE, path.join(tempDir, 'output.mp4'));
    await markChunkReady(path.join(tempDir, 'output.mp4'));

    const job = makeMockJob(jobId, chunkPayload([{ clip_url: fileUrl(FIXTURE), start: 0, end: 1 }]));
    const result = await processRenderJob(job);
    expect(result).toEqual({ status: 'completed', reused: true });
    expect(await redis.get(leaseKey(jobId))).toBeNull();
    await cleanup(jobId);
  }, 120000);

  test('release is idempotent and stops the renewal interval', async () => {
    const jobId = `lease-idempotent-${Date.now()}`;
    const outputPath = path.join(os.tmpdir(), `${jobId}.mp4`);
    const lease = await acquireChunkLease({
      redis,
      jobId,
      outputPath,
      timeoutMs: 3000,
      maxLeaseMs: 3000,
    });
    expect(lease.reused).toBe(false);
    expect(await redis.get(leaseKey(jobId))).not.toBeNull();

    await lease.release();
    expect(await redis.get(leaseKey(jobId))).toBeNull();
    // Calling it twice must not throw, and must not delete somebody else's lease.
    await expect(lease.release()).resolves.toBeUndefined();

    // The renewal interval is dead: a lease taken by a "different holder" now
    // survives, which it could not if the old interval were still running.
    await redis.set(leaseKey(jobId), 'someone-else', 'PX', 5000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await redis.get(leaseKey(jobId))).toBe('someone-else');
    await redis.del(leaseKey(jobId));
  }, 60000);
});

describe('ffprobe is bounded', () => {
  test('a probe that cannot complete times out instead of hanging', async () => {
    const dir = path.join(os.tmpdir(), `probe-hang-${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    const fifo = path.join(dir, 'blocking.mp4');
    require('child_process').execFileSync('mkfifo', [fifo]);
    const holder = fs.openSync(fifo, fs.constants.O_RDWR);
    try {
      const startedAt = Date.now();
      // Unbounded, this never returns: ffprobe blocks reading a FIFO forever.
      const result = await probeMedia(fifo, { timeoutMs: 1500 });
      const elapsed = Date.now() - startedAt;
      expect(result).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(15000);
    } finally {
      fs.closeSync(holder);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('a zero-byte file resolves to unknown rather than blocking', async () => {
    const empty = path.join(os.tmpdir(), `empty-${Date.now()}.mp4`);
    await fsp.writeFile(empty, '');
    try {
      expect(await probeDurationSeconds(empty, { timeoutMs: 5000 })).toBeNull();
    } finally {
      await fsp.rm(empty, { force: true });
    }
  }, 60000);

  test('a healthy file still probes correctly', async () => {
    const duration = await probeDurationSeconds(FIXTURE);
    expect(duration).toBeGreaterThan(2);
    expect(duration).toBeLessThan(5);
  }, 60000);
});
