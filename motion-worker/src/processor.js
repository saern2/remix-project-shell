/**
 * Parent side of one motion job: spawn the child, feed it the key over
 * stdin, relay its progress, upload the MP4, and delete the job directory
 * on EVERY exit path — the first layer of temp discipline (D6), because
 * Anymotion preserves frame directories on failure by design and one job's
 * frames are 2-3.5 GB.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { decryptKey } from './keyCrypto.js';
import { uploadFile } from './uploader.js';
import { recordJobSeconds } from './jobStats.js';
import { MotionJobFailure } from './failures.js';

const RUN_JOB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runJob.js');

/** Env for the child: the per-job workspace and NOTHING resembling a key.
 * loadConfig() harvests ~20 *_API_KEY variables from the environment; the
 * container carries none, and this allowlist keeps it that way even if one
 * ever leaks into the parent's env. */
function childEnv(jobDir) {
  return {
    PATH: process.env.PATH,
    HOME: jobDir,
    ANYMOTION_HOME: path.join(jobDir, '.anymotion'),
    ANYMOTION_PROJECTS_DIR: path.join(jobDir, 'projects'),
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    TMPDIR: jobDir,
  };
}

export async function processMotionJob(job, { redis, logger = console }) {
  const jobDir = path.join(config.tmpDir, String(job.id));
  fs.mkdirSync(jobDir, { recursive: true });
  const startedAt = Date.now();

  try {
    const apiKey = decryptKey(job.data.key_ct, config.keySecret);

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RUN_JOB], {
        cwd: jobDir,
        env: childEnv(jobDir),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // SIGTERM backstop (D3): the clean AbortController path lives inside
      // the child; this fires only if the child itself hangs past the cap.
      const backstop = setTimeout(() => {
        logger.error(`[motion] job ${job.id}: child passed the wall clock and its grace — SIGTERM`);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 30_000).unref?.();
      }, (config.wallClockSeconds + 120) * 1000);
      backstop.unref?.();

      let settled = false;
      let failureMessage = null;
      let resultLine = null;
      let buffer = '';

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // Anymotion logs freely to stdout; only our JSON lines count.
          }
          if (event.type === 'progress') {
            const pct =
              event.phase === 'generating' && event.maxTurns
                ? Math.min(80, Math.round((event.turn / event.maxTurns) * 80))
                : event.phase === 'rendering'
                  ? 80 + Math.round(((event.percent ?? 0) / 100) * 15)
                  : 0;
            job.updateProgress(pct).catch(() => {});
          } else if (event.type === 'result') {
            resultLine = event;
          } else if (event.type === 'failure') {
            failureMessage = event.message;
          }
        }
      });
      child.stderr.on('data', () => {}); // drained so the child never blocks

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        reject(new MotionJobFailure(
          `The explainer worker could not start the job process. Please try again. (internal: ${err.message})`,
        ));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        if (code === 0 && resultLine?.mp4Path) return resolve(resultLine);
        reject(new MotionJobFailure(
          failureMessage ??
            `The explainer job stopped unexpectedly. Nothing was saved — please try again. (internal: exit code ${code})`,
        ));
      });

      // The key's only route into the child (D2): stdin, then closed.
      child.stdin.write(
        JSON.stringify({
          brief: job.data.brief,
          model: job.data.model,
          apiKey,
          maxTurns: config.maxTurns,
          wallClockSeconds: config.wallClockSeconds,
        }) + '\n',
      );
      child.stdin.end();
    });

    job.updateProgress(96).catch(() => {});
    const mp4Bytes = await uploadFile(result.mp4Path, job.data.upload_url);

    const wallSeconds = Math.round((Date.now() - startedAt) / 1000);
    await recordJobSeconds(redis, wallSeconds);
    await job.updateProgress(100).catch(() => {});
    return { mp4_bytes: mp4Bytes, wall_seconds: wallSeconds, turns: result.turns ?? null };
  } finally {
    // The ciphertext has done its job either way; the bounded failed-job
    // record keeps the message, not the key material.
    await job.updateData({ ...job.data, key_ct: null }).catch(() => {});
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`[motion] job ${job.id}: temp cleanup failed: ${err.message}`);
    }
  }
}
