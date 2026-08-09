'use strict';

/**
 * INTEGRATION: a single unrenderable clip must never kill a project.
 *
 * THE REPRODUCTION THIS ENCODES. On 2026-08-09, "These 4 Nearby Planets"
 * failed at 20/21 across two complete, independent re-renders; "Time Is Not
 * Permanent" did the same at 32/45. A segment that fails identically twice is
 * content — a dead source URL — and the old download path rethrew the very
 * first failure of the PRIMARY url without consulting the fallback renditions
 * or alternate candidates sitting next to it in the payload. One dead clip
 * cost the whole chunk, all its recoveries, and finally the project, at 95%.
 *
 * Here that failure is forced deliberately: clips point at URLs that cannot
 * resolve, and the render must degrade through the tiers instead of dying —
 *   tier 1: a fallback rendition of the same source
 *   tier 2: the scene's next-best candidate (alternate_urls)
 *   tier 3: extend the neighbouring clip across the gap, LOUDLY
 * and the project must COMPLETE.
 *
 * The second test pins the other half of the work order: when a chunk really
 * is unrecoverable (every clip dead), the reason survives in Redis and the
 * status API names the segment and the cause — not just a count.
 */

const request = require('supertest');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-api-key-degrade';
// Databases 1-9 belong to other suites; vitest runs files in parallel and
// shared queues would let workers steal each other's jobs.
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/10';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/int-degrade-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/int-degrade-out';
process.env.JOB_TIMEOUT_SECONDS = '300';
process.env.CHUNK_TIMEOUT_SECONDS = '300';
process.env.STITCH_TIMEOUT_SECONDS = '300';
process.env.MAX_CLIPS = '400';
process.env.MAX_DURATION_SECONDS = '3600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.JOB_ATTEMPTS = '2';
process.env.JOB_BACKOFF_DELAY_MS = '100';
// 6 clips at CHUNK_SIZE=4 fans out to two chunks, so degradation is exercised
// inside a chunk AND the chunk boundary arithmetic still has to hold.
process.env.CHUNK_SIZE = '4';
process.env.WORKER_CONCURRENCY_CHUNKS = '4';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

const IORedis = require('ioredis');
const { Job } = require('bullmq');
const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const API_KEY = 'test-api-key-degrade';
const POLL_TIMEOUT_MS = 300_000;

const { countFrames } = require('../helpers/ffprobeHelpers');
const { FAILURE_DETAIL_KEY_PREFIX } = require('../../src/chunkRecovery');

const clipUrl = (f) => `file://${path.join(FIXTURES, f)}`;
// A file:// URL that passes validation but has nothing behind it — the local
// equivalent of a CDN link that has expired or been deleted.
const deadUrl = (name) => `file://${path.join(FIXTURES, `${name}-does-not-exist.mp4`)}`;

async function pollUntilDone(app, jobId, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/jobs/${jobId}`).set('X-Api-Key', API_KEY);
    if (res.status === 200) {
      last = res.body;
      if (last.status === 'completed' || last.status === 'failed') return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out polling ${jobId}. Last: ${JSON.stringify(last)}`);
}

async function until(predicate, { timeoutMs = 60_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

describe('Integration: clip degradation tiers', () => {
  let app, queue, workers, redis;
  // The work order requires the degradation to be LOUD. pino writes to a
  // transport, so capture at the call site instead of parsing streams.
  const logged = [];

  beforeAll(async () => {
    for (const f of ['clip_720_24fps.mp4', 'clip_1080_30fps.mp4', 'audio_voiceover.mp3']) {
      if (!fs.existsSync(path.join(FIXTURES, f))) {
        throw new Error(`Fixture missing: ${f} — run: bash scripts/generate_test_clips.sh`);
      }
    }
    await fsp.mkdir(process.env.TEMP_DIR, { recursive: true });
    await fsp.mkdir(process.env.OUTPUT_DIR, { recursive: true });

    const logger = require('../../src/logger');
    for (const level of ['warn', 'error']) {
      const original = logger[level].bind(logger);
      logger[level] = (obj, msg, ...rest) => {
        logged.push({ level, obj, msg });
        return original(obj, msg, ...rest);
      };
    }

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
    'dead primaries degrade through fallback → alternate → neighbour extension, and the project COMPLETES',
    async () => {
      const jobId = `int-degrade-${Date.now()}`;
      const GOOD = clipUrl('clip_720_24fps.mp4');
      const GOOD_ALT = clipUrl('clip_1080_30fps.mp4');

      // Six 1-second clips; chunk 0 = clips 0-3, chunk 1 = clips 4-5.
      const clips = [
        { clip_url: GOOD, start: 0, end: 1, scene_id: 'scene-0' },
        // Tier 1: primary dead, a rendition of the same source is fine.
        {
          clip_url: deadUrl('primary-1'),
          fallback_urls: [clipUrl('clip_720_24fps.mp4')],
          start: 0,
          end: 1,
          scene_id: 'scene-1',
        },
        // Tier 2: primary AND every rendition dead; the scene's next-best
        // candidate from the corpus is reachable.
        {
          clip_url: deadUrl('primary-2'),
          fallback_urls: [deadUrl('rendition-2')],
          alternate_urls: [GOOD_ALT],
          start: 0,
          end: 1,
          scene_id: 'scene-2',
        },
        { clip_url: GOOD_ALT, start: 0, end: 1, scene_id: 'scene-3' },
        // Tier 3: nothing for this clip resolves at all. The neighbour must be
        // extended across the gap — a project with one extended shot beats a
        // project that fails at 95%, twice.
        {
          clip_url: deadUrl('primary-4'),
          fallback_urls: [deadUrl('rendition-4')],
          alternate_urls: [deadUrl('alternate-4')],
          start: 0,
          end: 1,
          scene_id: 'scene-4',
        },
        { clip_url: GOOD, start: 1, end: 2, scene_id: 'scene-5' },
      ];
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

      const final = await pollUntilDone(app, jobId);
      expect(final.error ?? null).toBeNull();
      expect(final.status).toBe('completed');
      expect(final.chunks_total).toBe(2);
      expect(final.chunks_completed).toBe(2);

      // Tiers 1 and 2 recovered by walking the candidate list (scene-1 via its
      // rendition, scene-2 via its alternate candidate).
      const recoveries = logged.filter((l) => l.msg === 'Recovered clip from a fallback source');
      const recoveredScenes = new Set(recoveries.map((l) => l.obj?.sceneId));
      expect(recoveredScenes.has('scene-1')).toBe(true);
      expect(recoveredScenes.has('scene-2')).toBe(true);

      // Tier 3 was LOUD: the dead clip is named with its scene and reason...
      const unrenderable = logged.find(
        (l) =>
          l.level === 'error' &&
          /CLIP UNRENDERABLE/.test(l.msg ?? '') &&
          l.obj?.sceneId === 'scene-4',
      );
      expect(unrenderable).toBeTruthy();
      expect(unrenderable.obj.candidatesTried).toBe(3);

      // ...and so is the substitution that filled its slot.
      const degraded = logged.find(
        (l) =>
          l.level === 'error' &&
          /CLIP DEGRADED/.test(l.msg ?? '') &&
          l.obj?.sceneId === 'scene-4',
      );
      expect(degraded).toBeTruthy();
      expect(degraded.obj.reason).toBeTruthy();

      // The gap was FILLED, not dropped: the output still carries all six
      // 1-second slots. Losing scene-4's slot would leave ~150 frames.
      const candidates = [
        path.join(process.env.OUTPUT_DIR, `${jobId}.mp4`),
        path.join(process.env.OUTPUT_DIR, `${jobId}-stitch.mp4`),
        path.join(process.env.TEMP_DIR, jobId, 'final_output.mp4'),
        path.join(process.env.TEMP_DIR, `${jobId}-stitch`, 'final_output.mp4'),
      ];
      const output = candidates.find((p) => fs.existsSync(p));
      expect(output).toBeTruthy();
      const frames = await countFrames(output);
      expect(frames).toBeGreaterThanOrEqual(Math.round(totalDuration * 30) - 2);
      expect(frames).toBeLessThanOrEqual(Math.round(totalDuration * 30) + 2);
    },
    POLL_TIMEOUT_MS + 30_000,
  );

  test(
    'a truly unrecoverable chunk records WHY, and the status error names the segment',
    async () => {
      const jobId = `int-degrade-dead-${Date.now()}`;
      // Chunk 0 (clips 0-3) is healthy; chunk 1 (clips 4-5) has NO usable
      // source in any clip — the one shape that must still fail, visibly.
      const GOOD = clipUrl('clip_720_24fps.mp4');
      const clips = [
        { clip_url: GOOD, start: 0, end: 1, scene_id: 'ok-0' },
        { clip_url: GOOD, start: 0, end: 1, scene_id: 'ok-1' },
        { clip_url: GOOD, start: 0, end: 1, scene_id: 'ok-2' },
        { clip_url: GOOD, start: 0, end: 1, scene_id: 'ok-3' },
        { clip_url: deadUrl('all-dead-a'), start: 0, end: 1, scene_id: 'dead-a' },
        { clip_url: deadUrl('all-dead-b'), start: 0, end: 1, scene_id: 'dead-b' },
      ];

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

      // The chunk burns its attempts and its recoveries, then the failure
      // reason lands durably in Redis — NOT in the 10-minute health record,
      // which would have expired long before the 2026-08-09 evidence was
      // collected. That expiry is exactly why the deployed failures were
      // undiagnosable.
      const detailKey = `${FAILURE_DETAIL_KEY_PREFIX}${jobId}`;
      const recorded = await until(
        async () => (await redis.hexists(detailKey, '1')) === 1,
        { timeoutMs: 120_000 },
      );
      expect(recorded).toBe(true);
      const reason = await redis.hget(detailKey, '1');
      expect(reason).toMatch(/NO_USABLE_SOURCES/);

      // The reconciler's verdict arrives on its own (150s sweeps) schedule; in
      // production it writes _status/_error into the stitch job. Write the
      // same verdict here and assert the status API folds the durable reason
      // into it — segment NUMBER and WHY, not just a count.
      const { getQueue, QUEUE_STITCH } = require('../../src/queue');
      const stitch = await Job.fromId(getQueue(QUEUE_STITCH), `${jobId}-stitch`);
      expect(stitch).toBeTruthy();
      await stitch.updateData({
        ...stitch.data,
        _status: 'failed',
        _error:
          'Rendering could not finish: 1 segment(s) could not be rendered after repeated attempts. Nothing was lost from your project — please start the render again.',
      });

      const res = await request(app).get(`/jobs/${jobId}`).set('X-Api-Key', API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toMatch(/Segment 2 of 2: NO_USABLE_SOURCES/);
      expect(res.body.failed_segments).toEqual([
        { segment: 2, reason: expect.stringMatching(/NO_USABLE_SOURCES/) },
      ]);
    },
    POLL_TIMEOUT_MS + 30_000,
  );
});
