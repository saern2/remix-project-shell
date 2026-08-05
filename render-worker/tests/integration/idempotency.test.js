'use strict';

/**
 * tests/integration/idempotency.test.js
 *
 * INTEGRATION TEST (c): Two identical job_ids submitted concurrently
 * produce exactly ONE render, not two.
 *
 * Mechanism: BullMQ's { jobId } option makes queue.add() idempotent.
 * A second add() with the same jobId returns the existing job without
 * creating a new entry. The worker processes it exactly once.
 *
 * This test:
 * 1. Sends two POST /jobs with the same job_id concurrently (Promise.all)
 * 2. Both should get a 2xx response (200 or 202)
 * 3. Waits for the job to complete
 * 4. Verifies the output file exists exactly once (not duplicated)
 * 5. Verifies the BullMQ job was only processed once (attemptsMade check)
 */

const request = require('supertest');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-api-key-12345';
// Each integration file starts its OWN BullMQ workers on the SAME queue names.
// Sharing one Redis database therefore lets them steal each other's jobs — a
// 156-clip job picked up by a worker configured with MAX_CLIPS=20 fails
// validation, and an SSRF job picked up by a worker with an empty allowlist is
// never blocked. A database per file keeps the queues genuinely separate.
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/3';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/int-test-idempotency-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/int-test-idempotency-out';
process.env.JOB_TIMEOUT_SECONDS = '180';
process.env.MAX_CLIPS = '20';
process.env.MAX_DURATION_SECONDS = '600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.DOWNLOAD_TIMEOUT_SECONDS = '60';
process.env.JOB_ATTEMPTS = '1';
process.env.JOB_BACKOFF_DELAY_MS = '0';
process.env.WORKER_CONCURRENCY = '2'; // concurrency=2 so both jobs *could* run in parallel
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const API_KEY = 'test-api-key-12345';
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

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

describe('Integration: Idempotency â€” duplicate job_id â†’ single render', () => {
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
    try { await fsp.rm(process.env.OUTPUT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test(
    'two concurrent POSTs with the same job_id produce exactly one render',
    async () => {
      // Use a fixed job_id â€” both requests carry the same one
      const sharedJobId = `idempotency-test-${Date.now()}`;

      const payload = {
        job_id: sharedJobId,
        clips: [
          { clip_url: clipUrl('clip_720_24fps.mp4'), start: 0, end: 3 },
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
      };

      // Fire both requests simultaneously
      const [res1, res2] = await Promise.all([
        request(app).post('/jobs').set('X-Api-Key', API_KEY).send(payload),
        request(app).post('/jobs').set('X-Api-Key', API_KEY).send(payload),
      ]);

      // Both must succeed (not 409 or 500)
      expect([200, 202]).toContain(res1.status);
      expect([200, 202]).toContain(res2.status);

      // Both must return the same job_id
      expect(res1.body.job_id).toBe(sharedJobId);
      expect(res2.body.job_id).toBe(sharedJobId);

      // Wait for the job to complete
      const finalStatus = await pollUntilDone(app, sharedJobId);
      expect(finalStatus.status).toBe('completed');

      // Verify exactly one output file exists (not duplicated)
      const outputDir = process.env.OUTPUT_DIR;
      const files = await fsp.readdir(outputDir);
      const matchingFiles = files.filter((f) => f.startsWith(sharedJobId));
      expect(matchingFiles).toHaveLength(1);

      // Verify job was only attempted once (not twice)
      expect(finalStatus.attempts_made).toBe(1);
    },
    POLL_TIMEOUT_MS + 10_000
  );
});
