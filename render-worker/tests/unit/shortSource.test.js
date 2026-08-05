'use strict';

/**
 * Short-source handling and retry reuse.
 *
 * Covers three behaviours that were previously silent or wasteful:
 *
 *  1. A source SHORTER than its slot renders as a freeze frame (tpad clones the
 *     last frame). That is the intended fallback, but it used to happen with no
 *     record at all. It must now be logged, and — critically — it must not
 *     disturb the timeline: the slot still emits its exact frame count.
 *
 *  2. An in-point at or past the end of a source decodes to ZERO frames, which
 *     hands concat an empty stream. In-points come from provider-reported
 *     durations and from render_clip_slices rows that can outlive the source
 *     they were computed against, so this is reachable in production.
 *
 *  3. A chunk that fails keeps its downloads so the retry can verify and reuse
 *     them instead of re-fetching hundreds of MB.
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-key';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/short-source-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/short-source-out';
process.env.JOB_TIMEOUT_SECONDS = '120';
process.env.MAX_DURATION_SECONDS = '600';
process.env.JOB_ATTEMPTS = '3';
process.env.JOB_BACKOFF_DELAY_MS = '1';

const FIXTURES = path.resolve(__dirname, '../fixtures/clips');
const { processRenderJob } = require('../../src/renderJob');
const { downloadAll } = require('../../src/downloader');
const { countFrames } = require('../helpers/ffprobeHelpers');

// The fixtures are 3s long; asking for 5s forces the freeze-frame path.
const SHORT_FIXTURE = path.join(FIXTURES, 'clip_720_24fps.mp4');
const OTHER_FIXTURE = path.join(FIXTURES, 'clip_1080_30fps.mp4');
const fileUrl = (p) => `file://${p}`;

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

function basePayload(clips) {
  return {
    clips,
    audio_url: null,
    width: 1280,
    height: 720,
    fps: 30,
    transition: 'hard-cut',
    transition_duration: 0.5,
    format: 'mp4',
    is_chunk: true,
  };
}

beforeAll(() => {
  if (!fs.existsSync(SHORT_FIXTURE)) {
    throw new Error(`Test fixture not found: ${SHORT_FIXTURE}\nRun: bash scripts/generate_test_clips.sh`);
  }
});

describe('short sources, bad in-points, and retry reuse', () => {
  test('a source shorter than its slot freeze-frames without disturbing the timeline', async () => {
    const jobId = `short-source-${Date.now()}`;
    // 5s and 4.4s slots from 3s sources: both freeze-frame.
    const clips = [
      { clip_url: fileUrl(SHORT_FIXTURE), start: 0, end: 5, scene_id: 'scene-a', provider_clip_id: 'pexels-1' },
      { clip_url: fileUrl(OTHER_FIXTURE), start: 0, end: 4.4, scene_id: 'scene-b', provider_clip_id: 'pexels-2' },
    ];
    const job = makeMockJob(jobId, basePayload(clips));
    await expect(processRenderJob(job)).resolves.toBeDefined();

    const outputPath = path.join(process.env.TEMP_DIR, jobId, 'output.mp4');
    // The whole point: padding fills the slot, so the timeline is untouched.
    // 9.4s at 30fps = 282 frames exactly.
    expect(await countFrames(outputPath)).toBe(Math.round(9.4 * 30));

    await fsp.rm(path.join(process.env.TEMP_DIR, jobId), { recursive: true, force: true });
  }, 300000);

  test('an in-point past the end of a source is clamped instead of decoding nothing', async () => {
    const jobId = `bad-inpoint-${Date.now()}`;
    // The fixture is 3s; an in-point of 12s is past its end entirely. Without
    // the clamp the decoder yields no frames and concat receives an empty stream.
    const clips = [
      { clip_url: fileUrl(SHORT_FIXTURE), start: 12, end: 14, scene_id: 'scene-a', provider_clip_id: 'nasa-1' },
      { clip_url: fileUrl(OTHER_FIXTURE), start: 0, end: 2, scene_id: 'scene-b', provider_clip_id: 'pexels-2' },
    ];
    const job = makeMockJob(jobId, basePayload(clips));
    await expect(processRenderJob(job)).resolves.toBeDefined();

    const outputPath = path.join(process.env.TEMP_DIR, jobId, 'output.mp4');
    // 4s at 30fps — the clamped clip still contributes its full 2s slot.
    expect(await countFrames(outputPath)).toBe(120);

    await fsp.rm(path.join(process.env.TEMP_DIR, jobId), { recursive: true, force: true });
  }, 300000);

  test('reuses an already-downloaded clip and re-fetches a truncated one', async () => {
    const tempDir = path.join(os.tmpdir(), `reuse-test-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    try {
      const clips = [{ clip_url: fileUrl(SHORT_FIXTURE), start: 0, end: 2 }];
      const args = { clips, fallbackIndices: [0], audioUrl: null, tempDir };

      const first = await downloadAll(args);
      const clipFile = first.clipPaths.get(0);
      const markerFile = `${clipFile}.ok`;
      expect(fs.existsSync(markerFile)).toBe(true);
      const firstStat = await fsp.stat(clipFile);

      // Second pass: a complete, verified file must be reused, not rewritten.
      await downloadAll(args);
      const secondStat = await fsp.stat(clipFile);
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);

      // Truncate it: the marker still claims the original size, so the size
      // check alone rejects it and the file is fetched again.
      await fsp.truncate(clipFile, 1024);
      await downloadAll(args);
      const thirdStat = await fsp.stat(clipFile);
      expect(thirdStat.size).toBe(firstStat.size);
      expect(thirdStat.mtimeMs).not.toBe(firstStat.mtimeMs);

      // A file that is intact by size but undecodable must also be rejected.
      await fsp.writeFile(clipFile, Buffer.alloc(thirdStat.size, 0));
      await downloadAll(args);
      expect(await countFrames(clipFile)).toBeGreaterThan(0);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }, 300000);
});
