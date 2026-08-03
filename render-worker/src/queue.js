'use strict';

const { Queue, Worker, FlowProducer } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');
const logger = require('./logger');
const { processRenderJob, processStitchJob, closeRenderConnections } = require('./renderJob');

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

function createWorker(queueName, processor, concurrency, timeoutMs) {
  const worker = new Worker(
    queueName,
    async (job) => {
      jobStartedAt.set(telemetryKey(queueName, job.id), Date.now());
      logger.info({ jobId: job.id, queue: queueName }, 'Worker picked up job');
      return processor(job);
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
      ffmpegThreads: config.ffmpegThreads,
      ffmpegMaxProcesses: config.ffmpegMaxProcesses,
      legacyConcurrency: config.workerConcurrency,
      chunkConcurrency: effectiveChunkConcurrency,
      stitchConcurrency: config.workerConcurrencyStitches,
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
