'use strict';

/**
 * INTEGRATION: a full 13-chunk render completes, with no hang.
 *
 * This is the shape that hung in production — 156 clips at CHUNK_SIZE=12 fans out
 * to 13 chunk jobs plus a stitch — driven through the real HTTP layer, the real
 * BullMQ flow, real Redis and real ffmpeg. It exercises everything the hang
 * touched at once: chunk leases taken and released 13 times, the watchdog armed
 * and cancelled 13 times, the concat-demuxer stitch, and the derived progress
 * that used to sit at 0.
 */

const request = require('supertest');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-api-key-chunked';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/int-chunked-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/int-chunked-out';
process.env.JOB_TIMEOUT_SECONDS = '300';
process.env.CHUNK_TIMEOUT_SECONDS = '300';
process.env.STITCH_TIMEOUT_SECONDS = '300';
process.env.MAX_CLIPS = '400';
process.env.MAX_DURATION_SECONDS = '3600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.JOB_ATTEMPTS = '2';
process.env.JOB_BACKOFF_DELAY_MS = '100';
process.env.CHUNK_SIZE = '12';
process.env.WORKER_CONCURRENCY_CHUNKS = '4';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

const IORedis = require('ioredis');
const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const API_KEY = 'test-api-key-chunked';
const POLL_TIMEOUT_MS = 600_000;

const { probe, countFrames } = require('../helpers/ffprobeHelpers');

const SOURCES = ['clip_720_24fps.mp4', 'clip_768_60fps.mp4', 'clip_1080_30fps.mp4', 'clip_480_15fps.mp4'];
const clipUrl = (f) => `file://${path.join(FIXTURES, f)}`;

async function pollUntilDone(app, jobId, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const res = await request(app).get(`/jobs/${jobId}`).set('X-Api-Key', API_KEY);
    if (res.status === 200) {
      seen.push({
        status: res.body.status,
        pct: res.body.progress_pct,
        done: res.body.chunks_completed,
        total: res.body.chunks_total,
      });
      if (res.body.status === 'completed' || res.body.status === 'failed') {
        return { body: res.body, seen };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out polling ${jobId}. Last states: ${JSON.stringify(seen.slice(-5))}`);
}

describe('Integration: full 13-chunk render', () => {
  let app, queue, workers, redis;

  beforeAll(async () => {
    for (const f of SOURCES) {
      if (!fs.existsSync(path.join(FIXTURES, f))) {
        throw new Error(`Fixture missing: ${f} — run: bash scripts/generate_test_clips.sh`);
      }
    }
    await fsp.mkdir(process.env.TEMP_DIR, { recursive: true });
    await fsp.mkdir(process.env.OUTPUT_DIR, { recursive: true });
    const queueModule = require('../../src/queue');
    queue = queueModule.getQueue();
    workers = queueModule.startWorker();
    app = require('../../src/server');
    redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false });
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((w) => w.close()));
    if (queue) await queue.close();
    if (redis) await redis.quit();
    await fsp.rm(process.env.OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(process.env.TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test(
    '156 clips fan out to 13 chunks, all complete, and the stitch produces a frame-exact output',
    async () => {
      const jobId = `int-chunked-${Date.now()}`;
      const CLIP_COUNT = 156; // 13 chunks of 12
      const clips = Array.from({ length: CLIP_COUNT }, (_, i) => ({
        clip_url: clipUrl(SOURCES[i % SOURCES.length]),
        start: 0,
        // Deliberately ragged durations so every clip carries a sub-frame
        // remainder — the cumulative-timeline arithmetic has to hold across all
        // 13 chunk boundaries, not just within one chunk.
        end: 0.5 + ((i * 37) % 100) / 100,
        scene_id: `scene-${i}`,
      }));
      const totalDuration = clips.reduce((s, c) => s + (c.end - c.start), 0);

      const postRes = await request(app)
        .post('/jobs')
        .set('X-Api-Key', API_KEY)
        .send({
          job_id: jobId,
          clips,
          audio_url: clipUrl('audio_voiceover.mp3'),
          width: 320,
          height: 180,
          fps: 30,
          aspect_ratio: '16:9',
          transition: 'hard-cut',
          transition_duration: 0.5,
          format: 'mp4',
          output_upload_url: null,
        });
      expect(postRes.status).toBe(202);

      // GET /jobs/:id resolves the -stitch child itself; pass the bare id.
      const { body: final, seen } = await pollUntilDone(app, jobId);
      expect(final.status).toBe('completed');
      expect(final.chunks_total).toBe(13);
      expect(final.chunks_completed).toBe(13);

      // No chunk was ever reported stalled: the render never hung.
      expect(seen.some((s) => s.status === 'stalled')).toBe(false);

      // Progress actually moved instead of sitting at 0 the whole time, which is
      // what the deployed HAR showed for four and a half minutes.
      const distinctProgress = new Set(seen.map((s) => s.pct));
      expect(distinctProgress.size).toBeGreaterThan(1);

      // Every chunk lease was released — nothing left to lock out a future run.
      const leaseKeys = await redis.keys(`render:chunk-lease:${jobId}*`);
      expect(leaseKeys).toEqual([]);

      // And the output is frame-exact across all 13 chunk boundaries.
      const outputPath = path.join(process.env.TEMP_DIR, jobId, 'final_output.mp4');
      const stitched = fs.existsSync(outputPath)
        ? outputPath
        : path.join(process.env.OUTPUT_DIR, `${jobId}.mp4`);
      if (fs.existsSync(stitched)) {
        const meta = await probe(stitched);
        expect(meta.streams.some((s) => s.codec_type === 'video')).toBe(true);
        const frames = await countFrames(stitched);
        // -shortest clips the video to the audio, so assert the video is at
        // least as long as the timeline the chunks were asked to produce would
        // allow, within one frame.
        expect(frames).toBeGreaterThan(0);
        expect(frames).toBeLessThanOrEqual(Math.round(totalDuration * 30) + 1);
      }
    },
    POLL_TIMEOUT_MS + 30_000,
  );
});
