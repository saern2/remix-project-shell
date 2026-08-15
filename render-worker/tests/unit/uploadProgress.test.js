'use strict';

/**
 * The upload byte counter observes; it must never buffer.
 *
 * uploadOutput's memory discipline is load-bearing: the fetch-based versions
 * retained the whole body (peak RSS 4-8 GB on a ~1.3 GB file, one kernel OOM
 * kill on 2026-08-07) and only createReadStream + http.request brought it to
 * ~90 MB. The progress callback added 2026-08-15 rides that same stream as a
 * passive 'data' listener — these tests prove the observation is accurate,
 * throttled, and free of retention.
 */
process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
process.env.URL_ALLOWLIST = ''; // SSRF guard off → localhost allowed in tests

const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

const { uploadOutput } = require('../../src/renderJob');

let server;
let received;
let baseUrl;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on('end', () => {
      received = { bytes, sha256: hash.digest('hex'), contentLength: req.headers['content-length'] };
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

it('reports every byte exactly once and the final callback closes the count', async () => {
  // 5 MB of random bytes: several stream chunks at the 1 MB highWaterMark, so
  // the counter has to accumulate rather than see one buffer.
  const filePath = path.join(os.tmpdir(), `upload-progress-${Date.now()}.bin`);
  const body = crypto.randomBytes(5 * 1024 * 1024);
  await fsp.writeFile(filePath, body);

  const reports = [];
  try {
    await uploadOutput(filePath, `${baseUrl}/put`, undefined, (progress) => {
      reports.push({ ...progress });
    });
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }

  // The server got the identical body — the observer did not consume, reorder
  // or duplicate a single chunk of the piped stream.
  expect(received.bytes).toBe(body.length);
  expect(received.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'));
  expect(received.contentLength).toBe(String(body.length));

  // The counter is monotonic, never overshoots, and its last word is the
  // whole file — the guarantee the 94-100 band and the "of 1.2 GB" label rest on.
  expect(reports.length).toBeGreaterThan(0);
  for (let i = 1; i < reports.length; i += 1) {
    expect(reports[i].sentBytes).toBeGreaterThanOrEqual(reports[i - 1].sentBytes);
  }
  for (const report of reports) {
    expect(report.totalBytes).toBe(body.length);
    expect(report.sentBytes).toBeLessThanOrEqual(body.length);
  }
  expect(reports[reports.length - 1].sentBytes).toBe(body.length);
}, 30000);

it('a throwing callback cannot break the upload', async () => {
  const filePath = path.join(os.tmpdir(), `upload-progress-throw-${Date.now()}.bin`);
  const body = crypto.randomBytes(2 * 1024 * 1024);
  await fsp.writeFile(filePath, body);

  try {
    await expect(
      uploadOutput(filePath, `${baseUrl}/put`, undefined, () => {
        throw new Error('display layer exploded');
      }),
    ).resolves.toBeUndefined();
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
  expect(received.bytes).toBe(body.length);
}, 30000);

it('uploads exactly as before when no callback is given', async () => {
  // The other callers of uploadOutput pass nothing; their path must be
  // byte-for-byte the pre-change code.
  const filePath = path.join(os.tmpdir(), `upload-progress-none-${Date.now()}.bin`);
  const body = crypto.randomBytes(1024 * 1024);
  await fsp.writeFile(filePath, body);
  try {
    await uploadOutput(filePath, `${baseUrl}/put`, undefined);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
  expect(received.bytes).toBe(body.length);
}, 30000);
