'use strict';

/**
 * renderJob.js
 *
 * Core render pipeline. Called by the BullMQ worker for each job.
 *
 * Pipeline:
 *  1. Validate job payload (clip count, duration, transition)
 *  2. Create a temp directory for this job
 *  3. Download all clips + audio (SSRF-guarded, size-limited)
 *  4. Build filter graph → write to filtergraph.txt
 *  5. Run FFmpeg with -filter_complex_script
 *  6. Upload output to the pre-signed Supabase Storage URL
 *  7. Cleanup temp dir (always, in finally block)
 *
 * Hard timeout: an AbortController fires after JOB_TIMEOUT_SECONDS and
 * kills the FFmpeg child process; the job is then marked failed.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const ffmpeg = require('fluent-ffmpeg');
const config = require('./config');
const logger = require('./logger');
const { downloadAll } = require('./downloader');
const { buildFilterGraph, SUPPORTED_TRANSITIONS } = require('./ffmpegBuilder');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validates the job payload at enqueue time.
 * Returns a string error message or null if valid.
 */
function validatePayload(payload) {
  const { clips, audio_url, width, height, fps, transition, transition_duration, format } = payload;

  if (!Array.isArray(clips) || clips.length === 0) return 'clips must be a non-empty array';
  if (clips.length > config.maxClips) return `clip count ${clips.length} exceeds MAX_CLIPS=${config.maxClips}`;

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c.clip_url) return `clips[${i}].clip_url is required`;
    if (typeof c.start !== 'number' || typeof c.end !== 'number') return `clips[${i}].start/end must be numbers`;
    if (c.end <= c.start) return `clips[${i}].end must be greater than start`;
  }

  const totalDuration = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
  if (totalDuration > config.maxDurationSeconds) {
    return `total duration ${totalDuration.toFixed(1)}s exceeds MAX_DURATION_SECONDS=${config.maxDurationSeconds}`;
  }

  if (!audio_url) return 'audio_url is required';
  if (!width || !height || !fps) return 'width, height, and fps are required';
  if (!SUPPORTED_TRANSITIONS.has(transition)) {
    return `transition must be one of: ${[...SUPPORTED_TRANSITIONS].join(', ')}`;
  }
  if (typeof transition_duration !== 'number' || transition_duration <= 0) {
    return 'transition_duration must be a positive number';
  }
  if (!['mp4', 'webm'].includes(format)) return 'format must be "mp4" or "webm"';

  return null; // valid
}

/**
 * Runs FFmpeg using -filter_complex_script and returns a promise that
 * resolves with the final output path or rejects with full stderr.
 *
 * @param {object} params
 * @param {string[]} params.clipPaths      - Local clip file paths (in order)
 * @param {string}   params.audioPath      - Local audio file path
 * @param {string}   params.scriptPath     - filter_complex_script file path
 * @param {string}   params.finalVideoLabel- e.g. '[vout]'
 * @param {string}   params.outputPath     - Absolute path for the output file
 * @param {number}   params.fps
 * @param {AbortSignal} params.signal      - Abort signal (hard timeout)
 */
function runFfmpeg({ clipPaths, audioPath, scriptPath, finalVideoLabel, outputPath, fps, signal }) {
  return new Promise((resolve, reject) => {
    let stderrLines = [];
    let killed = false;

    const cmd = ffmpeg();

    // Add all video clip inputs (full files; trimming is handled inside
    // the filter graph via trim=start:end,setpts=PTS-STARTPTS).
    clipPaths.forEach((p) => {
      cmd.input(p);
    });

    // Add audio input last
    cmd.input(audioPath);

    const audioInputIndex = clipPaths.length;

    // Use the filter_complex_script file
    cmd.addOption('-filter_complex_script', scriptPath);

    // Map the final video label and the audio input
    cmd.outputOptions([
      `-map`, `${finalVideoLabel}`,
      `-map`, `${audioInputIndex}:a`,
      `-c:v`, `libx264`,
      `-pix_fmt`, `yuv420p`,
      `-preset`, `veryfast`,
      `-crf`, `23`,
      `-c:a`, `aac`,
      `-b:a`, `192k`,
      `-movflags`, `+faststart`,
      `-shortest`, // end when the shorter stream ends
    ]);

    cmd.output(outputPath);

    // Capture stderr
    cmd.on('stderr', (line) => {
      stderrLines.push(line);
      // Keep memory bounded during long encodes
      if (stderrLines.length > 5000) stderrLines = stderrLines.slice(-4000);
    });

    cmd.on('error', (err) => {
      const stderrSnippet = stderrLines.join('\n').slice(-2000);
      const enriched = new Error(`FFmpeg error: ${err.message}`);
      enriched.ffmpegStderr = stderrSnippet;
      enriched.killed = killed;
      reject(enriched);
    });

    cmd.on('end', () => {
      resolve(outputPath);
    });

    // Wire abort signal → kill ffmpeg
    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        try {
          cmd.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, { once: true });
    }

    cmd.run();
  });
}

/**
 * Uploads the finished file to a pre-signed URL via HTTP PUT.
 *
 * @param {string} filePath      - Local file path to upload
 * @param {string} uploadUrl     - Pre-signed PUT URL (e.g. Supabase Storage)
 * @param {AbortSignal} signal
 */
async function uploadOutput(filePath, uploadUrl, signal) {
  const stat = await fsp.stat(filePath);
  const fileBuffer = await fsp.readFile(filePath);

  logger.info({ uploadUrl, size: stat.size }, 'Uploading render output');

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
    },
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Upload failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }

  logger.info({ uploadUrl }, 'Upload complete');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * processRenderJob — called by the BullMQ worker processor.
 *
 * @param {import('bullmq').Job} job
 */
async function processRenderJob(job) {
  const payload = job.data;
  const jobId = job.id;

  // ── Validation ──────────────────────────────────────────────────────────
  const validationError = validatePayload(payload);
  if (validationError) throw new Error(`VALIDATION: ${validationError}`);

  const {
    clips,
    audio_url,
    width,
    height,
    fps,
    transition,
    transition_duration,
    output_upload_url,
  } = payload;

  // ── Temp directory ──────────────────────────────────────────────────────
  const tempDir = path.join(config.tempDir, jobId);
  await fsp.mkdir(tempDir, { recursive: true });
  logger.info({ jobId, tempDir }, 'Render job started');

  // ── Hard timeout ─────────────────────────────────────────────────────────
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    logger.warn({ jobId }, 'Job timeout — aborting');
    abortController.abort();
  }, config.jobTimeoutSeconds * 1000);

  const { signal } = abortController;

  try {
    // ── Status: downloading ───────────────────────────────────────────────
    await job.updateData({ ...payload, _status: 'downloading' });
    await job.updateProgress(5);

    const { clipPaths, audioPath } = await downloadAll({
      clips,
      audioUrl: audio_url,
      tempDir,
      signal,
    });

    await job.updateProgress(30);

    // ── Status: rendering ─────────────────────────────────────────────────
    await job.updateData({ ...payload, _status: 'rendering' });

    // Build filter graph script
    const { scriptPath, finalVideoLabel } = buildFilterGraph({
      clips,
      width,
      height,
      fps,
      transition,
      transitionDuration: transition_duration,
      tempDir,
    });

    const outputPath = path.join(tempDir, `output.mp4`);

    // Trim: re-write clipPaths trimmed files so the concat sees the right segment
    // We use FFmpeg input options per clip for trimming before the filter graph.
    // This requires adjusting how we add inputs in runFfmpeg.
    // We trim each clip separately first via a dedicated pre-trim step.
    const trimmedPaths = await trimClips({ clips, clipPaths, tempDir, fps, signal });

    await job.updateProgress(40);

    // Run the main FFmpeg encode
    await runFfmpeg({
      clipPaths: trimmedPaths,
      audioPath,
      scriptPath,
      finalVideoLabel,
      outputPath,
      fps,
      signal,
    });

    await job.updateProgress(85);

    // ── Upload output ─────────────────────────────────────────────────────
    if (output_upload_url) {
      await uploadOutput(outputPath, output_upload_url, signal);
    } else {
      // Fallback: move to OUTPUT_DIR (local volume mount, single-instance only)
      await fsp.mkdir(config.outputDir, { recursive: true });
      const dest = path.join(config.outputDir, `${jobId}.mp4`);
      await fsp.rename(outputPath, dest);
      logger.info({ dest }, 'Output stored locally (no upload URL provided)');
    }

    await job.updateProgress(100);
    await job.updateData({ ...payload, _status: 'completed' });

    logger.info({ jobId }, 'Render job completed');
    return { status: 'completed', outputUploadUrl: output_upload_url ?? null };

  } catch (err) {
    // Signal abort — distinguish timeout from other failures
    const isTimeout = signal.aborted && !err.ffmpegStderr?.includes('Killed');
    const errorMessage = isTimeout
      ? `Job timed out after ${config.jobTimeoutSeconds}s`
      : err.message;

    logger.error({ jobId, err: err.message, ffmpegStderr: err.ffmpegStderr }, 'Render job failed');

    // Store failure details so GET /jobs/:id can surface them
    await job.updateData({
      ...payload,
      _status: 'failed',
      _error: errorMessage,
      _ffmpegStderr: err.ffmpegStderr ? err.ffmpegStderr.slice(-2000) : null,
    });

    throw err; // Re-throw so BullMQ marks the job as failed
  } finally {
    clearTimeout(timeoutHandle);
    // Always clean up temp files
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
      logger.debug({ jobId, tempDir }, 'Temp directory cleaned up');
    } catch (cleanupErr) {
      logger.warn({ jobId, cleanupErr: cleanupErr.message }, 'Temp cleanup warning');
    }
  }
}

/**
 * Trims each clip to [start, end] using a fast FFmpeg copy-stream pass,
 * producing a trimmed file that the main filter graph then processes.
 * This is cleaner than chaining trim inside the already-complex filter graph.
 *
 * @param {object} params
 * @param {Array<{start:number, end:number}>} params.clips
 * @param {string[]} params.clipPaths
 * @param {string}   params.tempDir
 * @param {number}   params.fps    - (unused, trimming only)
 * @param {AbortSignal} params.signal
 * @returns {Promise<string[]>}    - Paths to the trimmed clip files
 */
async function trimClips({ clips, clipPaths, tempDir, signal }) {
  const trimmedPaths = [];

  for (let i = 0; i < clips.length; i++) {
    const { start, end } = clips[i];
    const src = clipPaths[i];
    const dest = path.join(tempDir, `trimmed_${i}.mp4`);

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(src)
        .setStartTime(start)
        .duration(end - start)
        .outputOptions([
          '-c:v', 'copy', // fast stream-copy for trim
          '-c:a', 'copy',
          '-avoid_negative_ts', 'make_zero',
        ])
        .output(dest);

      let stderrLines = [];
      cmd.on('stderr', (l) => stderrLines.push(l));
      cmd.on('error', (err) => {
        const enriched = new Error(`Trim failed for clip ${i}: ${err.message}`);
        enriched.ffmpegStderr = stderrLines.join('\n').slice(-2000);
        reject(enriched);
      });
      cmd.on('end', resolve);

      if (signal?.aborted) {
        reject(new Error('Aborted before trim'));
        return;
      }
      signal?.addEventListener('abort', () => {
        try { cmd.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error('Trim aborted by timeout'));
      }, { once: true });

      cmd.run();
    });

    trimmedPaths.push(dest);
  }

  return trimmedPaths;
}

module.exports = { processRenderJob, validatePayload };
