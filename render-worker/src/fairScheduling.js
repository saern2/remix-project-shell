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

/**
 * Regular chunk priority. Lower wins, and 0 is avoided because BullMQ treats it
 * as "unprioritised".
 *
 * Band `chunkIndex + 1`, not `chunkIndex`: band 0 (priorities 1..stride) is
 * RESERVED for the tail boost. See tailPriority for why it has to be a band of
 * its own rather than a place inside this range.
 */
function chunkPriority(chunkIndex, slot, stride) {
  const priority = (chunkIndex + 1) * stride + slot + 1;
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
// THE FIRST ATTEMPT MADE IT WORSE, and the 2026-08-07 five-project run measured
// how much: the 22nd project ran to chunk 40 of 47 and then sat for 19 minutes;
// the 23rd stalled at 40 of 48 for 21.6 minutes. Both were promoted — into the
// INDEX-0 BAND, level with other projects' first chunks. tailPriority returned
// chunkPriority(0, slot, stride), which is slot + 1, so a nearly-finished
// project in slot 2 lost to every freshly-admitted project holding slots 0 and
// 1. A project at 85% was made to compete against a fresh project's entire
// 40-chunk workload, and lost, which is precisely backwards.
//
// The band has to be ABOVE index 0, not level with it, and there is no room
// below priority 1 — so the regular formula now starts at band 1 and band 0
// (priorities 1..stride) belongs to the tail alone. A promoted chunk outranks
// every unpromoted chunk in the system, whatever its index or slot.
//
// TWO BOUNDS, so "finish what is nearly done" cannot become "starve everything
// else". A promoted project must be substantially complete AND have few enough
// chunks left that draining it is short:
//
//   - TAIL_COMPLETION_FRACTION keeps small projects from being born promoted.
//   - TAIL_CHUNK_WINDOW caps the burst. With RENDER_ADMISSION_LIMIT projects
//     admitted at once, at most limit x window chunks can occupy the tail band,
//     so the worst case is bounded by construction rather than by hoping.
//
// The window is what actually matches the measurement: for a 47-chunk project
// it covers chunks 40-47, exactly the range that stalled.

const TAIL_COMPLETION_FRACTION = 0.8;
const TAIL_CHUNK_WINDOW = 8;

/** Has this project earned the tail boost? Pure; thresholds pinned by tests. */
function shouldPromoteTail(chunksCompleted, chunksTotal) {
  if (!Number.isFinite(chunksTotal) || chunksTotal < 2) return false;
  if (!Number.isFinite(chunksCompleted) || chunksCompleted <= 0) return false;

  const remaining = chunksTotal - chunksCompleted;
  if (remaining <= 0 || remaining > TAIL_CHUNK_WINDOW) return false;

  return chunksCompleted >= Math.ceil(chunksTotal * TAIL_COMPLETION_FRACTION);
}

/**
 * The boosted priority: the reserved band, ahead of every regular chunk.
 *
 * Slot is preserved so promoted projects still round-robin against EACH OTHER
 * rather than the earliest-promoted one monopolising the band.
 */
function tailPriority(slot, stride) {
  return (Number.isInteger(slot) && slot >= 0 ? slot : 0) + 1;
}

/**
 * The most chunks that can sit in the tail band at once.
 *
 * Stated as a function rather than a comment so the starvation bound is
 * something a test can assert on instead of something a reader has to trust.
 */
function maxTailBandChunks(admissionLimit) {
  return Math.max(0, admissionLimit) * TAIL_CHUNK_WINDOW;
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
  TAIL_CHUNK_WINDOW,
  shouldPromoteTail,
  tailPriority,
  maxTailBandChunks,
};
