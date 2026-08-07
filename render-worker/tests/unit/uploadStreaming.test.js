'use strict';

/**
 * The upload must stream, and it must not use fetch.
 *
 * The 2026-08-07 five-project run lost three of five videos to this. The upload
 * read the whole output with fsp.readFile and handed the Buffer to fetch; a
 * 1.38 GB file produced 8.36 GB of anon-rss and the kernel OOM-killed the worker
 * at the container limit (dmesg, CONSTRAINT_MEMCG, task=node, anon-rss
 * 8,362,628 kB). BullMQ then reported the surviving stitch jobs as stalled.
 *
 * Measured here on a 300 MB body rather than 1.4 GB so the suite stays quick;
 * the shape is what matters and it is linear. Full-size numbers, taken
 * separately on the same code:
 *
 *   fsp.readFile + fetch(Buffer)        1,335 MB file -> peak RSS 4,070 MB
 *   createReadStream + fetch(stream)    1,335 MB file -> peak RSS 1,418 MB
 *   createReadStream + http.request     1,335 MB file -> peak RSS    95 MB
 *
 * The middle line is the trap: streaming INTO fetch does not help, because
 * undici retains the whole body regardless. That is why this test asserts on the
 * transport as well as on the memory.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderJob.js'), 'utf8');

/** The shipped uploadOutput, lifted out and given its own dependencies. */
function loadUploadOutput() {
  const body = SOURCE.slice(
    SOURCE.indexOf('async function uploadOutput'),
    SOURCE.indexOf('\nasync function processStitchJob'),
  );
  const { createReadStream } = require('fs');
  const https = require('https');
  const { pipeline: pipelineAsync } = require('stream/promises');
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  return new Function(
    'fsp',
    'createReadStream',
    'http',
    'https',
    'pipelineAsync',
    'logger',
    `${body}; return uploadOutput;`,
  )(fsp, createReadStream, http, https, pipelineAsync, logger);
}

const BODY_BYTES = 300 * 1024 * 1024;
let server;
let port;
let received;
let statusToReturn;
let tempFile;

beforeAll(async () => {
  received = 0;
  statusToReturn = 200;
  server = http.createServer((req, res) => {
    received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
    });
    req.on('end', () => {
      res.writeHead(statusToReturn);
      res.end(statusToReturn === 200 ? 'ok' : 'storage rejected the object');
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;

  tempFile = path.join(os.tmpdir(), `upload-stream-test-${process.pid}.bin`);
  const handle = await fsp.open(tempFile, 'w');
  const block = Buffer.alloc(4 * 1024 * 1024, 7);
  for (let written = 0; written < BODY_BYTES; written += block.length) {
    await handle.write(block);
  }
  await handle.close();
}, 120000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tempFile, { force: true });
});

describe('uploadOutput streams the file', () => {
  it('sends every byte', async () => {
    const uploadOutput = loadUploadOutput();
    await uploadOutput(tempFile, `http://127.0.0.1:${port}/out.mp4`, null);
    expect(received).toBe(BODY_BYTES);
  }, 120000);

  it('holds a small fraction of the file in memory', async () => {
    const uploadOutput = loadUploadOutput();
    let peakArrayBuffers = 0;
    const sampler = setInterval(() => {
      peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers || 0);
    }, 5);
    try {
      await uploadOutput(tempFile, `http://127.0.0.1:${port}/out.mp4`, null);
    } finally {
      clearInterval(sampler);
    }
    // Buffering would put the whole 300 MB here. Generous ceiling so the test
    // fails on a regression in kind, not on allocator noise.
    expect(peakArrayBuffers).toBeLessThan(BODY_BYTES / 4);
  }, 120000);

  it('raises a non-2xx response instead of reporting success', async () => {
    const uploadOutput = loadUploadOutput();
    statusToReturn = 403;
    try {
      await expect(
        uploadOutput(tempFile, `http://127.0.0.1:${port}/out.mp4`, null),
      ).rejects.toThrow(/HTTP 403/);
    } finally {
      statusToReturn = 200;
    }
  }, 120000);

  it('stops when the job is aborted', async () => {
    const uploadOutput = loadUploadOutput();
    const controller = new AbortController();
    const promise = uploadOutput(tempFile, `http://127.0.0.1:${port}/out.mp4`, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow();
  }, 120000);
});

describe('the upload path never buffers', () => {
  it('does not read the file into memory anywhere', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function uploadOutput'),
      SOURCE.indexOf('\nasync function processStitchJob'),
    );
    const code = fn
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/readFile\s*\(/);
    expect(code).not.toMatch(/Buffer\.concat/);
    expect(code).not.toMatch(/arrayBuffer\s*\(/);
  });

  it('does not use fetch, which retains the body even when streamed', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function uploadOutput'),
      SOURCE.indexOf('\nasync function processStitchJob'),
    );
    const code = fn
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).toMatch(/pipelineAsync\s*\(/);
  });

  it('keeps the download path streaming too', () => {
    // Audited alongside: downloads already pipe the response to disk.
    const downloader = fs.readFileSync(path.join(__dirname, '../../src/downloader.js'), 'utf8');
    expect(downloader).toMatch(/pipeline\(res, writeStream\)/);
    expect(downloader).not.toMatch(/res\.arrayBuffer\s*\(/);
  });
});
