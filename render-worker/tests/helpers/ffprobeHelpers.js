'use strict';

/**
 * tests/helpers/ffprobeHelpers.js
 *
 * Utilities for asserting FFmpeg output file properties in tests.
 */

const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');

const ffprobeAsync = promisify(ffmpeg.ffprobe);

/**
 * Returns ffprobe metadata for a file.
 * @param {string} filePath
 * @returns {Promise<object>} ffprobe metadata
 */
async function probe(filePath) {
  return ffprobeAsync(filePath);
}

/**
 * Asserts that a video file has the expected dimensions and frame rate.
 * Throws an AssertionError (jest expect) if any property mismatches.
 *
 * @param {string} filePath
 * @param {{ width: number, height: number, fps: number }} expected
 */
async function assertVideoProperties(filePath, { width, height, fps }) {
  const meta = await probe(filePath);
  const videoStream = meta.streams.find((s) => s.codec_type === 'video');

  if (!videoStream) throw new Error(`No video stream found in: ${filePath}`);

  expect(videoStream.width).toBe(width);
  expect(videoStream.height).toBe(height);

  // r_frame_rate is a fraction string e.g. "30/1" or "30000/1001"
  const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
  const actualFps = num / den;
  expect(actualFps).toBeCloseTo(fps, 0); // within 1 fps
}

/**
 * Asserts that a file exists and has non-zero size.
 * @param {string} filePath
 */
async function assertFileNonEmpty(filePath) {
  const fs = require('fs/promises');
  const stat = await fs.stat(filePath);
  expect(stat.size).toBeGreaterThan(0);
}

/**
 * Counts decoded video frames. Decodes the file rather than trusting the
 * container's nb_frames header, because the header is exactly what a
 * frame-accuracy test must not take on faith.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countFrames(filePath) {
  const { execFile } = require('child_process');
  const { promisify: p } = require('util');
  const run = p(execFile);
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'csv=p=0',
    filePath,
  ]);
  return Number(String(stdout).trim());
}

module.exports = { probe, assertVideoProperties, assertFileNonEmpty, countFrames };
