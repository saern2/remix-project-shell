'use strict';

/**
 * The safety net for work that leaves the runnable path without telling anyone.
 *
 * EVERY ALARM THIS WORKER OWNS WATCHES RUNNING WORK. The chunk watchdog arms
 * when a chunk starts. Stall notices track active chunks. BullMQ's stalled
 * detection needs a lock to go missing. The stitch parent waits on its children
 * without ever asking whether they still exist. Work that stops running is
 * invisible to all of them, which is how four projects sat one chunk from done
 * for five hours on an idle machine and nothing anywhere said a word.
 *
 * That is the second time this shape has cost hours — the matching idle-loop was
 * the first — and both had the same character: a state that was correct,
 * terminal and unobserved. The specific door in this case (a failed child never
 * resolving its parent's dependency) is closed in chunkRecovery.js. This closes
 * the CLASS: whatever door a chunk leaves through next, the parent notices
 * within minutes and says so.
 *
 * The check is deliberately from the parent's point of view rather than the
 * database's. `getDependencies()` names exactly which children a parent is still
 * waiting on, which is authoritative, cheap, and immune to the guessing that
 * counting rows invites — `removeOnComplete: 100` means a finished chunk job may
 * no longer exist, so "the job is gone" cannot mean "the chunk is missing".
 *
 * TWO CONSECUTIVE SWEEPS before acting. A single sweep races normal operation:
 * a chunk between `failed` and its requeue, or mid-move between states, would
 * look missing for a few milliseconds. Requiring the same project to look wrong
 * twice, minutes apart, costs one interval of latency on a real stall and
 * removes every false positive that transient states could produce.
 */

const { Job } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { recoverFailedChunk } = require('./chunkRecovery');

/** Cheap enough to run often; long enough that two sweeps still beat a human. */
const RECONCILE_INTERVAL_MS = 150_000;

/**
 * Sweeps a project must look wrong for before anything is touched.
 * See the header: this is the entire defence against acting on a race.
 */
const CONFIRMATIONS_BEFORE_ACTION = 2;

/**
 * How many times a project may be reconciled before it is declared broken.
 *
 * Without this the reconciler becomes its own silent loop — the failure it
 * exists to prevent, wearing its uniform.
 */
const MAX_RECONCILES_PER_PROJECT = 3;

/** projectId -> consecutive sweeps seen unhealthy, and repairs attempted. */
const seen = new Map();

/** The chunk ids a parent is still waiting on, with their current state. */
async function inspectDependencies(stitchJob, chunkQueue) {
  const deps = await stitchJob.getDependencies();
  const unprocessed = deps?.unprocessed ?? [];

  const failed = [];
  const missing = [];
  let runnable = 0;

  for (const key of unprocessed) {
    // Dependency keys look like `bull:<queue>:<jobId>`; the id is the tail.
    const chunkId = String(key).split(':').pop();
    const chunkJob = await Job.fromId(chunkQueue, chunkId).catch(() => null);
    if (!chunkJob) {
      missing.push(chunkId);
      continue;
    }
    const state = await chunkJob.getState().catch(() => 'unknown');
    if (state === 'failed') failed.push(chunkJob);
    else if (state === 'unknown') missing.push(chunkId);
    else runnable += 1;
  }

  return { failed, missing, runnable, unprocessedCount: unprocessed.length };
}

/**
 * Marks a project as beyond automatic repair.
 *
 * Writes the verdict into the stitch job's own data, which getJobStatus already
 * reads in preference to the BullMQ state. That makes the failure visible to the
 * client through the path it already polls, without surgery on a job whose
 * BullMQ state (waiting-children) has no legitimate transition to failed.
 */
async function declareUnrecoverable(stitchJob, detail) {
  const message =
    `Rendering could not finish: ${detail}. ` +
    'Nothing was lost from your project — please start the render again.';
  await stitchJob
    .updateData({ ...stitchJob.data, _status: 'failed', _error: message })
    .catch((err) => {
      logger.error({ jobId: stitchJob.id, err: err.message }, 'Could not mark stitch as failed');
    });
  return message;
}

/**
 * One pass. Exported so a test can drive it directly rather than waiting on a
 * timer.
 *
 * @returns {Promise<Array<object>>} what it found, for logging and for tests.
 */
async function reconcileOnce({ stitchQueue, chunkQueue, redis, now = Date.now() }) {
  const findings = [];

  let parents = [];
  try {
    parents = await stitchQueue.getWaitingChildren();
  } catch (err) {
    logger.warn({ err: err.message }, 'Reconciler: could not list waiting parents');
    return findings;
  }

  const liveProjectIds = new Set();

  for (const stitchJob of parents) {
    if (!stitchJob?.id) continue;
    const projectId = String(stitchJob.id).replace(/-stitch$/, '');
    liveProjectIds.add(projectId);

    let inspection;
    try {
      inspection = await inspectDependencies(stitchJob, chunkQueue);
    } catch (err) {
      logger.warn({ jobId: stitchJob.id, err: err.message }, 'Reconciler: dependency read failed');
      continue;
    }

    const unhealthy = inspection.failed.length + inspection.missing.length;
    const record = seen.get(projectId) ?? { strikes: 0, repairs: 0 };

    if (unhealthy === 0) {
      // Waiting on work that genuinely exists and can run. This is the normal
      // state of every healthy in-flight project and must stay silent.
      if (record.strikes > 0) seen.set(projectId, { ...record, strikes: 0 });
      continue;
    }

    record.strikes += 1;
    seen.set(projectId, record);

    if (record.strikes < CONFIRMATIONS_BEFORE_ACTION) {
      logger.warn(
        {
          projectId,
          failed: inspection.failed.map((job) => job.id),
          missing: inspection.missing,
          runnable: inspection.runnable,
          strike: record.strikes,
        },
        'Reconciler: project looks stalled; will confirm on the next sweep before acting',
      );
      continue;
    }

    // Confirmed twice. Say everything, loudly — this log line is the record of
    // what the queue looked like when work went missing.
    logger.error(
      {
        projectId,
        chunksTotal: stitchJob.data?.chunks_total ?? null,
        stillWaitingOn: inspection.unprocessedCount,
        failed: inspection.failed.map((job) => job.id),
        missing: inspection.missing,
        runnable: inspection.runnable,
        repairsSoFar: record.repairs,
        at: new Date(now).toISOString(),
      },
      'Reconciler: project is stalled with no runnable work; repairing',
    );

    if (record.repairs >= MAX_RECONCILES_PER_PROJECT) {
      const message = await declareUnrecoverable(
        stitchJob,
        `${inspection.failed.length + inspection.missing.length} segment(s) could not be rendered after repeated attempts`,
      );
      logger.error({ projectId, message }, 'Reconciler: giving up and failing the render visibly');
      findings.push({ projectId, action: 'declared-unrecoverable' });
      seen.set(projectId, { strikes: 0, repairs: record.repairs + 1 });
      continue;
    }

    let requeued = 0;
    for (const failedChunk of inspection.failed) {
      const outcome = await recoverFailedChunk({
        redis,
        job: failedChunk,
        error: new Error('reconciler: chunk failed and its parent is still waiting'),
      }).catch((err) => {
        logger.error({ jobId: failedChunk.id, err: err.message }, 'Reconciler: requeue failed');
        return { action: 'exhausted' };
      });
      if (outcome.action === 'retried') requeued += 1;
    }

    // A chunk job that no longer exists cannot be rebuilt: its clip list lived
    // in the job, and inventing new chunk boundaries would silently produce a
    // different video. Say so and let the escalation path handle it rather than
    // guessing.
    if (inspection.missing.length > 0) {
      logger.error(
        { projectId, missing: inspection.missing },
        'Reconciler: chunk jobs have vanished entirely and cannot be rebuilt from the parent',
      );
    }

    seen.set(projectId, { strikes: 0, repairs: record.repairs + 1 });
    findings.push({
      projectId,
      action: 'repaired',
      requeued,
      missing: inspection.missing.length,
    });
  }

  // Forget projects that are no longer waiting, so the map cannot grow forever.
  for (const projectId of [...seen.keys()]) {
    if (!liveProjectIds.has(projectId)) seen.delete(projectId);
  }

  return findings;
}

let timer = null;

function startReconciler({ stitchQueue, chunkQueue, redis }) {
  if (timer) return timer;
  timer = setInterval(() => {
    reconcileOnce({ stitchQueue, chunkQueue, redis }).catch((err) => {
      logger.error({ err: err.message }, 'Reconciler sweep failed');
    });
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
  logger.info(
    { intervalMs: RECONCILE_INTERVAL_MS, confirmations: CONFIRMATIONS_BEFORE_ACTION },
    'Stall reconciler started',
  );
  return timer;
}

function stopReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: forget what previous sweeps saw. */
function resetReconcilerState() {
  seen.clear();
}

module.exports = {
  RECONCILE_INTERVAL_MS,
  CONFIRMATIONS_BEFORE_ACTION,
  MAX_RECONCILES_PER_PROJECT,
  reconcileOnce,
  startReconciler,
  stopReconciler,
  resetReconcilerState,
  inspectDependencies,
};
