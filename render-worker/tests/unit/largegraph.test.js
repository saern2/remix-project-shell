'use strict';

/**
 * tests/unit/largegraph.test.js
 *
 * STRESS TEST: ~50 synthetic clips matching real production project sizes.
 *
 * This test validates that:
 * 1. The filter graph builder correctly handles 50 clips (production scale).
 * 2. -filter_complex_script <file> is used (not inline -filter_complex),
 *    which avoids OS command-line argument length limits.
 * 3. The render completes successfully without hitting argument length errors,
 *    which would be a new, confusing failure mode at production clip counts.
 *
 * The 50-clip input is assembled from 3 base clips of different resolutions
 * (to also exercise the normalisation filter at scale).
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');

process.env.WORKER_API_KEY = 'test-key';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/large-graph-test-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/large-graph-test-out';
process.env.JOB_TIMEOUT_SECONDS = '300'; // 5 min for a 50-clip render
process.env.MAX_CLIPS = '60';
process.env.MAX_DURATION_SECONDS = '600';
process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
process.env.DOWNLOAD_TIMEOUT_SECONDS = '60';
process.env.JOB_ATTEMPTS = '1';
process.env.JOB_BACKOFF_DELAY_MS = '1'; // > 0 required by config validation

const STRESS_DIR = path.resolve(__dirname, '../fixtures/clips/stress_50');
const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;

const { assertVideoProperties, assertFileNonEmpty } = require('../helpers/ffprobeHelpers');

function makeMockJob(jobId, payload) {
  const data = { ...payload };
  return {
    id: jobId,
    data,
    progress: 0,
    attemptsMade: 0,
    timestamp: Date.now(),
    updateData: async (d) => { Object.assign(data, d); },
    updateProgress: async (p) => { data._progress = p; },
    getState: async () => 'active',
    failedReason: null,
  };
}

function stressClipPath(filename) {
  const p = path.join(STRESS_DIR, filename);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Stress test fixture not found: ${p}\n` +
      `Run: bash scripts/generate_test_clips.sh\n` +
      `then re-run the tests.`
    );
  }
  return p;
}

describe('Large filter graph — 50 clips (production scale)', () => {
  let outputPath;

  beforeAll(async () => {
    await fsp.mkdir(process.env.TEMP_DIR, { recursive: true });
    await fsp.mkdir(process.env.OUTPUT_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (outputPath) {
      try { await fsp.rm(outputPath, { force: true }); } catch { /* ignore */ }
    }
  });

  test(
    'renders 50 clips (mixed resolutions) without hitting CLI arg length limits',
    async () => {
      const { processRenderJob } = require('../../src/renderJob');

      // Build 50 clip entries, cycling through 3 different-resolution sources
      const clipFiles = ['base_a.mp4', 'base_b.mp4', 'base_c.mp4'];
      const clips = Array.from({ length: 50 }, (_, i) => ({
        clip_url: `file://${stressClipPath(clipFiles[i % 3])}`,
        start: 0,
        end: 2,
      }));

      const audio = stressClipPath('audio.mp3');
      const jobId = `large-graph-test-${Date.now()}`;

      const payload = {
        job_id: jobId,
        clips,
        audio_url: `file://${audio}`,
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        fps: TARGET_FPS,
        aspect_ratio: '16:9',
        transition: 'hard-cut',
        transition_duration: 0.5,
        format: 'mp4',
        output_upload_url: null,
      };

      const job = makeMockJob(jobId, payload);

      await expect(processRenderJob(job)).resolves.toBeDefined();

      outputPath = path.join(process.env.OUTPUT_DIR, `${jobId}.mp4`);
      await assertFileNonEmpty(outputPath);
      await assertVideoProperties(outputPath, {
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        fps: TARGET_FPS,
      });
    },
    300_000 // 5 min timeout — 50 clips is a real workload
  );

  test(
    'filter_complex_script file is written (not inline -filter_complex)',
    async () => {
      // Verify by inspecting the buildFilterGraph output
      const { buildFilterGraph } = require('../../src/ffmpegBuilder');
      const tmpDir = path.join(os.tmpdir(), 'fgraph-test-' + Date.now());
      await fsp.mkdir(tmpDir, { recursive: true });

      const clips = Array.from({ length: 50 }, (_, i) => ({ start: 0, end: 2 }));
      const { scriptPath, finalVideoLabel } = buildFilterGraph({
        clips,
        width: 1280,
        height: 720,
        fps: 30,
        transition: 'hard-cut',
        transitionDuration: 0.5,
        tempDir: tmpDir,
      });

      // Script file must exist and be non-empty
      const stat = await fsp.stat(scriptPath);
      expect(stat.size).toBeGreaterThan(0);

      const content = await fsp.readFile(scriptPath, 'utf8');

      // Must contain 50 normalisation filter chains
      const normFilterCount = (content.match(/force_original_aspect_ratio=decrease/g) || []).length;
      expect(normFilterCount).toBe(50);

      // Must contain a concat filter for all 50 inputs
      expect(content).toMatch(/concat=n=50/);

      // Final label must be present
      expect(content).toContain(finalVideoLabel);

      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  );
});
