'use strict';

/**
 * server.js
 *
 * Express HTTP API for the render worker service.
 *
 * Routes:
 *   POST /jobs          – Validate + enqueue a render job
 *   GET  /jobs/:id      – Query job status (status, progress, stderr)
 *   GET  /health        – Liveness + Redis connectivity probe
 *
 * Authentication:
 *   All /jobs routes require X-Api-Key header matching WORKER_API_KEY.
 *   /health is unauthenticated (for orchestrator liveness probes).
 *
 * Idempotency:
 *   job_id from the payload is used as the BullMQ jobId.
 *   BullMQ silently ignores duplicate adds with the same jobId — no
 *   double-processing, no error returned to the caller.
 */

const express = require('express');
const { Queue, Job } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { getQueue, getJobStatus, getRedisConnection, startWorker } = require('./queue');
const { validatePayload } = require('./renderJob');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.workerApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── POST /jobs ───────────────────────────────────────────────────────────────

app.post('/jobs', requireApiKey, async (req, res) => {
  const payload = req.body;
  const jobId = payload.job_id;

  if (!jobId) {
    return res.status(422).json({ error: 'job_id is required' });
  }

  // Run validation before touching the queue
  const validationError = validatePayload(payload);
  if (validationError) {
    return res.status(422).json({ error: validationError });
  }

  try {
    const isChunked = payload.clips.length > config.chunkSize;
    let isNew = false;

    if (!isChunked) {
      const queue = getQueue(QUEUE_NAME);
      const job = await queue.add('render', payload, { jobId });
      isNew = job.timestamp > Date.now() - 2000;
    } else {
      const stitchQueue = getQueue(QUEUE_STITCH);
      const activeStitches = await stitchQueue.getActive();
      const activeProjectsCount = activeStitches.filter(j => j.data.user_id && j.data.user_id === payload.user_id).length;
      
      const chunks = [];
      for (let i = 0; i < payload.clips.length; i += config.chunkSize) {
        chunks.push(payload.clips.slice(i, i + config.chunkSize));
      }

      const flowProducer = getFlowProducer();
      
      // Calculate priority: chunk index + (active projects * 1000)
      const basePriority = (activeProjectsCount * 1000);

      const chunkJobs = chunks.map((chunk, index) => {
        return {
          name: 'render-chunk',
          queueName: QUEUE_CHUNK,
          data: {
            ...payload,
            clips: chunk,
            chunk_index: index,
            chunks_total: chunks.length,
            is_chunk: true,
          },
          opts: {
            jobId: `${jobId}-chunk-${index}`,
            priority: basePriority + index + 1, // lower number = higher priority
          }
        };
      });

      const flowTree = {
        name: 'render-stitch',
        queueName: QUEUE_STITCH,
        data: {
          ...payload,
          chunks_total: chunks.length,
          is_stitch: true,
        },
        opts: {
          jobId: `${jobId}-stitch`,
        },
        children: chunkJobs
      };

      const flowJob = await flowProducer.add(flowTree);
      isNew = flowJob.job.timestamp > Date.now() - 2000;
    }

    logger.info({ jobId, isNew, isChunked }, 'Job enqueued');

    return res.status(isNew ? 202 : 200).json({
      job_id: jobId,
      message: isNew ? 'Job accepted' : 'Job already exists',
    });
  } catch (err) {
    logger.error({ err: err.message, jobId }, 'Failed to enqueue job');
    return res.status(500).json({ error: 'Failed to enqueue job', detail: err.message });
  }
});

// ─── GET /jobs/:id ────────────────────────────────────────────────────────────

app.get('/jobs/:id', requireApiKey, async (req, res) => {
  const jobId = req.params.id;

  try {
    const queue = getQueue();
    const job = await Job.fromId(queue, jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found', job_id: jobId });
    }

    const status = await getJobStatus(job);
    return res.json(status);
  } catch (err) {
    logger.error({ err: err.message, jobId }, 'Failed to get job status');
    return res.status(500).json({ error: 'Failed to get job status', detail: err.message });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  const health = { status: 'ok', redis: 'unknown', timestamp: new Date().toISOString() };

  try {
    const redis = getRedisConnection();
    const pong = await redis.ping();
    health.redis = pong === 'PONG' ? 'ok' : 'degraded';
  } catch (err) {
    health.redis = 'error';
    health.redisError = err.message;
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  return res.status(statusCode).json(health);
});

// ─── 404 fallthrough ─────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message }, 'Unhandled error in request');
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  // Start the BullMQ worker in the same process (simple deployment)
  // For separate worker processes: run `node src/worker.js` instead
  startWorker();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Render worker HTTP server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down gracefully');
    server.close(async () => {
      try {
        const queue = getQueue();
        await queue.close();
        const redis = getRedisConnection();
        await redis.quit();
      } catch (err) {
        logger.warn({ err: err.message }, 'Error during shutdown');
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: err.message }, 'Fatal startup error');
  process.exit(1);
});

module.exports = app; // exported for supertest
