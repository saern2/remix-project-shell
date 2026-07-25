'use strict';

/**
 * queue.js
 *
 * Creates and exports the BullMQ Queue and Worker.
 * Also exports a Redis connection helper for health checks.
 *
 * Job state machine:
 *   waiting → active → completed | failed
 * Status vocabulary (stored in job.data._status):
 *   waiting | downloading | rendering | completed | failed
 *
 * Stalled job detection:
 *   If the worker process is killed mid-job, BullMQ's stalledInterval
 *   detects that the active job heartbeat stopped and automatically
 *   moves it back to waiting (if attempts remain) or failed.
 *   This satisfies the "kill worker mid-render" requirement.
 */

const os = require('os');
const { Queue, Worker, QueueEvents, FlowProducer } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');
const logger = require('./logger');
const { processRenderJob, processStitchJob } = require('./renderJob');

const QUEUE_NAME = 'render';
const QUEUE_CHUNK = 'render-chunk';
const QUEUE_STITCH = 'render-stitch';

// ─── Redis connection ─────────────────────────────────────────────────────────

function createRedisConnection() {
  const conn = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  });

  conn.on('connect', () => logger.info('Redis connected'));
  conn.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));

  return conn;
}

let _redisConnection = null;

function getRedisConnection() {
  if (!_redisConnection) _redisConnection = createRedisConnection();
  return _redisConnection;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

const _queues = {};
let _flowProducer = null;

function getQueue(name = QUEUE_NAME) {
  if (!_queues[name]) {
    _queues[name] = new Queue(name, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: config.jobAttempts,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return _queues[name];
}

function getFlowProducer() {
  if (!_flowProducer) {
    _flowProducer = new FlowProducer({
      connection: createRedisConnection(),
    });
  }
  return _flowProducer;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let _workers = [];

function createWorker(queueName, processor, concurrency, timeoutMs) {
  const worker = new Worker(
    queueName,
    async (job) => {
      logger.info({ jobId: job.id, queue: queueName }, 'Worker picked up job');
      return processor(job);
    },
    {
      connection: createRedisConnection(),
      concurrency,
      stalledInterval: config.bullStalledIntervalMs,
      lockDuration: timeoutMs + 30_000,
      lockRenewTime: Math.floor(timeoutMs / 2),
    }
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result, queue: queueName }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message, queue: queueName }, 'Job failed');
  });

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: queueName }, 'Job stalled — will be retried or failed by BullMQ');
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message, queue: queueName }, 'Worker error');
  });

  logger.info({ concurrency, queue: queueName }, 'BullMQ worker started');
  return worker;
}

function startWorker() {
  if (_workers.length > 0) return _workers;

  // Compute effective concurrency for the chunk worker once at startup.
  // Caps the configured value to the number of available CPU cores so that
  // simultaneous FFmpeg processes never exceed hardware capacity.
  const effectiveConcurrency = Math.min(config.workerConcurrencyChunks, os.cpus().length);

  // Legacy/small-project queue
  _workers.push(createWorker(QUEUE_NAME, processRenderJob, config.workerConcurrency, config.jobTimeoutSeconds * 1000));

  // Chunk queue — uses bounded effectiveConcurrency
  _workers.push(createWorker(QUEUE_CHUNK, processRenderJob, effectiveConcurrency, config.chunkTimeoutSeconds * 1000));

  // Stitch queue
  _workers.push(createWorker(QUEUE_STITCH, processStitchJob, config.workerConcurrencyStitches, config.stitchTimeoutSeconds * 1000));

  return _workers;
}

// ─── Job status helper ────────────────────────────────────────────────────────

/**
 * Maps a BullMQ job to the status object returned by GET /jobs/:id.
 *
 * @param {import('bullmq').Job | null} job
 * @returns {object | null}
 */
async function getJobStatus(job) {
  if (!job) return null;

  const state = await job.getState(); // 'waiting' | 'active' | 'completed' | 'failed' | etc.
  const data = job.data ?? {};

  // Overlay our finer-grained status from job.data._status
  let status = data._status ?? state;

  // Normalise BullMQ states to our vocabulary
  if (state === 'active' && !data._status) status = 'rendering';
  if (state === 'waiting' || state === 'delayed') status = 'waiting';

  const result = {
    job_id: job.id,
    status,
    progress_pct: typeof job.progress === 'number' ? job.progress : 0,
    output_url: data._outputUrl ?? null,
    error: data._error ?? (state === 'failed' ? (job.failedReason ?? 'Unknown error') : null),
    ffmpegStderr: data._ffmpegStderr ?? null,
    attempts_made: job.attemptsMade,
    created_at: new Date(job.timestamp).toISOString(),
  };

  // If this is a stitch job, calculate chunk progress
  if (data.is_stitch && typeof job.getDependenciesCount === 'function') {
    result.chunks_total = data.chunks_total || 0;
    try {
      const counts = await job.getDependenciesCount();
      // "processed" means children that have successfully finished
      result.chunks_completed = counts.processed || 0;
    } catch (err) {
      // Fallback if counting fails
      result.chunks_completed = 0;
    }
  }

  return result;
}

module.exports = {
  getQueue,
  getFlowProducer,
  startWorker,
  getRedisConnection,
  getJobStatus,
  QUEUE_NAME,
  QUEUE_CHUNK,
  QUEUE_STITCH,
};
