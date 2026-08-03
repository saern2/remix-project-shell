'use strict';

async function cancelJobsByPrefix({ jobId, queues, redis, writeCancelFlag, logger }) {
  const matchingJobs = [];

  for (const queue of queues) {
    const [waiting, delayed, waitingChildren, active] = await Promise.all([
      queue.getWaiting(),
      queue.getDelayed(),
      queue.getWaitingChildren(),
      queue.getActive(),
    ]);

    for (const job of [...waiting, ...delayed, ...waitingChildren, ...active].filter(Boolean)) {
      if (job.id && job.id.startsWith(jobId)) matchingJobs.push(job);
    }
  }

  let cancelledCount = 0;
  let vanishedCount = 0;

  for (const job of matchingJobs) {
    try {
      const state = await job.getState();
      if (state === 'active') {
        await writeCancelFlag(redis, job.id);
        cancelledCount += 1;
      } else if (state === 'waiting' || state === 'delayed' || state === 'waiting-children') {
        await job.remove();
        cancelledCount += 1;
      }
    } catch (err) {
      vanishedCount += 1;
      logger.warn({ err: err.message, jobId: job.id }, 'Cancel skipped a job that vanished');
    }
  }

  return { cancelledCount, matchedCount: matchingJobs.length, vanishedCount };
}

module.exports = { cancelJobsByPrefix };