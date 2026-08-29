/**
 * Orphan sweep (V6/D6) — the second layer of temp discipline.
 *
 * Anymotion keeps frame directories on every failure path BY DESIGN
 * (video-renderer.js removes them only when stitched === true, and
 * deliberately preserves them on ffmpeg failure) — at 2-3.5 GB per job,
 * that alone reproduces the 6.2 GB orphan class the render worker cleaned
 * up after the August incident. The first layer is the processor's
 * per-job `finally` delete; this sweep catches what a SIGKILL or a crashed
 * parent leaves behind.
 *
 * THE LIVE-JOB GUARD, non-negotiable (the render worker's lesson: its
 * janitor once deleted 968 MB belonging to still-waiting projects, judging
 * by mtime alone): a directory is swept only when it is older than the
 * grace window AND its job id is not live. Job dirs are named by job id,
 * which is what makes the guard checkable.
 */

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

/**
 * @param {object} deps { tmpDir, graceMs, isJobLive(jobId): Promise<boolean>, now() }
 * @returns {Promise<{swept: string[], kept: string[]}>}
 */
export async function sweepOrphans(deps) {
  const tmpDir = deps.tmpDir ?? config.tmpDir;
  const graceMs = deps.graceMs ?? config.sweepGraceMs;
  const now = deps.now ? deps.now() : Date.now();
  const swept = [];
  const kept = [];

  let entries = [];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { swept, kept };
  }

  for (const entry of entries) {
    const dir = path.join(tmpDir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < graceMs) {
      kept.push(entry.name);
      continue;
    }
    // The guard: age alone never decides. When liveness cannot be
    // determined, keep — disk is recoverable, a running job is not.
    let live = true;
    try {
      live = await deps.isJobLive(entry.name);
    } catch {
      live = true;
    }
    if (live) {
      kept.push(entry.name);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      swept.push(entry.name);
    } catch {
      kept.push(entry.name);
    }
  }
  return { swept, kept };
}
