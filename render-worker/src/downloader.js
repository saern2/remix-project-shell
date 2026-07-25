'use strict';

/**
 * downloader.js
 *
 * Downloads remote files (clips, audio) using Node's built-in http/https
 * modules (no third-party ESM dependencies — fully CJS compatible).
 *
 * Features:
 *  - SSRF hostname allowlist check (pre-fetch, validates after redirects too)
 *  - Content-Length pre-check + streaming byte counter guard
 *  - Configurable per-file and cumulative download size limits
 *  - Timeout via AbortController
 *  - Streaming write to disk (no large buffers in memory)
 *  - file:// URL support for local test fixtures
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { URL } = require('url');

const config = require('./config');
const logger = require('./logger');

// ─── Global CDN Concurrency Limiter ───────────────────────────────────────────

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise(resolve => {
      this.waiting.push(resolve);
    });
  }

  release() {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      next();
    } else {
      this.active--;
    }
  }
}

const cdnSemaphore = new Semaphore(config.globalCdnConcurrency || 15);

function isCdnUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host.includes('pexels.com') || host.includes('pixabay.com');
  } catch {
    return false;
  }
}

// ─── SSRF Guard ───────────────────────────────────────────────────────────────

/**
 * Validates a URL against the SSRF allowlist.
 * Throws with an SSRF_BLOCK prefix if the host is not allowed.
 *
 * @param {string} rawUrl
 */
function assertAllowedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF_BLOCK: Malformed URL rejected: ${rawUrl}`);
  }

  // file:// URLs are only used by local test fixtures — no network SSRF risk
  if (parsed.protocol === 'file:') return;

  if (config.urlAllowlist.length === 0) {
    logger.warn({ url: rawUrl }, 'URL_ALLOWLIST is empty — SSRF protection disabled. Set in production.');
    return;
  }

  const host = parsed.hostname.toLowerCase();

  const allowed = config.urlAllowlist.some(
    (entry) => host === entry || host.endsWith(`.${entry}`)
  );

  if (!allowed) {
    throw new Error(
      `SSRF_BLOCK: Host "${host}" is not on the URL allowlist. ` +
      `Allowed: [${config.urlAllowlist.join(', ')}]`
    );
  }
}

// ─── Core download ────────────────────────────────────────────────────────────

/**
 * Downloads a single URL to a local file path.
 * Supports http://, https://, and file:// URLs.
 *
 * @param {string} url            - Remote URL to download
 * @param {string} destPath       - Absolute local path to write to
 * @param {object} opts
 * @param {number} [opts.maxBytes]  - Per-file byte ceiling
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<number>}       - Actual bytes written
 */
async function downloadFile(url, destPath, { maxBytes = config.maxDownloadBytes, signal } = {}) {
  assertAllowedUrl(url);

  const parsed = new URL(url);

  // ── Local file:// shortcut (for tests) ────────────────────────────────────
  if (parsed.protocol === 'file:') {
    const srcPath = decodeURIComponent(parsed.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    await fsp.copyFile(srcPath, destPath);
    const stat = await fsp.stat(destPath);
    logger.debug({ url, destPath, bytes: stat.size }, 'Copied local file');
    return stat.size;
  }

  // ── HTTP/HTTPS download ───────────────────────────────────────────────────
  logger.debug({ url, destPath }, 'Downloading file');

  const requiresSemaphore = isCdnUrl(url);
  if (requiresSemaphore) {
    await cdnSemaphore.acquire();
  }

  let abortHandler;
  try {
    return await new Promise((resolve, reject) => {
      let bytesWritten = 0;
      let finished = false;
      const timeoutMs = config.downloadTimeoutSeconds * 1000;

    // Track abort signal
    if (signal?.aborted) {
      return reject(new Error('Download aborted before start'));
    }

    function doRequest(requestUrl, redirectCount = 0) {
      if (redirectCount > 5) {
        return reject(new Error(`Too many redirects for URL: ${url}`));
      }

      const parsedReq = new URL(requestUrl);
      const mod = parsedReq.protocol === 'https:' ? https : http;

      const req = mod.get(requestUrl, { signal }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, requestUrl).href;
          try { assertAllowedUrl(redirectUrl); } catch (e) { return reject(e); }
          res.resume(); // consume and discard redirect body
          return doRequest(redirectUrl, redirectCount + 1);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading: ${url}`));
        }

        // Pre-check Content-Length
        const cl = parseInt(res.headers['content-length'] ?? '0', 10);
        if (cl > maxBytes) {
          res.destroy();
          return reject(new Error(
            `Download rejected: Content-Length ${cl} exceeds limit ${maxBytes} for: ${url}`
          ));
        }

        const writeStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            res.destroy();
            writeStream.destroy();
            if (!finished) {
              finished = true;
              reject(new Error(`Download exceeded max size ${maxBytes} bytes for: ${url}`));
            }
          }
        });

        pipeline(res, writeStream)
          .then(() => {
            if (!finished) {
              finished = true;
              logger.debug({ url, destPath, bytesWritten }, 'Download complete');
              resolve(bytesWritten);
            }
          })
          .catch((err) => {
            if (!finished) {
              finished = true;
              reject(new Error(`Stream error downloading ${url}: ${err.message}`));
            }
          });
      });

      // Timeout
      const timer = setTimeout(() => {
        req.destroy(new Error(`Download timed out after ${timeoutMs}ms for: ${url}`));
      }, timeoutMs);

      req.on('error', (err) => {
        clearTimeout(timer);
        if (!finished) {
          finished = true;
          reject(new Error(`Network error downloading ${url}: ${err.message}`));
        }
      });

      req.on('close', () => clearTimeout(timer));

      // Wire abort signal — handler captured in outer scope for cleanup in finally
      abortHandler = () => req.destroy(new Error('Download aborted'));
      signal?.addEventListener('abort', abortHandler);
    }

    doRequest(url);
  });
  } finally {
    if (abortHandler && signal) {
      signal.removeEventListener('abort', abortHandler);
    }
    if (requiresSemaphore) {
      cdnSemaphore.release();
    }
  }
}

/**
 * Executes tasks concurrently up to a given limit.
 * @param {number} concurrency
 * @param {Array<T>} items
 * @param {(item: T) => Promise<R>} iteratorFn
 * @returns {Promise<R[]>}
 */
async function asyncPool(concurrency, items, iteratorFn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

/**
 * Checks if a URL is reachable and supports HTTP Range requests.
 * Resolves to true if supported, false otherwise.
 * @param {string} url
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<boolean>}
 */
async function preFlightCheckUrl(url, { signal } = {}) {
  try {
    assertAllowedUrl(url);
    const parsed = new URL(url);
    // Send file:// URLs to the fallback downloader so they are copied to tempDir
    if (parsed.protocol === 'file:') return false;
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    let finished = false;
    const timeoutMs = 5000; // fast fail for pre-flight

    if (signal?.aborted) return resolve(false);

    function doCheck(requestUrl, redirectCount = 0) {
      if (redirectCount > 5) return resolve(false);

      const parsedReq = new URL(requestUrl);
      const mod = parsedReq.protocol === 'https:' ? https : http;

      const req = mod.get(requestUrl, {
        headers: { 'Range': 'bytes=0-1' },
        signal
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, requestUrl).href;
          res.resume();
          return doCheck(redirectUrl, redirectCount + 1);
        }

        res.destroy(); // we only care about the headers
        if (res.statusCode === 206) {
          resolve(true);
        } else {
          // If 200, range is not supported (it sent the whole file). Any other code is an error.
          resolve(false);
        }
      });

      const timer = setTimeout(() => {
        req.destroy();
        if (!finished) resolve(false);
      }, timeoutMs);

      req.on('error', () => {
        clearTimeout(timer);
        if (!finished) resolve(false);
      });

      req.on('close', () => clearTimeout(timer));

      signal?.addEventListener('abort', () => {
        req.destroy();
      }, { once: true });
    }

    doCheck(url);
  });
}

/**
 * Downloads audio and specifically requested fallback clips into a temp directory.
 * Accumulates total bytes and rejects if the total exceeds maxDownloadBytes.
 * Uses bounded concurrency.
 *
 * @param {object} params
 * @param {Array<{clip_url:string, start:number, end:number}>} params.clips
 * @param {number[]} params.fallbackIndices
 * @param {string} params.audioUrl
 * @param {string} params.tempDir
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{clipPaths: Map<number, string>, audioPath: string|null}>}
 */
async function downloadAll({ clips, fallbackIndices = [], audioUrl, tempDir, signal }) {
  let totalBytes = 0;
  const clipPaths = new Map();

  const downloadTask = async (url, destPath) => {
    const bytes = await downloadFile(url, destPath, { signal });
    totalBytes += bytes;
    if (totalBytes > config.maxDownloadBytes) {
      throw new Error(`Total download size exceeds limit of ${config.maxDownloadBytes} bytes`);
    }
  };

  const tasks = [];

  // Audio task
  let audioPath = null;
  if (audioUrl) {
    tasks.push(async () => {
      let audioExt = '.mp3';
      try { audioExt = path.extname(new URL(audioUrl).pathname) || '.mp3'; } catch {}
      audioPath = path.join(tempDir, `audio${audioExt}`);
      await downloadTask(audioUrl, audioPath);
    });
  }

  // Fallback clips tasks
  for (const i of fallbackIndices) {
    tasks.push(async () => {
      const { clip_url } = clips[i];
      let ext = '.mp4';
      try { ext = path.extname(new URL(clip_url).pathname) || '.mp4'; } catch {}
      const destPath = path.join(tempDir, `clip_${i}${ext}`);
      
      await downloadTask(clip_url, destPath);
      clipPaths.set(i, destPath);
    });
  }

  // Execute concurrently with max 8 parallel downloads
  await asyncPool(8, tasks, (t) => t());

  logger.info({ totalBytes, fallbackCount: fallbackIndices.length }, 'Required assets downloaded');
  return { clipPaths, audioPath };
}

module.exports = { downloadFile, downloadAll, preFlightCheckUrl, assertAllowedUrl, asyncPool };
