'use strict';

/**
 * tests/integration/badUrl.test.js
 *
 * INTEGRATION TEST (b): A render with an unreachable clip URL fails cleanly
 * with a descriptive error â€” not a hang, not a generic "exit code 1".
 *
 * This covers the v1 debugging pain: "FFmpeg exited with code X" was useless.
 * Here we assert:
 * - The job reaches 'failed' status (does not stay stuck in 'downloading')
 * - The error message is specific and contains the URL or reason
 * - ffmpegStderr or error field is populated (not null, not empty)
 * - The job completes within the download timeout, not the full render timeout
 *
 * Two failure scenarios are tested:
 * 1. Unreachable host (connection refused)
 * 2. SSRF-blocked host (returns immediately with a clear message)
 */

const request = require('supertest');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-api-key-12345';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
process.env.URL_ALLOWLIST = 'videos.pexels.com'; // restrictive allowlist for SSRF test
process.env.TEMP_DIR = os.tmpdir() + '/int-test-badurl-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/int-test-badurl-out';
process.env.JOB_TIMEOUT_SECONDS = '60'; // shorter timeout â€” bad URL should fail fast
process.env.MAX_CLIPS = '20';
process.env.MAX_DURATION_SECONDS = '600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.DOWNLOAD_TIMEOUT_SECONDS = '10'; // 10s download timeout so the test runs fast
process.env.JOB_ATTEMPTS = '1'; // no retries â€” fail immediately
process.env.JOB_BACKOFF_DELAY_MS = '0';
process.env.WORKER_CONCURRENCY = '1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const API_KEY = 'test-api-key-12345';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

function clipUrl(filename) {
  const p = path.join(FIXTURES, filename);
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture missing: ${p} â€” run: bash scripts/generate_test_clips.sh`);
  }
  return `file://${p}`;
}

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
  throw new Error(`Timed out polling job ${jobId}`);
}

describe('Integration: Bad URL fails cleanly, not with a hang', () => {
  let app, queue, workers;

  beforeAll(async () => {
    await fsp.mkdir(process.env.TEMP_DIR, { recursive: true });
    await fsp.mkdir(process.env.OUTPUT_DIR, { recursive: true });

    const queueModule = require('../../src/queue');
    queue = queueModule.getQueue();
    workers = queueModule.startWorker();
    app = require('../../src/server');
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((worker) => worker.close()));
    if (queue) await queue.close();
  });

  test(
    'unreachable clip URL â†’ job fails with descriptive error, no hang',
    async () => {
      const jobId = `badurl-unreachable-${Date.now()}`;
      const startTime = Date.now();

      // localhost:19999 â€” nothing listening there
      const badClipUrl = 'http://localhost:19999/nonexistent-clip.mp4';

      const postRes = await request(app)
        .post('/jobs')
        .set('X-Api-Key', API_KEY)
        .send({
          job_id: jobId,
          clips: [
            { clip_url: badClipUrl, start: 0, end: 5 },
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

      // Even for a bad URL, enqueue should succeed
      expect([200, 202]).toContain(postRes.status);

      const finalStatus = await pollUntilDone(app, jobId, POLL_TIMEOUT_MS);
      const elapsed = Date.now() - startTime;

      // Must fail, not hang or complete
      expect(finalStatus.status).toBe('failed');

      // Error must be descriptive â€” not a generic "exit code" message
      const errorText = finalStatus.error ?? '';
      expect(errorText.length).toBeGreaterThan(10);
      expect(errorText).not.toMatch(/^FFmpeg exited with code \d+$/);

      // Must not hang for the full job timeout (60s) â€” should fail in < 20s
      expect(elapsed).toBeLessThan(20_000);
    },
    POLL_TIMEOUT_MS + 5000
  );

  test(
    'SSRF-blocked clip URL â†’ job fails immediately with SSRF_BLOCK error',
    async () => {
      const jobId = `badurl-ssrf-${Date.now()}`;

      const postRes = await request(app)
        .post('/jobs')
        .set('X-Api-Key', API_KEY)
        .send({
          job_id: jobId,
          clips: [
            // This host is not on the URL_ALLOWLIST (videos.pexels.com only)
            { clip_url: 'http://169.254.169.254/latest/meta-data/', start: 0, end: 5 },
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

      expect([200, 202]).toContain(postRes.status);

      const finalStatus = await pollUntilDone(app, jobId, POLL_TIMEOUT_MS);

      expect(finalStatus.status).toBe('failed');
      expect(finalStatus.error).toMatch(/SSRF_BLOCK/);
    },
    POLL_TIMEOUT_MS + 5000
  );
});
