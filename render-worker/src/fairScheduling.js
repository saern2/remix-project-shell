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
};
