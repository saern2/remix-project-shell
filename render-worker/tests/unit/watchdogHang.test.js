'use strict';

/**
 * The watchdog, tested against a genuinely hung child process.
 *
 * This is the case the deployed incident hit and that BullMQ structurally
 * cannot catch: the ffmpeg child never exits, so the worker stays healthy, the
 * job lock keeps renewing, and the chunk hangs forever with status "rendering"
 * and no error. CHUNK_TIMEOUT_SECONDS never applied to it.
 *
 * A stub ffmpeg on FFMPEG_PATH sleeps instead of encoding. It consults a
 * sentinel file on each invocation, so the same test process can hang one
 * attempt and then let the retry run the real encoder — which is what proves
 * the recovery path end to end.
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SHIM_DIR = path.join(os.tmpdir(), `ffmpeg-shim-${process.pid}`);
const HANG_SENTINEL = path.join(SHIM_DIR, 'HANG');
const SHIM = path.join(SHIM_DIR, 'ffmpeg-shim');
const REAL_FFMPEG = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();

fs.mkdirSync(SHIM_DIR, { recursive: true });
fs.writeFileSync(
  SHIM,
  `#!/bin/sh
# Hung-child stub. Hangs ONLY the real encode — the invocation carrying
# -filter_complex_script — and passes fluent-ffmpeg's capability probes
# (-formats, -codecs, -filters) straight through to the real binary.
#
# That distinction is the whole point: a stub that also hangs the probe would
# exercise a state production never reaches (ffmpegProc still null), and would
# let a broken kill path pass. Hanging the encode reproduces the deployed shape.
if [ -f "${HANG_SENTINEL}" ]; then
  for a in "$@"; do
    if [ "$a" = "-filter_complex_script" ]; then
      exec sleep 3600
    fi
  done
fi
exec "${REAL_FFMPEG}" "$@"
`,
  { mode: 0o755 },
);

process.env.WORKER_API_KEY = 'test-key';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/watchdog-hang-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/watchdog-hang-out';
process.env.JOB_TIMEOUT_SECONDS = '120';
process.env.MAX_DURATION_SECONDS = '600';
process.env.JOB_ATTEMPTS = '3';
process.env.JOB_BACKOFF_DELAY_MS = '1';
process.env.CHUNK_TIMEOUT_SECONDS = '4'; // keeps the watchdog budget short
process.env.FFMPEG_PATH = SHIM;

const IORedis = require('ioredis');
const { processRenderJob, chunkDeadlineMs } = require('../../src/renderJob');

const FIXTURE = path.resolve(__dirname, '../fixtures/clips/clip_720_24fps.mp4');
const leaseKey = (jobId) => `render:chunk-lease:${jobId}`;

function makeMockJob(jobId, payload, attemptsMade = 0) {
  const data = { ...payload };
  return {
    id: jobId,
    data,
    progress: 0,
    attemptsMade,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    updateData: async (d) => { Object.assign(data, d); },
    updateProgress: async (p) => { data._progress = p; },
    getState: async () => 'active',
    failedReason: null,
  };
}

const payloadFor = () => ({
  clips: [{ clip_url: `file://${FIXTURE}`, start: 0, end: 1, scene_id: 'scene-a' }],
  audio_url: null,
  width: 320,
  height: 180,
  fps: 30,
  transition: 'hard-cut',
  transition_duration: 0.5,
  format: 'mp4',
  is_chunk: true,
  chunk_index: 10,
  chunks_total: 13,
});

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

afterAll(async () => {
  if (redis) await redis.quit();
  await fsp.rm(SHIM_DIR, { recursive: true, force: true });
});

function countSleepingShims() {
  try {
    const out = execFileSync('sh', ['-c', 'ps -eo args 2>/dev/null | grep -c "[s]leep 3600"'], {
      encoding: 'utf8',
    });
    return Number(out.trim()) || 0;
  } catch {
    return 0; // grep exits 1 when there are no matches
  }
}

describe('watchdog against a hung ffmpeg child', () => {
  test('fires, kills the child, releases the lease, and fails so BullMQ retries', async () => {
    fs.writeFileSync(HANG_SENTINEL, '1');
    const jobId = `hang-${Date.now()}`;
    try {
      const job = makeMockJob(jobId, payloadFor());
      const startedAt = Date.now();

      await expect(processRenderJob(job)).rejects.toThrow(/CHUNK_WATCHDOG/);
      const elapsed = Date.now() - startedAt;

      // Failed on the watchdog's schedule — not immediately, and not never.
      // The budget is buildChunkOpts' formula, max(chunkTimeout, ceil(D*1.5)+60),
      // so it is derived here rather than hard-coded.
      const budgetMs = chunkDeadlineMs(payloadFor().clips);
      expect(elapsed).toBeGreaterThanOrEqual(budgetMs * 0.9);
      expect(elapsed).toBeLessThan(budgetMs + 30000);

      // The failure names the phase it died in. Without this a hang is
      // undiagnosable, which is what the deployed logs demonstrated.
      expect(job.data._error).toMatch(/CHUNK_WATCHDOG/);
      expect(job.data._error).toMatch(/encoding/);
      // Not misclassified as a user cancellation — cancellations are not
      // retried, which would leave the hang unfixed under a different name.
      expect(job.data._status).toBe('failed');
      expect(job.data._error).not.toMatch(/CANCELLED/);

      // The lease is gone, so the retry is not locked out.
      expect(await redis.get(leaseKey(jobId))).toBeNull();

      // The hung child was reaped rather than left running.
      await new Promise((r) => setTimeout(r, 1000));
      expect(countSleepingShims()).toBe(0);
    } finally {
      fs.rmSync(HANG_SENTINEL, { force: true });
      await fsp.rm(path.join(process.env.TEMP_DIR, jobId), { recursive: true, force: true });
    }
  }, 180000);

  test('the retry then completes normally', async () => {
    const jobId = `hang-retry-${Date.now()}`;
    try {
      // Attempt 1 hangs and is killed.
      fs.writeFileSync(HANG_SENTINEL, '1');
      const hung = makeMockJob(jobId, payloadFor(), 0);
      await expect(processRenderJob(hung)).rejects.toThrow(/CHUNK_WATCHDOG/);
      expect(await redis.get(leaseKey(jobId))).toBeNull();

      // Attempt 2 runs the real encoder. Before the lease fix this is precisely
      // where CHUNK_LOCK_TIMEOUT appeared, because the dead attempt's renewal
      // interval still owned the key — the 12/13 hang.
      fs.rmSync(HANG_SENTINEL, { force: true });
      const retry = makeMockJob(jobId, payloadFor(), 1);
      await expect(processRenderJob(retry)).resolves.toBeDefined();

      expect(retry.data._status).toBe('completed');
      expect(fs.existsSync(path.join(process.env.TEMP_DIR, jobId, 'output.mp4'))).toBe(true);
      expect(await redis.get(leaseKey(jobId))).toBeNull();
    } finally {
      fs.rmSync(HANG_SENTINEL, { force: true });
      await fsp.rm(path.join(process.env.TEMP_DIR, jobId), { recursive: true, force: true });
    }
  }, 180000);

  test('publishes a stall notice the client can surface', async () => {
    fs.writeFileSync(HANG_SENTINEL, '1');
    const jobId = `hang-health-${Date.now()}`;
    const parentId = jobId; // no -chunk- suffix here, so parent == job id
    try {
      const job = makeMockJob(jobId, payloadFor());
      await expect(processRenderJob(job)).rejects.toThrow(/CHUNK_WATCHDOG/);

      const raw = await redis.get(`render:job-health:${parentId}`);
      expect(raw).not.toBeNull();
      const health = JSON.parse(raw);
      // The user-facing facts: which segment, how far along, and that it will
      // be retried rather than silently abandoned.
      expect(health.reason).toBe('watchdog');
      expect(health.state).toBe('retrying');
      expect(health.chunkIndex).toBe(10);
      expect(health.chunksTotal).toBe(13);
      expect(health.phase).toBe('encoding');
      await redis.del(`render:job-health:${parentId}`);
    } finally {
      fs.rmSync(HANG_SENTINEL, { force: true });
      await fsp.rm(path.join(process.env.TEMP_DIR, jobId), { recursive: true, force: true });
    }
  }, 180000);
});
