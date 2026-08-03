'use strict';

/**
 * server.js
 *
 * Express HTTP API for the render worker service.
 *
 * Routes:
 *   POST /jobs          â€“ Validate + enqueue a render job
 *   GET  /jobs/:id      â€“ Query job status (status, progress, stderr)
 *   GET  /health        â€“ Liveness + Redis connectivity probe
 *
 * Authentication:
 *   All /jobs routes require X-Api-Key header matching WORKER_API_KEY.
 *   /health is unauthenticated (for orchestrator liveness probes).
 *
 * Idempotency:
 *   job_id from the payload is used as the BullMQ jobId.
 *   BullMQ silently ignores duplicate adds with the same jobId â€” no
 *   double-processing, no error returned to the caller.
 */

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const { Queue, Job } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { getQueue, getJobStatus, getRedisConnection, startWorker, getFlowProducer, QUEUE_NAME, QUEUE_CHUNK, QUEUE_STITCH } = require('./queue');
const { validatePayload } = require('./renderJob');
const { buildChunkOpts, writeCancelFlag } = require('./pipelineReliability');
const { cancelJobsByPrefix } = require('./cancelJobs');

const app = express();
app.use(express.json({ limit: '1mb' }));

// â”€â”€â”€ Auth middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.workerApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// â”€â”€â”€ POST /jobs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

      const { audio_url, ...chunkPayloadBase } = payload;

      const chunkJobs = chunks.map((chunk, index) => {
        return {
          name: 'render-chunk',
          queueName: QUEUE_CHUNK,
          data: {
            ...chunkPayloadBase,
            clips: chunk,
            chunk_index: index,
            chunks_total: chunks.length,
            is_chunk: true,
          },
          opts: {
            jobId: `${jobId}-chunk-${index}`,
            priority: basePriority + index + 1, // lower number = higher priority
            ...buildChunkOpts(chunk, config),
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

// â”€â”€â”€ GET /jobs/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get('/jobs/:id', requireApiKey, async (req, res) => {
  const jobId = req.params.id;

  try {
    const legacyQueue = getQueue(QUEUE_NAME);
    let job = await Job.fromId(legacyQueue, jobId);

    if (!job) {
      const stitchQueue = getQueue(QUEUE_STITCH);
      job = await Job.fromId(stitchQueue, `${jobId}-stitch`);
    }

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

// â”€â”€â”€ POST /jobs/:id/cancel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/jobs/:id/cancel', requireApiKey, async (req, res) => {
  const jobId = req.params.id;

  try {
    const redis = getRedisConnection();
    const queues = [
      getQueue(QUEUE_NAME),
      getQueue(QUEUE_CHUNK),
      getQueue(QUEUE_STITCH),
    ];

    const result = await cancelJobsByPrefix({
      jobId,
      queues,
      redis,
      writeCancelFlag,
      logger,
    });

    return res.status(200).json({
      cancelled: true,
      cancelled_count: result.cancelledCount,
      matched_count: result.matchedCount,
      vanished_count: result.vanishedCount,
      job_id: jobId,
    });
  } catch (err) {
    logger.error({ err: err.message, jobId }, 'Failed to cancel job');
    return res.status(500).json({ error: 'Failed to cancel job', detail: err.message });
  }
});

// â”€â”€â”€ GET /health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ 404 fallthrough â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// â”€â”€â”€ Error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message }, 'Unhandled error in request');
  res.status(500).json({ error: 'Internal server error' });
});

// â”€â”€â”€ Bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * sweepOrphanedTempDirs â€” scans config.tempDir for directories whose mtime
 * is older than ORPHAN_AGE_MS and deletes them, logging bytes reclaimed.
 *
 * Any directory older than the threshold is guaranteed to be orphaned: no
 * legitimate job runs for 6 hours without either completing (and cleaning up)
 * or hitting its own hard timeout. This covers chunks that exhausted retries
 * before the per-job finally block fixes landed, plus any future edge cases.
 */
const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour

async function getDirSizeBytes(dirPath) {
  let total = 0;
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirSizeBytes(full);
      } else {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  } catch {
    // dir may have been removed concurrently
  }
  return total;
}

async function sweepOrphanedTempDirs() {
  const baseDir = config.tempDir;
  let entries;
  try {
    entries = await fsp.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err: err.message, baseDir }, 'Temp sweep: cannot read tempDir');
    return;
  }

  const now = Date.now();
  let sweptCount = 0;
  let sweptBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(baseDir, entry.name);
    let stat;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue;
    }
    const ageMs = now - stat.mtimeMs;
    if (ageMs < ORPHAN_AGE_MS) continue;

    // Directory is old enough to be orphaned â€” measure then delete
    const bytes = await getDirSizeBytes(fullPath);
    try {
      await fsp.rm(fullPath, { recursive: true, force: true });
      sweptCount++;
      sweptBytes += bytes;
      logger.info({ dir: entry.name, bytes, ageSec: Math.round(ageMs / 1000) }, 'Temp sweep: removed orphaned dir');
    } catch (err) {
      logger.warn({ dir: entry.name, err: err.message }, 'Temp sweep: failed to remove dir');
    }
  }

  if (sweptCount > 0) {
    logger.info(
      { sweptCount, sweptBytes, sweptMB: (sweptBytes / 1024 / 1024).toFixed(1) },
      'Temp sweep complete',
    );
  } else {
    logger.info({ baseDir, dirCount: entries.length }, 'Temp sweep: no orphaned directories found');
  }
}

async function main() {
  // Start the BullMQ worker in the same process (simple deployment)
  // For separate worker processes: run `node src/worker.js` instead
  startWorker();

  // Sweep orphaned temp directories on startup, then every hour.
  // This catches chunks that failed after exhausting retries and left their
  // tempDir behind (the per-job finally block now handles this going forward,
  // but this sweep handles any dirs left by prior runs or edge cases).
  sweepOrphanedTempDirs().catch((err) =>
    logger.warn({ err: err.message }, 'Startup temp sweep error'),
  );
  setInterval(() => {
    sweepOrphanedTempDirs().catch((err) =>
      logger.warn({ err: err.message }, 'Periodic temp sweep error'),
    );
  }, SWEEP_INTERVAL_MS);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Render worker HTTP server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down gracefully');
    server.close(async () => {
      try {
        await getQueue(QUEUE_NAME).close();
        await getQueue(QUEUE_CHUNK).close();
        await getQueue(QUEUE_STITCH).close();
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

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err: err.message }, 'Fatal startup error');
    process.exit(1);
  });
}

module.exports = app; // exported for supertest
