'use strict';

const { Queue, Worker, FlowProducer, Job } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');
const logger = require('./logger');
const { processRenderJob, processStitchJob, closeRenderConnections } = require('./renderJob');
const { readJobHealth } = require('./resourceControl');
const admission = require('./admissionControl');
const { parentProjectId, shouldPromoteTail, tailPriority } = require('./fairScheduling');

const QUEUE_NAME = 'render';
const QUEUE_CHUNK = 'render-chunk';
const QUEUE_STITCH = 'render-stitch';

function createRedisConnection() {
  const connection = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  connection.on('connect', () => logger.info('Redis connected'));
  connection.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  return connection;
}

let redisConnection = null;
function getRedisConnection() {
  if (!redisConnection) redisConnection = createRedisConnection();
  return redisConnection;
}

const queues = {};
let flowProducer = null;

function getQueue(name = QUEUE_NAME) {
  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: config.jobAttempts,
        backoff: { type: 'exponential', delay: config.jobBackoffDelayMs },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return queues[name];
}

function getFlowProducer() {
  if (!flowProducer) {
    flowProducer = new FlowProducer({ connection: createRedisConnection() });
  }
  return flowProducer;
}

let workers = [];
const workerTelemetry = {
  stalledCount: 0,
  stalledEvents: [],
};
const jobStartedAt = new Map();

function telemetryKey(queueName, jobId) {
  return `${queueName}:${jobId}`;
}

/**
 * Promotes the remaining chunks of a nearly-finished project.
 *
 * Runs on each chunk completion; shouldPromoteTail makes it a no-op until a
 * project is both substantially complete AND within its last few chunks, and
 * the sweep touches only siblings whose priority would actually improve, so
 * re-runs after the threshold are cheap and idempotent. Reads the `prioritized`
 * state, not `waiting` — every chunk carries a priority, and BullMQ 5 keeps
 * prioritised jobs in their own state.
 */
async function promoteTailChunks(job) {
  const projectId = parentProjectId(job);
  if (!projectId) return;

  const stitchJob = await Job.fromId(getQueue(QUEUE_STITCH), `${projectId}-stitch`);
  const chunksTotal = stitchJob?.data?.chunks_total;
  if (!chunksTotal || typeof stitchJob.getDependenciesCount !== 'function') return;

  const counts = await stitchJob.getDependenciesCount();
  if (!shouldPromoteTail(counts.processed || 0, chunksTotal)) return;

  const boost = tailPriority(job.data?._fairness_slot, config.fairnessPriorityStride);
  const pending = await getQueue(QUEUE_CHUNK).getPrioritized();
  let promoted = 0;
  for (const sibling of pending) {
    if (!sibling || parentProjectId(sibling) !== projectId) continue;
    const current = Number(sibling.opts?.priority ?? 0);
    if (current <= boost) continue; // already at or ahead of the boost band
    await sibling.changePriority({ priority: boost });
    promoted += 1;
  }
  if (promoted > 0) {
    logger.info(
      { projectId, promoted, boost, completed: counts.processed, chunksTotal },
      'Project is near completion; remaining chunks promoted to the front band',
    );
  }
}

function createWorker(queueName, processor, concurrency, timeoutMs) {
  const worker = new Worker(
    queueName,
    // The token is threaded through so a processor can move its own job back to
    // delayed — the admission gate needs it to defer a chunk without consuming
    // a retry attempt.
    async (job, token) => {
      jobStartedAt.set(telemetryKey(queueName, job.id), Date.now());
      logger.info({ jobId: job.id, queue: queueName }, 'Worker picked up job');
      return processor(job, token);
    },
    {
      connection: createRedisConnection(),
      concurrency,
      stalledInterval: config.bullStalledIntervalMs,
      lockDuration: timeoutMs + 30_000,
      lockRenewTime: config.bullLockRenewTimeMs,
    },
  );

  worker.on('completed', (job, result) => {
    jobStartedAt.delete(telemetryKey(queueName, job.id));
    logger.info({ jobId: job.id, result, queue: queueName }, 'Job completed');
    // Tail starvation: a project within its last few chunks gets them promoted
    // into the reserved band, so it finishes and frees its admission slot
    // instead of dripping behind newer projects' early chunks. Fire-and-forget:
    // scheduling advice must never fail a completed job.
    if (queueName === QUEUE_CHUNK && job?.data?.is_chunk) {
      promoteTailChunks(job).catch((err) => {
        logger.warn({ jobId: job.id, err: err.message }, 'Tail promotion sweep failed');
      });
    }
  });

  worker.on('failed', (job, err) => {
    if (job?.id) jobStartedAt.delete(telemetryKey(queueName, job.id));
    logger.error({ jobId: job?.id, err: err.message, queue: queueName }, 'Job failed');
  });

  worker.on('stalled', (jobId) => {
    const key = telemetryKey(queueName, jobId);
    const startedAt = jobStartedAt.get(key);
    const elapsedMs = startedAt ? Date.now() - startedAt : null;
    const event = { jobId, queue: queueName, elapsedMs, at: new Date().toISOString() };
    workerTelemetry.stalledCount += 1;
    workerTelemetry.stalledEvents.push(event);
    if (workerTelemetry.stalledEvents.length > 100) workerTelemetry.stalledEvents.shift();
    logger.warn(event, 'Job stalled - will be retried or failed by BullMQ');
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message, queue: queueName }, 'Worker error');
  });

  logger.info(
    { concurrency, queue: queueName, lockRenewTimeMs: config.bullLockRenewTimeMs },
    'BullMQ worker started',
  );
  return worker;
}

function startWorker() {
  if (workers.length > 0) return workers;

  const effectiveChunkConcurrency = Math.min(
    config.workerConcurrencyChunks,
    config.detectedCpuCount,
  );

  workers.push(
    createWorker(
      QUEUE_NAME,
      processRenderJob,
      config.workerConcurrency,
      config.jobTimeoutSeconds * 1000,
    ),
  );
  workers.push(
    createWorker(
      QUEUE_CHUNK,
      processRenderJob,
      effectiveChunkConcurrency,
      config.chunkTimeoutSeconds * 1000,
    ),
  );
  workers.push(
    createWorker(
      QUEUE_STITCH,
      processStitchJob,
      config.workerConcurrencyStitches,
      config.stitchTimeoutSeconds * 1000,
    ),
  );

  logger.info(
    {
      cpuCount: config.detectedCpuCount,
      totalWorkerSlots: config.totalWorkerSlots,
      // The divisor for the thread budget: chunk slots only. Legacy and stitch
      // slots do not encode, so counting them starved every chunk of cpu.
      encodeWorkerSlots: config.encodeWorkerSlots,
      ffmpegThreads: config.ffmpegThreads,
      maxFfmpegThreads: config.maxFfmpegThreads,
      ffmpegMaxProcesses: config.ffmpegMaxProcesses,
      legacyConcurrency: config.workerConcurrency,
      chunkConcurrency: effectiveChunkConcurrency,
      stitchConcurrency: config.workerConcurrencyStitches,
      renderAdmissionLimit: config.renderAdmissionLimit,
      renderAdmissionPerUserLimit: config.renderAdmissionPerUserLimit,
      admissionMinFreeMemoryMb: Math.round(config.admissionMinFreeMemoryBytes / 1024 / 1024),
    },
    'Render worker resource budget',
  );

  return workers;
}

async function stopWorkers() {
  const current = workers;
  workers = [];
  await Promise.all(current.map((worker) => worker.close()));
  await closeRenderConnections();
}

async function closeQueueResources() {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  for (const name of Object.keys(queues)) delete queues[name];

  if (flowProducer) {
    await flowProducer.close();
    flowProducer = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}

async function getJobStatus(job) {
  if (!job) return null;

  const state = await job.getState();
  const data = job.data ?? {};
  let status = data._status ?? state;

  if (state === 'active' && !data._status) status = 'rendering';
  if (state === 'waiting' || state === 'delayed') status = 'waiting';

  const result = {
    job_id: job.id,
    status,
    progress_pct: typeof job.progress === 'number' ? job.progress : 0,
    output_url: data._outputUrl ?? null,
    error: data._error ?? (state === 'failed' ? (job.failedReason ?? 'Unknown error') : null),
    ffmpegStderr: data._ffmpegStderr ?? null,
    attempts_made: job.attemptsStarted ?? job.attemptsMade,
    created_at: new Date(job.timestamp).toISOString(),
  };

  if (data.is_stitch && typeof job.getDependenciesCount === 'function') {
    result.chunks_total = data.chunks_total || 0;
    try {
      const counts = await job.getDependenciesCount();
      result.chunks_completed = counts.processed || 0;
    } catch {
      result.chunks_completed = 0;
    }

    // Progress for a chunked render used to sit at 0 until the stitch itself
    // started — the deployed run showed 0% for four and a half minutes while 12
    // of 13 chunks completed. Derive it from the children instead; the stitch
    // phase keeps the 50-100 band it already sets for itself.
    if (result.chunks_total > 0 && (result.progress_pct ?? 0) < 50) {
      result.progress_pct = Math.min(
        45,
        Math.round((result.chunks_completed / result.chunks_total) * 45),
      );
    }

    // ── Stitch visibility (round 18, item 4a) ─────────────────────────────
    // Once every chunk is done this job's BullMQ state stops describing chunk
    // progress and starts describing the stitch, and the client showed "51 of
    // 51 segments rendered" for the whole 15m10s worst case. Three states the
    // user can actually distinguish:
    //   waiting  — chunks done, no stitch slot free yet; say how many are ahead
    //   combining — the concat/mux is running
    //   uploading — the finished file is leaving the machine
    if (result.chunks_total > 0 && result.chunks_completed >= result.chunks_total) {
      if (data._status === 'uploading') {
        result.stitch_state = 'uploading';
      } else if (state === 'active' || data._status === 'stitching') {
        result.stitch_state = 'combining';
      } else if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
        result.stitch_state = 'waiting';
        try {
          // FIFO order within the stitch queue: everything before this job's
          // index is genuinely ahead of it.
          const waitingStitches = await getQueue(QUEUE_STITCH).getWaiting();
          const index = waitingStitches.findIndex((waiting) => waiting?.id === job.id);
          result.stitches_ahead = index > 0 ? index : 0;
        } catch {
          result.stitches_ahead = null;
        }
      }
    }

    // ── Admission queue (round 18) ────────────────────────────────────────
    // A queued project used to be indistinguishable from a stuck one: status
    // "waiting", 0 chunks done, nothing moving, no explanation. The worker knows
    // exactly where it is in line, so say so.
    const projectId = job.id.replace(/-stitch$/, '');
    try {
      const snapshot = await admission.admissionSnapshot(getRedisConnection());
      // The cap-aware position, not the raw rank. With a per-user cap the two
      // diverge sharply: a user queued behind five of somebody else's projects
      // is next in line, not sixth, because that user is already at their cap
      // and all five are skipped.
      const position = admission.effectiveQueuePosition({
        projectId,
        waiting: snapshot.waiting,
        active: snapshot.active,
        owners: snapshot.owners,
        perUser: snapshot.perUserLimit,
      });
      result.admission = {
        limit: snapshot.limit,
        active_count: snapshot.activeCount,
        waiting_count: snapshot.waitingCount,
        stitching_count: snapshot.stitchingCount,
        per_user_limit: snapshot.perUserLimit,
        // null until this machine has measured a chunk; the caller must not
        // present a fabricated estimate as a measured one.
        seconds_per_chunk: snapshot.secondsPerChunk,
      };
      if (position > 0) {
        result.status = 'queued';
        result.queue_position = position;
        result.queue_estimate_seconds = admission.estimateWaitSeconds({
          position,
          chunksAhead: (result.chunks_total || 0) * position,
          secondsPerChunk: snapshot.secondsPerChunk,
          chunkConcurrency: snapshot.chunkConcurrency,
        });
      }
    } catch (err) {
      // Advisory only. A project that is actually rendering must not report a
      // failure because the queue view was unavailable.
      logger.warn({ jobId: job.id, err: err.message }, 'Admission snapshot unavailable');
    }

    // A child chunk in trouble is otherwise invisible here: this job's own
    // status stays "waiting-children" while chunks_completed silently stops.
    const health = await readJobHealth(getRedisConnection(), projectId);
    if (health) {
      result.health = health;
      result.stalled = health.state === 'stalled' || health.state === 'retrying';
    }
  }

  return result;
}

function getWorkerTelemetry() {
  return {
    stalledCount: workerTelemetry.stalledCount,
    stalledEvents: [...workerTelemetry.stalledEvents],
  };
}

function resetWorkerTelemetry() {
  workerTelemetry.stalledCount = 0;
  workerTelemetry.stalledEvents = [];
  jobStartedAt.clear();
}

module.exports = {
  getQueue,
  getFlowProducer,
  startWorker,
  stopWorkers,
  closeQueueResources,
  getRedisConnection,
  getJobStatus,
  getWorkerTelemetry,
  resetWorkerTelemetry,
  QUEUE_NAME,
  QUEUE_CHUNK,
  QUEUE_STITCH,
};
