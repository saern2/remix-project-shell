'use strict';

function parentProjectId(job) {
  if (!job) return null;
  if (job.data?.job_id) return String(job.data.job_id);
  if (job.data?.parent_job_id) return String(job.data.parent_job_id);
  if (job.id) return String(job.id).replace(/-(?:chunk-\d+|stitch)$/, '');
  return null;
}

function fairnessSlot(job) {
  const value = job?.data?._fairness_slot;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

async function getInFlightProjects(stitchQueue, chunkQueue) {
  const [parents, waitingChunks, activeChunks] = await Promise.all([
    stitchQueue.getWaitingChildren(),
    chunkQueue.getWaiting(),
    chunkQueue.getActive(),
  ]);

  const projects = new Map();
  for (const job of [...parents, ...waitingChunks, ...activeChunks].filter(Boolean)) {
    const projectId = parentProjectId(job);
    if (!projectId) continue;
    const slot = fairnessSlot(job);
    if (!projects.has(projectId) || projects.get(projectId) == null) {
      projects.set(projectId, slot);
    }
  }
  return projects;
}

function chooseFairnessSlot(projects, stride) {
  const used = new Set([...projects.values()].filter((slot) => slot != null));
  for (let slot = 0; slot < stride; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  throw new Error(`Too many concurrent render projects for fairness stride ${stride}`);
}

function chunkPriority(chunkIndex, slot, stride) {
  const priority = chunkIndex * stride + slot + 1;
  if (!Number.isSafeInteger(priority) || priority > 2_097_152) {
    throw new Error(`Chunk priority ${priority} exceeds BullMQ's supported range`);
  }
  return priority;
}

// ── Tail starvation (round 18) ──────────────────────────────────────────────
// Priorities are static: chunk N of any project always outranks chunk N+1 of
// every project. That interleaves fairly while projects are mid-body, but a
// project on its LAST chunks holds the highest indices in the system, so every
// newer project's early chunks cut ahead of it — the closer a project gets to
// done, the worse it competes. Meanwhile it is holding an admission slot that
// nothing else can use until its stitch finishes.
//
// The remedy is deliberately dynamic and narrow: once a project has completed
// this fraction of its chunks, its remaining chunks are re-prioritised into the
// index-0 band, where they compete round-robin with other projects' FIRST
// chunks instead of behind their entire bodies. The static formula is untouched.

const TAIL_COMPLETION_FRACTION = 0.9;

/** Has this project earned the tail boost? Pure; thresholds pinned by tests. */
function shouldPromoteTail(chunksCompleted, chunksTotal) {
  if (!Number.isFinite(chunksTotal) || chunksTotal < 2) return false;
  if (!Number.isFinite(chunksCompleted) || chunksCompleted <= 0) return false;
  return chunksCompleted >= Math.ceil(chunksTotal * TAIL_COMPLETION_FRACTION);
}

/**
 * The boosted priority: chunk index 0's band, slot preserved so the intra-band
 * round-robin between projects still applies.
 */
function tailPriority(slot, stride) {
  return chunkPriority(0, Number.isInteger(slot) && slot >= 0 ? slot : 0, stride);
}

let allocationTail = Promise.resolve();

function withFairnessAllocation(callback) {
  const run = allocationTail.then(callback, callback);
  allocationTail = run.catch(() => undefined);
  return run;
}

module.exports = {
  parentProjectId,
  getInFlightProjects,
  chooseFairnessSlot,
  chunkPriority,
  withFairnessAllocation,
  TAIL_COMPLETION_FRACTION,
  shouldPromoteTail,
  tailPriority,
};
