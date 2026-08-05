'use strict';

/**
 * tests/integration/renderSuccess.test.js
 *
 * INTEGRATION TEST (a): Full render with mismatched-resolution inputs succeeds.
 *
 * Sends a POST /jobs request through the real HTTP layer and polls GET /jobs/:id
 * until the job reaches completed or failed. Asserts:
 * - HTTP 202 on submission
 * - Final status is 'completed'
 * - Output file exists with correct dimensions (via the local OUTPUT_DIR fallback)
 *
 * This test runs against a real Redis instance (TEST_REDIS_URL env var).
 */

const request = require('supertest');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

// Set env before any imports
process.env.WORKER_API_KEY = 'test-api-key-12345';
// Each integration file starts its OWN BullMQ workers on the SAME queue names.
// Sharing one Redis database therefore lets them steal each other's jobs — a
// 156-clip job picked up by a worker configured with MAX_CLIPS=20 fails
// validation, and an SSRF job picked up by a worker with an empty allowlist is
// never blocked. A database per file keeps the queues genuinely separate.
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/int-test-success-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/int-test-success-out';
process.env.JOB_TIMEOUT_SECONDS = '180';
process.env.MAX_CLIPS = '60';
process.env.MAX_DURATION_SECONDS = '600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.DOWNLOAD_TIMEOUT_SECONDS = '60';
process.env.JOB_ATTEMPTS = '1';
process.env.JOB_BACKOFF_DELAY_MS = '0';
process.env.WORKER_CONCURRENCY = '1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const API_KEY = 'test-api-key-12345';
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180_000;

const { assertVideoProperties, assertFileNonEmpty } = require('../helpers/ffprobeHelpers');

function clipUrl(filename) {
  const p = path.join(FIXTURES, filename);
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture missing: ${p} â€” run: bash scripts/generate_test_clips.sh`);
  }
  return `file://${p}`;
}

/**
 * Polls GET /jobs/:id until status is 'completed' or 'failed' or timeout.
 */
async function pollUntilDone(app, jobId, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/jobs/${jobId}`)
      .set('X-Api-Key', API_KEY);

    if (res.status === 200) {
      const { status } = res.body;
      if (status === 'completed' || status === 'failed') return res.body;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out polling job ${jobId} after ${timeoutMs}ms`);
}

describe('Integration: Full render with mismatched-resolution inputs', () => {
  let app, queue, workers;

  beforeAll(async () => {
    await fsp.mkdir(process.env.TEMP_DIR, { recursive: true });
    await fsp.mkdir(process.env.OUTPUT_DIR, { recursive: true });

    // Import after env is set
    const queueModule = require('../../src/queue');
    queue = queueModule.getQueue();
    workers = queueModule.startWorker();

    // Import app (server.js exports it, but we don't call listen())
    app = require('../../src/server');
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((worker) => worker.close()));
    if (queue) await queue.close();
    // Clean up output files
    try { await fsp.rm(process.env.OUTPUT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test(
    'three clips of DIFFERENT resolutions render to completed with correct output dimensions',
    async () => {
      const jobId = `int-success-${Date.now()}`;

      const postRes = await request(app)
        .post('/jobs')
        .set('X-Api-Key', API_KEY)
        .send({
          job_id: jobId,
          clips: [
            { clip_url: clipUrl('clip_720_24fps.mp4'), start: 0, end: 3 },
            { clip_url: clipUrl('clip_768_60fps.mp4'), start: 0, end: 3 },
            { clip_url: clipUrl('clip_1080_30fps.mp4'), start: 0, end: 3 },
          ],
          audio_url: clipUrl('audio_voiceover.mp3'),
          width: 1280,
          height: 720,
          fps: 30,
          aspect_ratio: '16:9',
          transition: 'hard-cut',
          transition_duration: 0.5,
          format: 'mp4',
          output_upload_url: null,
        });

      expect(postRes.status).toBe(202);
      expect(postRes.body.job_id).toBe(jobId);

      const finalStatus = await pollUntilDone(app, jobId);

      expect(finalStatus.status).toBe('completed');
      expect(finalStatus.ffmpegStderr).toBeNull(); // no error on success

      const outputPath = path.join(process.env.OUTPUT_DIR, `${jobId}.mp4`);
      await assertFileNonEmpty(outputPath);
      await assertVideoProperties(outputPath, { width: 1280, height: 720, fps: 30 });
    },
    POLL_TIMEOUT_MS + 10_000
  );
});
