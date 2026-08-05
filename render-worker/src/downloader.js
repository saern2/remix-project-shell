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
// Bounded probe: verifying a leftover file must never be the thing that hangs.
// A truncated or zero-byte file is exactly the input on which an unbounded
// ffprobe can block indefinitely (round 7, Problem 2a).
const { decodesSuccessfully } = require('./mediaProbe');

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

const cdnSemaphore = new Semaphore(config.globalCdnConcurrency || 4);

function isCdnUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host.includes('pexels.com') ||
      host.includes('pixabay.com') ||
      host === 'images-api.nasa.gov' ||
      host === 'images-assets.nasa.gov';
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
  const startTime = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      let bytesWritten = 0;
      let expectedBytes = null;
      let finished = false;
      let activeReq = null;
      let lastProgressTime = Date.now();

      // Stall timeout: abort only when no bytes have arrived for stallMs, so a
      // slow-but-progressing transfer is allowed to finish (round 6, Issue 3).
      // maxMs is an absolute backstop regardless of progress.
      const stallMs = Math.max(1000, config.downloadStallTimeoutSeconds * 1000);
      const maxMs = Math.max(stallMs, config.downloadMaxSeconds * 1000);

      let stallTimer = null;
      let maxTimer = null;

      const clearTimers = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      };

      // Reject with a message that distinguishes "nothing ever arrived" from
      // "90% complete when the clock ran out" (round 6, Issue 3.4).
      const failWith = (reason) => {
        if (finished) return;
        finished = true;
        clearTimers();
        try { activeReq?.destroy(); } catch { /* already destroyed */ }
        const elapsedMs = Date.now() - startTime;
        const mbps = elapsedMs > 0 ? (bytesWritten / (1024 * 1024)) / (elapsedMs / 1000) : 0;
        reject(new Error(
          `Download ${reason} for ${url}: received ${bytesWritten} of ` +
          `${expectedBytes ?? 'unknown'} bytes in ${elapsedMs}ms (${mbps.toFixed(2)} MB/s)`
        ));
      };

      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          const idleS = Math.round((Date.now() - lastProgressTime) / 1000);
          failWith(`stalled (no bytes for ${idleS}s)`);
        }, stallMs);
        stallTimer.unref?.();
      };

      if (signal?.aborted) {
        return reject(new Error('Download aborted before start'));
      }

      // A single abort handler for this download — destroys whichever request is
      // currently active (survives redirects without leaking listeners).
      abortHandler = () => failWith('aborted');
      signal?.addEventListener('abort', abortHandler);

      maxTimer = setTimeout(
        () => failWith(`exceeded absolute ceiling of ${config.downloadMaxSeconds}s`),
        maxMs,
      );
      maxTimer.unref?.();
      armStallTimer();

      function doRequest(requestUrl, redirectCount = 0) {
        if (redirectCount > 5) {
          finished = true;
          clearTimers();
          return reject(new Error(`Too many redirects for URL: ${url}`));
        }

        const parsedReq = new URL(requestUrl);
        const mod = parsedReq.protocol === 'https:' ? https : http;

        const req = mod.get(requestUrl, {}, (res) => {
          // Handle redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, requestUrl).href;
            try { assertAllowedUrl(redirectUrl); } catch (e) {
              if (!finished) { finished = true; clearTimers(); reject(e); }
              return;
            }
            res.resume(); // consume and discard redirect body
            return doRequest(redirectUrl, redirectCount + 1);
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            if (!finished) {
              finished = true;
              clearTimers();
              reject(new Error(`HTTP ${res.statusCode} downloading: ${url}`));
            }
            return;
          }

          // Pre-check Content-Length against the ceiling. This is where an
          // oversized source clip (e.g. a 986 MB variant) is rejected fast with
          // a clear message instead of timing out mid-transfer (round 6, Issue 1.5).
          const cl = parseInt(res.headers['content-length'] ?? '0', 10);
          expectedBytes = Number.isFinite(cl) && cl > 0 ? cl : null;
          if (cl > maxBytes) {
            res.destroy();
            if (!finished) {
              finished = true;
              clearTimers();
              reject(new Error(
                `Download rejected: Content-Length ${cl} exceeds per-file limit ${maxBytes} for: ${url}`
              ));
            }
            return;
          }

          const writeStream = fs.createWriteStream(destPath);

          res.on('data', (chunk) => {
            bytesWritten += chunk.length;
            lastProgressTime = Date.now();
            armStallTimer();
            if (bytesWritten > maxBytes) {
              res.destroy();
              writeStream.destroy();
              if (!finished) {
                finished = true;
                clearTimers();
                reject(new Error(`Download exceeded max size ${maxBytes} bytes for: ${url}`));
              }
            }
          });

          pipeline(res, writeStream)
            .then(() => {
              if (!finished) {
                finished = true;
                clearTimers();
                const elapsedMs = Date.now() - startTime;
                const mbps = elapsedMs > 0
                  ? (bytesWritten / (1024 * 1024)) / (elapsedMs / 1000)
                  : 0;
                logger.info(
                  { url, destPath, bytes: bytesWritten, elapsedMs, mbps: Number(mbps.toFixed(2)) },
                  'Download complete',
                );
                resolve(bytesWritten);
              }
            })
            .catch((err) => {
              if (!finished) {
                finished = true;
                clearTimers();
                reject(new Error(`Stream error downloading ${url}: ${err.message}`));
              }
            });
        });

        activeReq = req;

        req.on('error', (err) => {
          if (!finished) {
            finished = true;
            clearTimers();
            reject(new Error(`Network error downloading ${url}: ${err.message}`));
          }
        });
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
// ── Completed-download markers (round 6, Issue 4) ───────────────────────────
// Same shape as resourceControl.js's `.ready` marker for finished chunk output:
// the payload file alone proves nothing (a half-written file also exists), so a
// sibling marker records that the transfer ran to completion, and what it
// produced. Reuse requires the marker, a matching size, and a successful probe.
const markerPathFor = (destPath) => `${destPath}.ok`;

async function markDownloadComplete(destPath, url, bytes) {
  const marker = JSON.stringify({ url, bytes, completedAt: new Date().toISOString() });
  await fsp.writeFile(markerPathFor(destPath), marker, 'utf8').catch(() => {});
}

async function isCompleteDownload(destPath, url) {
  try {
    const [raw, stat] = await Promise.all([
      fsp.readFile(markerPathFor(destPath), 'utf8'),
      fsp.stat(destPath),
    ]);
    const marker = JSON.parse(raw);
    if (marker.url !== url) return false;
    if (!stat.isFile() || stat.size === 0 || stat.size !== marker.bytes) return false;
    return await decodesSuccessfully(destPath);
  } catch {
    return false;
  }
}

async function downloadAll({ clips, fallbackIndices = [], audioUrl, tempDir, signal }) {
  let totalBytes = 0;
  const clipPaths = new Map();

  // ── Abort fan-out (round 6, Issue 5) ────────────────────────────────────────
  // Give each download its own child AbortController and attach exactly ONE
  // listener to the parent signal, which aborts every active child. This keeps
  // the parent's listener count at 1 regardless of how many clips download
  // concurrently, instead of one listener per in-flight download (which tripped
  // MaxListenersExceededWarning on every chunk start).
  const childControllers = new Set();
  const onParentAbort = () => {
    for (const c of childControllers) {
      try { c.abort(); } catch { /* already aborted */ }
    }
  };
  if (signal) signal.addEventListener('abort', onParentAbort, { once: true });

  const downloadTask = async (url, destPath, maxBytes) => {
    const child = new AbortController();
    if (signal?.aborted) child.abort();
    childControllers.add(child);
    try {
      const bytes = await downloadFile(url, destPath, { maxBytes, signal: child.signal });
      totalBytes += bytes;
      if (totalBytes > config.maxDownloadBytes) {
        throw new Error(`Total download size exceeds limit of ${config.maxDownloadBytes} bytes`);
      }
      return bytes;
    } finally {
      childControllers.delete(child);
    }
  };

  try {
    const tasks = [];

    // Audio task — audio uses the generous whole-job ceiling, not the per-clip one.
    let audioPath = null;
    if (audioUrl) {
      tasks.push(async () => {
        let audioExt = '.mp3';
        try { audioExt = path.extname(new URL(audioUrl).pathname) || '.mp3'; } catch {}
        audioPath = path.join(tempDir, `audio${audioExt}`);
        await downloadTask(audioUrl, audioPath, config.maxDownloadBytes);
      });
    }

    // ── Intra-batch URL de-duplication (round 6, Issue 4.2) ───────────────────
    // Two clips in the same chunk that need the same source URL share a single
    // download rather than fetching it twice. The first index owning a URL does
    // the fetch; the rest reuse its local path once it lands.
    const urlToPrimaryIndex = new Map();
    let dedupedDownloads = 0;
    const primaryIndices = [];
    for (const i of fallbackIndices) {
      const { clip_url } = clips[i];
      if (urlToPrimaryIndex.has(clip_url)) {
        dedupedDownloads += 1;
        continue;
      }
      urlToPrimaryIndex.set(clip_url, i);
      primaryIndices.push(i);
    }

    let reusedDownloads = 0;
    for (const i of primaryIndices) {
      tasks.push(async () => {
        const { clip_url } = clips[i];
        let ext = '.mp4';
        try { ext = path.extname(new URL(clip_url).pathname) || '.mp4'; } catch {}
        const destPath = path.join(tempDir, `clip_${i}${ext}`);

        // ── Retry reuse (round 6, Issue 4) ────────────────────────────────────
        // A chunk that fails keeps its downloads, and BullMQ retries the same
        // jobId into the same tempDir. Re-fetching ~420 MB that is already on
        // disk was the single largest source of wasted bandwidth per render.
        // A file is only reused if its completion marker matches its size AND
        // it still decodes — a truncated or corrupt file must not be trusted
        // just because it exists.
        if (await isCompleteDownload(destPath, clip_url)) {
          reusedDownloads += 1;
          logger.info({ url: clip_url, destPath }, 'Reusing clip already downloaded by a prior attempt');
        } else {
          await fsp.rm(markerPathFor(destPath), { force: true }).catch(() => {});
          const bytes = await downloadTask(clip_url, destPath, config.maxClipBytes);
          await markDownloadComplete(destPath, clip_url, bytes);
        }

        // Point every index that shares this URL at the single downloaded file.
        for (const j of fallbackIndices) {
          if (clips[j].clip_url === clip_url) clipPaths.set(j, destPath);
        }
      });
    }

    // The global CDN semaphore is the real cap on concurrent transfers; keep the
    // local pool no wider than that so we don't spin up idle child controllers.
    const poolConcurrency = Math.max(1, config.globalCdnConcurrency || 4);
    await asyncPool(poolConcurrency, tasks, (t) => t());

    logger.info(
      {
        totalBytes,
        fallbackCount: fallbackIndices.length,
        uniqueDownloads: primaryIndices.length,
        dedupedDownloads,
        reusedDownloads,
      },
      'Required assets downloaded',
    );
    return { clipPaths, audioPath };
  } finally {
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

module.exports = { downloadFile, downloadAll, preFlightCheckUrl, assertAllowedUrl, asyncPool };
