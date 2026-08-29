/**
 * HTTP surface + queue + worker in one process (the render worker's own
 * deployment shape): POST /jobs, GET /jobs/:id, GET /health, X-Api-Key.
 *
 * "Server busy" is a first-class state (Item 2): past MOTION_QUEUE_MAX_DEPTH
 * the submission is REFUSED with the depth and the expected wait stated
 * plainly — at ~42 minutes per job and concurrency 1, a silent queue of
 * four is a two-and-a-half-hour lie of omission.
 */

import express from 'express';
import fs from 'node:fs';
import { Queue, Worker, Job, DelayedError } from 'bullmq';
import IORedis from 'ioredis';
import config from './config.js';
import { encryptKey } from './keyCrypto.js';
import { processMotionJob } from './processor.js';
import { renderGateOpen } from './renderGate.js';
import { estimateWaitSeconds, medianJobSeconds, recordJobSeconds, seedJobSeconds } from './jobStats.js';
import { sweepOrphans } from './sweep.js';
import { validateSubmission } from './validate.js';

const connection = () =>
  new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

const redis = connection();
const queue = new Queue(config.queueName, {
  connection: connection(),
  defaultJobOptions: {
    attempts: config.jobAttempts,
    removeOnComplete: config.removeOnComplete,
    removeOnFail: config.removeOnFail,
  },
});

const app = express();
app.use(express.json({ limit: '1mb' }));

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== config.apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/jobs', requireApiKey, async (req, res) => {
  const invalid = validateSubmission(req.body);
  if (invalid) return res.status(422).json({ error: invalid });

  const jobId = req.body.job_id.trim();
  const existing = await queue.getJobState(jobId).catch(() => 'unknown');
  if (existing === 'failed') {
    // A deliberate resubmit after an honest failure gets a fresh run.
    const old = await Job.fromId(queue, jobId);
    if (old) await old.remove();
  } else if (existing !== 'unknown') {
    return res.json({ job_id: jobId, state: existing });
  }

  // The queue ceiling (Item 2): refuse loudly, with the numbers.
  const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
  const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
  if (depth >= config.queueMaxDepth) {
    const median = await medianJobSeconds(redis);
    const waitMinutes = Math.round(
      estimateWaitSeconds({
        position: depth,
        medianSeconds: median,
        concurrency: config.concurrency,
        activeCount: 0,
      }) / 60,
    );
    return res.status(429).json({
      error:
        `The explainer queue is full: ${depth} jobs are already queued or running, ` +
        `which is roughly ${waitMinutes} minutes of work. Please try again once some finish.`,
      queue_depth: depth,
      estimated_wait_minutes: waitMinutes,
    });
  }

  await queue.add(
    'motion',
    {
      brief: req.body.brief,
      model: req.body.model.trim(),
      // The key enters Redis ONLY as worker-secret ciphertext (D5).
      key_ct: encryptKey(req.body.api_key, config.keySecret),
      upload_url: req.body.upload_url,
    },
    { jobId },
  );
  console.log(`[motion] job accepted: ${jobId} (model ${req.body.model.trim()})`);
  return res.status(202).json({ job_id: jobId, state: 'queued' });
});

app.get('/jobs/:id', requireApiKey, async (req, res) => {
  const jobId = req.params.id;
  const state = await queue.getJobState(jobId).catch(() => 'unknown');
  if (state === 'unknown') {
    return res.status(404).json({ error: 'Job not found', job_id: jobId });
  }

  const body = { job_id: jobId, status: state };
  const median = await medianJobSeconds(redis);

  if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
    body.status = 'queued';
    try {
      const waiting = await queue.getJobs(['waiting', 'delayed'], 0, 50);
      const ordered = waiting
        .filter(Boolean)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        .map((j) => j.id);
      const position = ordered.indexOf(jobId);
      const counts = await queue.getJobCounts('active');
      body.queue_position = position >= 0 ? position + 1 : ordered.length + 1;
      body.eta_seconds = estimateWaitSeconds({
        position: body.queue_position,
        medianSeconds: median,
        concurrency: config.concurrency,
        activeCount: counts.active ?? 0,
      });
    } catch {
      body.queue_position = null;
      body.eta_seconds = null;
    }
  } else if (state === 'active') {
    body.status = 'processing';
    const job = await Job.fromId(queue, jobId);
    body.progress_pct = typeof job?.progress === 'number' ? job.progress : 0;
    body.eta_seconds = median; // a running job's honest scale, not a countdown
  } else if (state === 'completed') {
    const job = await Job.fromId(queue, jobId);
    if (job?.returnvalue && typeof job.returnvalue === 'object') Object.assign(body, job.returnvalue);
  } else if (state === 'failed') {
    const job = await Job.fromId(queue, jobId);
    body.error = job?.failedReason || 'The explainer failed. Please try again.';
  }
  return res.json(body);
});

app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
  } catch {
    return res.status(503).json({ ok: false, reason: 'redis unreachable' });
  }
  return res.json({ ok: true, concurrency: config.concurrency, queue: config.queueName });
});

// ── Worker ────────────────────────────────────────────────────────────────
const worker = new Worker(
  config.queueName,
  async (job, token) => {
    // The render gate (V4): motion never STARTS while chunks are active.
    if (!(await renderGateOpen(redis))) {
      console.log(`[motion] job ${job.id}: render chunks active — holding ${config.renderGateRecheckMs / 1000}s`);
      await job.moveToDelayed(Date.now() + config.renderGateRecheckMs, token);
      throw new DelayedError();
    }
    return processMotionJob(job, { redis });
  },
  { connection: connection(), concurrency: config.concurrency },
);
worker.on('failed', (job, err) => {
  console.error(`[motion] job failed: ${job?.id}: ${err.message}`);
});
worker.on('completed', (job) => {
  console.log(`[motion] job completed: ${job.id}`);
});

// ── Sweeps ────────────────────────────────────────────────────────────────
async function isJobLive(jobId) {
  const state = await queue.getJobState(jobId).catch(() => 'unknown');
  return state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized';
}
async function runSweep() {
  const { swept } = await sweepOrphans({ isJobLive });
  if (swept.length) console.log(`[motion] orphan sweep removed: ${swept.join(', ')}`);
}

fs.mkdirSync(config.tmpDir, { recursive: true });
await seedJobSeconds(redis);
runSweep().catch((err) => console.warn(`[motion] startup sweep failed: ${err.message}`));
setInterval(() => runSweep().catch(() => {}), config.sweepIntervalMs).unref?.();

app.listen(config.port, () => {
  console.log(
    `[motion] listening on :${config.port} (concurrency=${config.concurrency}, ` +
      `maxTurns=${config.maxTurns}, wallClock=${config.wallClockSeconds}s, ` +
      `gate<${config.renderGateMaxActiveChunks} active chunks, depth<=${config.queueMaxDepth})`,
  );
});

export { queue, worker, recordJobSeconds };
