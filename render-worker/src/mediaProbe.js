'use strict';

/**
 * mediaProbe.js — ffprobe with a hard deadline.
 *
 * fluent-ffmpeg's `ffprobe` spawns a child and resolves on exit. It has NO
 * timeout and does not expose the child handle, so an ffprobe that never exits
 * (a truncated container, a file still being written, a pathological stream)
 * leaves an un-settleable promise and hangs whatever awaited it — indefinitely,
 * with the worker alive and BullMQ's lock happily renewing.
 *
 * Spawning ffprobe directly gives both things fluent-ffmpeg withholds: a
 * `timeout` that fires, and a `killSignal` that actually reaps the child.
 * Every probe in this worker goes through here.
 */

const { execFile } = require('child_process');
const logger = require('./logger');

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/** Tracks live probe children so a watchdog can reap them on expiry. */
const activeProbes = new Set();

function killActiveProbes() {
  let killed = 0;
  for (const child of activeProbes) {
    try {
      child.kill('SIGKILL');
      killed += 1;
    } catch {
      // already gone
    }
  }
  return killed;
}

/**
 * Runs ffprobe against a file and returns parsed JSON, or null when the probe
 * fails, times out, or returns something unparseable.
 *
 * Never throws: callers treat null as "unknown" and decide for themselves.
 * A probe that cannot answer must not be the thing that fails a render.
 *
 * @param {string} filePath
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<object|null>}
 */
function probeMedia(filePath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type,duration,nb_frames',
        '-of', 'json',
        filePath,
      ],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, signal },
      (err, stdout) => {
        activeProbes.delete(child);
        if (err) {
          // ETIMEDOUT / ABORT_ERR are the interesting ones: the file is
          // pathological, or a watchdog reaped us. Both mean "unknown".
          logger.warn(
            {
              filePath,
              elapsedMs: Date.now() - startedAt,
              timeoutMs,
              err: err.message,
              killed: err.killed === true,
            },
            'ffprobe did not complete; treating duration as unknown',
          );
          return resolve(null);
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
    activeProbes.add(child);
  });
}

/**
 * Duration in seconds, or null if it cannot be determined within the deadline.
 */
async function probeDurationSeconds(filePath, options) {
  const data = await probeMedia(filePath, options);
  const duration = Number(data?.format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/**
 * True when the file has a video stream of non-zero duration — i.e. it is a
 * usable source rather than a truncated or empty leftover.
 */
async function decodesSuccessfully(filePath, options) {
  const data = await probeMedia(filePath, options);
  if (!data) return false;
  const hasVideo = (data.streams ?? []).some((s) => s.codec_type === 'video');
  const duration = Number(data.format?.duration);
  return hasVideo && Number.isFinite(duration) && duration > 0;
}

module.exports = {
  probeMedia,
  probeDurationSeconds,
  decodesSuccessfully,
  killActiveProbes,
  DEFAULT_PROBE_TIMEOUT_MS,
};
