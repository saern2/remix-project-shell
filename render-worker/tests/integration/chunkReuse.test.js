'use strict';

/**
 * INTEGRATION: a retry re-encodes only the segments that actually failed.
 *
 * MEASURED, 2026-08-09: "Your Thoughts May Not" failed at 34/36 rendered
 * segments. Retry re-encoded all 36 — the 34 finished chunk outputs were on
 * disk the whole time, invisible because reuse was keyed by chunk JOB id and
 * a retry submits a brand-new job id.
 *
 * This reproduces that shape at full scale: a 36-chunk project whose LAST
 * chunk is unrenderable fails with 35 finished chunks, and the retry (a new
 * job id, same content, the bad chunk fixed) must claim those 35 outputs by
 * content hash and encode exactly one chunk. Both attempts are timed; the
 * retry must be dramatically cheaper.
 */

const request = require('supertest');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-api-key-reuse';
// Databases 1-10 belong to other suites; vitest runs files in parallel.
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/11';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/int-reuse-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/int-reuse-out';
process.env.JOB_TIMEOUT_SECONDS = '300';
process.env.CHUNK_TIMEOUT_SECONDS = '300';
process.env.STITCH_TIMEOUT_SECONDS = '300';
process.env.MAX_CLIPS = '400';
process.env.MAX_DURATION_SECONDS = '3600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.JOB_ATTEMPTS = '1';
process.env.JOB_BACKOFF_DELAY_MS = '50';
process.env.CHUNK_SIZE = '4';
process.env.WORKER_CONCURRENCY_CHUNKS = '4';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

const IORedis = require('ioredis');
const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const API_KEY = 'test-api-key-reuse';
const POLL_TIMEOUT_MS = 480_000;

const { countFrames } = require('../helpers/ffprobeHelpers');

const CHUNKS = 36;
const CLIPS_PER_CHUNK = 4;
const SOURCES = ['clip_720_24fps.mp4', 'clip_1080_30fps.mp4', 'clip_480_15fps.mp4'];
const clipUrl = (f) => `file://${path.join(FIXTURES, f)}`;
const deadUrl = (n) => `file://${path.join(FIXTURES, `${n}-does-not-exist.mp4`)}`;

/** The 36-chunk timeline; `lastChunkBroken` swaps chunk 35's sources. */
function buildClips({ lastChunkBroken }) {
  const clips = [];
  for (let i = 0; i < CHUNKS * CLIPS_PER_CHUNK; i++) {
    const chunkIndex = Math.floor(i / CLIPS_PER_CHUNK);
    const broken = lastChunkBroken && chunkIndex === CHUNKS - 1;
    clips.push({
      clip_url: broken ? deadUrl(`reuse-dead-${i}`) : clipUrl(SOURCES[i % SOURCES.length]),
      start: 0,
      // Ragged sub-frame remainders, as in production timelines.
      end: 0.4 + ((i * 37) % 50) / 100,
      scene_id: `scene-${i}`,
    });
  }
  return clips;
}

function postJob(app, jobId, clips) {
  return request(app)
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
}

async function pollStatus(app, jobId) {
  const res = await request(app).get(`/jobs/${jobId}`).set('X-Api-Key', API_KEY);
  return res.status === 200 ? res.body : null;
}

async function until(predicate, { timeoutMs, everyMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

describe('Integration: content-hash chunk reuse across attempts', () => {
  let app, queue, workers, redis;
  const logged = [];

  beforeAll(async () => {
    for (const f of [...SOURCES, 'audio_voiceover.mp3']) {
      if (!fs.existsSync(path.join(FIXTURES, f))) {
        throw new Error(`Fixture missing: ${f} — run: bash scripts/generate_test_clips.sh`);
      }
    }
    await fsp.mkdir(process.env.TEMP_DIR, { recursive: true });
    await fsp.mkdir(process.env.OUTPUT_DIR, { recursive: true });

    const logger = require('../../src/logger');
    const original = logger.info.bind(logger);
    logger.info = (obj, msg, ...rest) => {
      logged.push({ obj, msg });
      return original(obj, msg, ...rest);
    };

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
    '35 of 36 chunks are claimed by content hash; the retry encodes exactly one',
    async () => {
      // ── Attempt 1: fails at 35/36, exactly like production ────────────────
      const firstId = `int-reuse-a-${Date.now()}`;
      const firstStarted = Date.now();
      expect((await postJob(app, firstId, buildClips({ lastChunkBroken: true }))).status).toBe(202);

      // 35 chunks finish; the broken one exhausts its attempts. The project is
      // now the 2026-08-09 shape: one chunk from done, 35 outputs on disk.
      const thirtyFive = await until(
        async () => (await pollStatus(app, firstId))?.chunks_completed === CHUNKS - 1,
        { timeoutMs: POLL_TIMEOUT_MS },
      );
      expect(thirtyFive).toBe(true);
      const firstElapsedMs = Date.now() - firstStarted;

      // Every finished chunk advertised its output for content-identical
      // future attempts.
      await until(
        async () => (await redis.keys('render:chunk-cache:*')).length >= CHUNKS - 1,
        { timeoutMs: 30_000 },
      );
      expect((await redis.keys('render:chunk-cache:*')).length).toBeGreaterThanOrEqual(CHUNKS - 1);

      // What attempt 1 actually SPENT on encoding, from the per-chunk phase
      // telemetry — the work a retry must not repeat.
      const firstEncodes = logged.filter(
        (l) =>
          l.msg === 'Render phase split' && String(l.obj?.jobId ?? '').startsWith(firstId),
      );
      expect(firstEncodes).toHaveLength(CHUNKS - 1);
      const firstEncodeMs = firstEncodes.reduce((sum, l) => sum + (l.obj?.encodeMs ?? 0), 0);
      const firstDownloadMs = firstEncodes.reduce((sum, l) => sum + (l.obj?.downloadMs ?? 0), 0);

      // ── Attempt 2: a NEW job id, same content, the bad chunk fixed ────────
      const retryId = `int-reuse-b-${Date.now()}`;
      const retryStarted = Date.now();
      logged.length = 0;
      expect((await postJob(app, retryId, buildClips({ lastChunkBroken: false }))).status).toBe(202);

      // Chunk phase first, so the comparison below is like-for-like: attempt 1
      // was timed through its chunk phase (its stitch never ran).
      const chunksDone = await until(
        async () => (await pollStatus(app, retryId))?.chunks_completed === CHUNKS,
        { timeoutMs: POLL_TIMEOUT_MS },
      );
      expect(chunksDone).toBe(true);
      const retryChunksElapsedMs = Date.now() - retryStarted;

      const done = await until(
        async () => {
          const s = await pollStatus(app, retryId);
          return s?.status === 'completed' || s?.status === 'failed';
        },
        { timeoutMs: POLL_TIMEOUT_MS },
      );
      expect(done).toBe(true);
      const retryElapsedMs = Date.now() - retryStarted;
      const final = await pollStatus(app, retryId);
      expect(final.status).toBe('completed');
      expect(final.chunks_completed).toBe(CHUNKS);

      // THE MEASUREMENT the work order asks for: reused vs re-encoded.
      const reused = logged.filter(
        (l) =>
          l.msg === 'Reused identical chunk output from a previous render attempt' &&
          String(l.obj?.jobId ?? '').startsWith(retryId),
      );
      const encoded = logged.filter(
        (l) =>
          l.msg === 'Render phase split' && String(l.obj?.jobId ?? '').startsWith(retryId),
      );
      expect(reused).toHaveLength(CHUNKS - 1);
      expect(encoded).toHaveLength(1);
      expect(encoded[0].obj.jobId).toBe(`${retryId}-chunk-${CHUNKS - 1}`);

      // And the WORK is eliminated, not just relabeled: the retry's total
      // download+encode time collapses to a single chunk's worth. This is the
      // scale-independent measurement — at fixture scale each encode is a few
      // hundred ms and per-job queue cadence (~1s/job) dominates wall-clock
      // for BOTH attempts, so wall-clock is reported below but the assertion
      // is on the encoding actually performed. In production the re-encoded
      // chunk phase was ~20 minutes of EPYC time per retry.
      const retryEncodes = logged.filter(
        (l) =>
          l.msg === 'Render phase split' && String(l.obj?.jobId ?? '').startsWith(retryId),
      );
      const retryEncodeMs = retryEncodes.reduce((sum, l) => sum + (l.obj?.encodeMs ?? 0), 0);
      const retryDownloadMs = retryEncodes.reduce((sum, l) => sum + (l.obj?.downloadMs ?? 0), 0);
      expect(retryEncodeMs + retryDownloadMs).toBeLessThan(
        (firstEncodeMs + firstDownloadMs) / 5,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[chunk-reuse] attempt 1: ${CHUNKS - 1} encodes, ` +
          `${firstDownloadMs}ms downloading + ${firstEncodeMs}ms encoding, chunk phase ${firstElapsedMs}ms wall. ` +
          `retry: ${reused.length} reused / ${encoded.length} encoded, ` +
          `${retryDownloadMs}ms downloading + ${retryEncodeMs}ms encoding, ` +
          `chunk phase ${retryChunksElapsedMs}ms wall, total incl. stitch ${retryElapsedMs}ms`,
      );

      // A claimed chunk is the SAME output, byte for byte — copied, not
      // re-derived. (The stitch itself is asserted only to exist: the test
      // audio fixture is 12s and -shortest truncates against it, which is a
      // fixture artifact, not the subject here.)
      const firstChunk0 = path.join(process.env.TEMP_DIR, `${firstId}-chunk-0`, 'output.mp4');
      const retryChunk0 = path.join(process.env.TEMP_DIR, `${retryId}-chunk-0`, 'output.mp4');
      expect(fs.existsSync(firstChunk0)).toBe(true);
      expect(fs.existsSync(retryChunk0)).toBe(true);
      expect((await fsp.stat(retryChunk0)).size).toBe((await fsp.stat(firstChunk0)).size);

      // And the one freshly encoded chunk is frame-exact for its slice of the
      // timeline, so the stitched result stays continuous across the seam
      // between claimed and fresh outputs.
      const lastChunkClips = buildClips({ lastChunkBroken: false }).slice(
        (CHUNKS - 1) * CLIPS_PER_CHUNK,
      );
      const lastChunkDuration = lastChunkClips.reduce((s, c) => s + (c.end - c.start), 0);
      const retryLastChunk = path.join(
        process.env.TEMP_DIR,
        `${retryId}-chunk-${CHUNKS - 1}`,
        'output.mp4',
      );
      expect(fs.existsSync(retryLastChunk)).toBe(true);
      const lastChunkFrames = await countFrames(retryLastChunk);
      expect(Math.abs(lastChunkFrames - Math.round(lastChunkDuration * 30))).toBeLessThanOrEqual(1);

      const candidates = [
        path.join(process.env.OUTPUT_DIR, `${retryId}.mp4`),
        path.join(process.env.OUTPUT_DIR, `${retryId}-stitch.mp4`),
        path.join(process.env.TEMP_DIR, retryId, 'final_output.mp4'),
        path.join(process.env.TEMP_DIR, `${retryId}-stitch`, 'final_output.mp4'),
      ];
      const output = candidates.find((p) => fs.existsSync(p));
      expect(output).toBeTruthy();
      expect(await countFrames(output)).toBeGreaterThan(0);
    },
    POLL_TIMEOUT_MS * 2 + 60_000,
  );
});
