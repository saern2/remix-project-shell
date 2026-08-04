// Round 6 — download-path fixes (Issues 1.5, 2, 3, 4, 5)
// Exercises the real downloadFile/downloadAll against a local HTTP server.
//
// Covers:
//  - Issue 3: stall timeout (not total-duration), slow-but-progressing succeeds,
//             rich error message (bytes received / expected / elapsed)
//  - Issue 1.5: per-file Content-Length ceiling rejects oversized clips fast
//  - Issue 4.2: intra-batch URL de-duplication (one fetch shared across indices)
//  - Issue 5: parent abort signal accrues exactly one listener regardless of
//             download concurrency

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Load config + downloader fresh with test env ─────────────────────────────
function loadDownloader(env = {}) {
  process.env.WORKER_API_KEY = 'test-api-key-12345';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.URL_ALLOWLIST = ''; // SSRF disabled → localhost allowed for tests
  process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
  process.env.MAX_CLIP_BYTES = String(150 * 1024 * 1024);
  process.env.GLOBAL_CDN_CONCURRENCY = '4';
  process.env.DOWNLOAD_STALL_TIMEOUT_SECONDS = '1';
  process.env.DOWNLOAD_MAX_SECONDS = '30';
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

  delete require.cache[require.resolve('../src/config.js')];
  delete require.cache[require.resolve('../src/downloader.js')];
  delete require.cache[require.resolve('../src/logger.js')];
  return require('../src/downloader.js');
}

// ── Test HTTP server with programmable handlers ──────────────────────────────
let server;
let baseUrl;
let handler; // (req, res) => void

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let tmpDir;
beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-test-'));
});
afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('downloadFile — stall timeout (Issue 3)', () => {
  it('aborts a stalled transfer and reports bytes received / expected / elapsed', async () => {
    const { downloadFile } = loadDownloader({ DOWNLOAD_STALL_TIMEOUT_SECONDS: '1' });
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write(Buffer.alloc(500)); // send a little, then go silent forever
      // never end, never send more → stall
    };
    const dest = path.join(tmpDir, 'stalled.bin');
    const start = Date.now();
    await expect(downloadFile(`${baseUrl}/stall`, dest)).rejects.toThrow(/stalled/i);
    const elapsed = Date.now() - start;
    // Stall timeout is 1s; must fire well before the 30s absolute ceiling.
    expect(elapsed).toBeLessThan(5000);
    // And the error must carry diagnostic context.
    await downloadFile(`${baseUrl}/stall`, dest).catch((err) => {
      expect(err.message).toMatch(/received 500 of 1000000 bytes/);
      expect(err.message).toMatch(/MB\/s/);
    });
  });

  it('allows a slow-but-progressing download to finish', async () => {
    const { downloadFile } = loadDownloader({ DOWNLOAD_STALL_TIMEOUT_SECONDS: '1' });
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': '5' });
      let n = 0;
      const iv = setInterval(() => {
        res.write(Buffer.from('x')); // one byte every 300ms < 1s stall window
        if (++n === 5) { clearInterval(iv); res.end(); }
      }, 300);
    };
    const dest = path.join(tmpDir, 'slow.bin');
    const bytes = await downloadFile(`${baseUrl}/slow`, dest);
    expect(bytes).toBe(5);
    expect(fs.readFileSync(dest).toString()).toBe('xxxxx');
  });
});

describe('downloadFile — per-file ceiling (Issue 1.5)', () => {
  it('rejects a clip whose Content-Length exceeds MAX_CLIP_BYTES before streaming it', async () => {
    const { downloadFile } = loadDownloader();
    let bodyBytesSent = 0;
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': String(986 * 1024 * 1024) }); // ~986 MB
      bodyBytesSent += 10;
      res.write(Buffer.alloc(10));
      res.end();
    };
    const dest = path.join(tmpDir, 'huge.mp4');
    await expect(
      downloadFile(`${baseUrl}/huge`, dest, { maxBytes: 150 * 1024 * 1024 }),
    ).rejects.toThrow(/exceeds per-file limit/);
  });

  it('accepts a clip within the ceiling', async () => {
    const { downloadFile } = loadDownloader();
    const payload = Buffer.alloc(2048, 7);
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    };
    const dest = path.join(tmpDir, 'ok.mp4');
    const bytes = await downloadFile(`${baseUrl}/ok`, dest, { maxBytes: 150 * 1024 * 1024 });
    expect(bytes).toBe(payload.length);
  });
});

describe('downloadAll — intra-batch de-duplication (Issue 4.2)', () => {
  it('downloads a shared URL once and maps every index that needs it', async () => {
    const { downloadAll } = loadDownloader();
    let hits = 0;
    const payload = Buffer.alloc(64, 1);
    handler = (req, res) => {
      if (req.url.startsWith('/same')) hits += 1;
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    };
    const sharedUrl = `${baseUrl}/same.mp4`;
    const uniqueUrl = `${baseUrl}/other.mp4`;
    const clips = [
      { clip_url: sharedUrl, start: 0, end: 1 },
      { clip_url: sharedUrl, start: 1, end: 2 },
      { clip_url: uniqueUrl, start: 0, end: 1 },
    ];
    const { clipPaths } = await downloadAll({
      clips,
      fallbackIndices: [0, 1, 2],
      audioUrl: null,
      tempDir: tmpDir,
    });
    expect(hits).toBe(1); // shared URL fetched exactly once
    expect(clipPaths.get(0)).toBe(clipPaths.get(1)); // both indices reuse it
    expect(clipPaths.has(2)).toBe(true);
  });
});

describe('downloadAll — parent abort-signal listener count (Issue 5)', () => {
  it('keeps at most one abort listener on the parent signal during concurrent downloads', async () => {
    const { downloadAll } = loadDownloader();
    const payload = Buffer.alloc(32, 3);
    handler = (req, res) => {
      // Delay so many downloads overlap in flight.
      setTimeout(() => {
        res.writeHead(200, { 'content-length': String(payload.length) });
        res.end(payload);
      }, 50);
    };

    const ac = new AbortController();
    const signal = ac.signal;
    let live = 0;
    let peak = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, h, o) => {
      if (type === 'abort') { live += 1; peak = Math.max(peak, live); }
      return origAdd(type, h, o);
    };
    signal.removeEventListener = (type, h, o) => {
      if (type === 'abort') live = Math.max(0, live - 1);
      return origRemove(type, h, o);
    };

    const clips = Array.from({ length: 12 }, (_, i) => ({
      clip_url: `${baseUrl}/clip_${i}.mp4`,
      start: 0,
      end: 1,
    }));
    await downloadAll({
      clips,
      fallbackIndices: clips.map((_, i) => i),
      audioUrl: null,
      tempDir: tmpDir,
      signal,
    });

    // Fan-out design: exactly one parent listener regardless of 12 concurrent clips.
    expect(peak).toBeLessThanOrEqual(1);
    expect(live).toBe(0); // cleaned up afterwards
  });

  it('propagates a parent abort to in-flight child downloads', async () => {
    const { downloadAll } = loadDownloader({ DOWNLOAD_MAX_SECONDS: '30' });
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write(Buffer.alloc(100)); // start, then hang
    };
    const ac = new AbortController();
    const clips = [{ clip_url: `${baseUrl}/hang.mp4`, start: 0, end: 1 }];
    const p = downloadAll({
      clips,
      fallbackIndices: [0],
      audioUrl: null,
      tempDir: tmpDir,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow(/abort/i);
  });
});
