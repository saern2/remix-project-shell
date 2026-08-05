'use strict';

/**
 * Oversized sources must not cost a chunk attempt.
 *
 * Production drew a 235,132,958-byte Pixabay rendition against MAX_CLIP_BYTES
 * of 157,286,400. The Content-Length pre-check rejected it correctly — and then
 * failed the whole chunk, so every render that selected that clip burned its
 * first attempt. Recovering from an avoidable failure is still waste.
 *
 * The payload now carries smaller renditions of the SAME source, so the
 * downloader walks them in order. No extra provider requests: the alternatives
 * were in the search response all along.
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');
const http = require('http');

process.env.WORKER_API_KEY = 'test-key';
process.env.URL_ALLOWLIST = '';
process.env.TEMP_DIR = os.tmpdir() + '/oversize-tmp';
process.env.OUTPUT_DIR = os.tmpdir() + '/oversize-out';
process.env.JOB_ATTEMPTS = '3';
process.env.JOB_BACKOFF_DELAY_MS = '1';
process.env.MAX_CLIP_BYTES = '2000000'; // 2 MB ceiling for the test

const { downloadAll, OversizedSourceError, providerOf } = require('../../src/downloader');

const FIXTURE = path.resolve(__dirname, '../fixtures/clips/clip_720_24fps.mp4');

/**
 * Serves three renditions of "the same source": one over the ceiling, two under.
 * Content-Length is what the pre-check reads, so that is what varies.
 */
let server;
let base;
beforeAll(async () => {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(`Fixture missing: ${FIXTURE}\nRun: bash scripts/generate_test_clips.sh`);
  }
  const real = await fsp.readFile(FIXTURE);
  const huge = Buffer.alloc(3_000_000, 7); // 3 MB > 2 MB ceiling

  server = http.createServer((req, res) => {
    if (req.url === '/clip_large.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(huge.length) });
      return res.end(huge);
    }
    if (req.url === '/clip_medium.mp4' || req.url === '/clip_small.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(real.length) });
      return res.end(real);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function withTempDir(fn) {
  const dir = path.join(os.tmpdir(), `oversize-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('oversized source fall-through', () => {
  test('falls through to a smaller rendition instead of failing the chunk', async () => {
    await withTempDir(async (tempDir) => {
      const clips = [
        {
          clip_url: `${base}/clip_large.mp4`,
          fallback_urls: [`${base}/clip_medium.mp4`, `${base}/clip_small.mp4`],
          start: 0,
          end: 1,
        },
      ];
      const { clipPaths } = await downloadAll({
        clips,
        fallbackIndices: [0],
        audioUrl: null,
        tempDir,
      });

      const file = clipPaths.get(0);
      expect(file).toBeTruthy();
      // The medium rendition landed — same footage, under the ceiling.
      const stat = await fsp.stat(file);
      expect(stat.size).toBe((await fsp.stat(FIXTURE)).size);
      // And it is marked complete, so a retry would reuse rather than refetch.
      expect(fs.existsSync(`${file}.ok`)).toBe(true);
    });
  }, 60000);

  test('fails only when every rendition of the source is oversized', async () => {
    await withTempDir(async (tempDir) => {
      const clips = [
        {
          clip_url: `${base}/clip_large.mp4`,
          fallback_urls: [`${base}/clip_large.mp4`],
          start: 0,
          end: 1,
        },
      ];
      await expect(
        downloadAll({ clips, fallbackIndices: [0], audioUrl: null, tempDir }),
      ).rejects.toThrow(/exceeds per-file limit[\s\S]*all 2 rendition/);
    });
  }, 60000);

  test('a source with no fallbacks still fails, and says so precisely', async () => {
    await withTempDir(async (tempDir) => {
      const clips = [{ clip_url: `${base}/clip_large.mp4`, start: 0, end: 1 }];
      await expect(
        downloadAll({ clips, fallbackIndices: [0], audioUrl: null, tempDir }),
      ).rejects.toThrow(/Content-Length 3000000 exceeds per-file limit 2000000/);
    });
  }, 60000);

  test('non-oversize failures are NOT retried against fallbacks', async () => {
    // A 404 is not something a different rendition fixes; falling through would
    // just multiply the wasted requests.
    await withTempDir(async (tempDir) => {
      const clips = [
        {
          clip_url: `${base}/missing.mp4`,
          fallback_urls: [`${base}/clip_medium.mp4`],
          start: 0,
          end: 1,
        },
      ];
      await expect(
        downloadAll({ clips, fallbackIndices: [0], audioUrl: null, tempDir }),
      ).rejects.toThrow(/404|HTTP/);
    });
  }, 60000);

  test('the oversize error carries the numbers the logs need', () => {
    const err = new OversizedSourceError('https://cdn.pixabay.com/video/x_large.mp4', 235132958, 157286400);
    expect(err).toBeInstanceOf(OversizedSourceError);
    expect(err.bytes).toBe(235132958);
    expect(err.limit).toBe(157286400);
    expect(err.url).toContain('pixabay');
  });

  test('provider is derived from the URL for log attribution', () => {
    expect(providerOf('https://cdn.pixabay.com/video/2025/06/13/285663_large.mp4')).toBe('pixabay');
    expect(providerOf('https://videos.pexels.com/video-files/123/x.mp4')).toBe('pexels');
    expect(providerOf('https://images-assets.nasa.gov/video/x/x~orig.mp4')).toBe('nasa');
    expect(providerOf('not a url')).toBe('unknown');
  });
});
