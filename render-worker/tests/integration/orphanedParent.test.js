'use strict';

/**
 * A terminally-failed chunk must not strand its stitch parent.
 *
 * THE 5-HOUR STALL, 2026-08-09. Four projects sat at their final 1-2 chunks for
 * five hours on a completely idle machine. Redis:
 *
 *   render-chunk    failed: 5   -> across FOUR distinct projects
 *   render-stitch   waiting-children: 4
 *
 * Four projects with a terminally failed chunk, four parents waiting. In a
 * BullMQ flow a parent leaves waiting-children only when every child COMPLETES;
 * a child that exhausts its attempts sits in `failed` and its dependency is
 * never resolved. Nothing in this codebase set failParentOnFailure or
 * ignoreDependencyOnFailure, so the wait was unbounded — and silent, because
 * every alarm we own watches RUNNING work and this work had stopped running.
 *
 * These run against a REAL Redis and a REAL BullMQ flow. That is not
 * decoration: the bug lives entirely in BullMQ's dependency semantics, and a
 * mocked queue asserts my beliefs about those semantics rather than the
 * semantics. The pre-existing unit tests all passed throughout the incident.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
// Database 6 — 7, 8 and 9 belong to other suites and vitest runs files in parallel.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/6';
process.env.REDIS_URL = REDIS_URL;

const IORedis = require('ioredis');
const { Queue, Worker, FlowProducer, Job } = require('bullmq');
const {
  recoverFailedChunk,
  isTerminalFailure,
  clearRecovery,
  MAX_CHUNK_RECOVERIES,
} = require('../../src/chunkRecovery');

const CHUNK_QUEUE = 'test-orphan-chunk';
const STITCH_QUEUE = 'test-orphan-stitch';

let redis;
let chunkQueue;
let stitchQueue;
let flow;
const workers = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a predicate, polling — real queues settle asynchronously. */
async function until(predicate, { timeoutMs = 15000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(everyMs);
  }
  return false;
}

beforeAll(async () => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  chunkQueue = new Queue(CHUNK_QUEUE, { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
  stitchQueue = new Queue(STITCH_QUEUE, { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
  flow = new FlowProducer({ connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
}, 30000);

afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await chunkQueue.close();
  await stitchQueue.close();
  await flow.close();
  await redis.flushdb();
  await redis.quit();
}, 30000);

beforeEach(async () => {
  await redis.flushdb();
});

/** A flow of one always-failing chunk under a stitch parent. */
async function buildFlow(projectId, { attempts = 1 } = {}) {
  return flow.add({
    name: 'stitch',
    queueName: STITCH_QUEUE,
    data: { is_stitch: true, chunks_total: 1 },
    opts: { jobId: `${projectId}-stitch` },
    children: [
      {
        name: 'chunk',
        queueName: CHUNK_QUEUE,
        data: { is_chunk: true, chunk_index: 0, chunks_total: 1, job_id: projectId },
        opts: { jobId: `${projectId}-chunk-0`, attempts },
      },
    ],
  });
}

describe('the mechanism that stranded four projects', () => {
  it('leaves the parent in waiting-children forever when a child fails', async () => {
    // The bug itself, reproduced against real BullMQ. This is the behaviour the
    // fix has to work around — it is not something we can turn off after the
    // fact, which is precisely why the recovery has to exist.
    const projectId = 'orphan-demo';
    await buildFlow(projectId, { attempts: 1 });

    const worker = new Worker(
      CHUNK_QUEUE,
      async () => {
        throw new Error('clip source is gone');
      },
      { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) },
    );
    workers.push(worker);

    const failed = await until(async () => (await chunkQueue.getFailedCount()) === 1);
    expect(failed).toBe(true);

    // Give the parent every chance to notice. It will not.
    await sleep(1500);
    const parent = await Job.fromId(stitchQueue, `${projectId}-stitch`);
    expect(await parent.getState()).toBe('waiting-children');

    // And nothing is runnable anywhere: the exact "idle machine, stalled
    // project" signature from the incident.
    expect(await chunkQueue.getActiveCount()).toBe(0);
    expect(await chunkQueue.getWaitingCount()).toBe(0);
    expect(await chunkQueue.getDelayedCount()).toBe(0);

    await worker.close();
  }, 40000);
});

describe('recovery puts the chunk back where a worker will find it', () => {
  it('requeues a terminally failed chunk and the project completes', async () => {
    // The end-to-end proof: a chunk that fails all its attempts is recovered,
    // runs again, completes, and releases the parent.
    const projectId = 'orphan-recovers';
    await buildFlow(projectId, { attempts: 1 });

    let attemptCount = 0;
    const worker = new Worker(
      CHUNK_QUEUE,
      async () => {
        attemptCount += 1;
        // Fail the first run the way a bad clip source would; succeed after.
        if (attemptCount === 1) throw new Error('clip source is gone');
        return { ok: true };
      },
      { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) },
    );
    worker.on('failed', (job, err) => {
      if (!job) return;
      void recoverFailedChunk({ redis, job, error: err });
    });
    workers.push(worker);

    const parentReleased = await until(async () => {
      const parent = await Job.fromId(stitchQueue, `${projectId}-stitch`);
      const state = await parent?.getState();
      return state === 'waiting' || state === 'active' || state === 'completed';
    });

    expect(parentReleased).toBe(true);
    expect(attemptCount).toBeGreaterThanOrEqual(2);
    expect(await chunkQueue.getFailedCount()).toBe(0);

    await worker.close();
  }, 40000);

  it('wakes a worker that is idle-blocked on an empty queue', async () => {
    // The requeue goes through job.retry(), whose Lua maintains the queue
    // marker. A hand-rolled zset move would leave the job sitting where a
    // sleeping worker never looks — the same silence in a new costume — and
    // this is the assertion that would catch it.
    const projectId = 'orphan-wakes';
    await buildFlow(projectId, { attempts: 1 });

    let attemptCount = 0;
    const worker = new Worker(
      CHUNK_QUEUE,
      async () => {
        attemptCount += 1;
        if (attemptCount === 1) throw new Error('transient');
        return { ok: true };
      },
      { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) },
    );
    workers.push(worker);

    await until(async () => (await chunkQueue.getFailedCount()) === 1);
    // The worker is now idle and blocked: nothing runnable exists.
    await sleep(500);
    expect(await chunkQueue.getActiveCount()).toBe(0);

    const failedJob = await Job.fromId(chunkQueue, `${projectId}-chunk-0`);
    const outcome = await recoverFailedChunk({ redis, job: failedJob, error: new Error('transient') });
    expect(outcome.action).toBe('retried');

    // Picked up without any restart, nudge, or new job being added.
    const pickedUp = await until(() => Promise.resolve(attemptCount >= 2), { timeoutMs: 10000 });
    expect(pickedUp).toBe(true);

    await worker.close();
  }, 40000);
});

describe('recovery is bounded', () => {
  it('stops after MAX_CHUNK_RECOVERIES and says so', async () => {
    // A chunk whose source is genuinely gone must not be retried forever;
    // repeating it only extends the silence this exists to end.
    const projectId = 'orphan-bounded';
    await buildFlow(projectId, { attempts: 1 });

    const worker = new Worker(
      CHUNK_QUEUE,
      async () => {
        throw new Error('permanently broken');
      },
      { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) },
    );
    workers.push(worker);

    await until(async () => (await chunkQueue.getFailedCount()) === 1);

    const outcomes = [];
    for (let i = 0; i < MAX_CHUNK_RECOVERIES + 2; i += 1) {
      await until(async () => (await chunkQueue.getFailedCount()) === 1);
      const job = await Job.fromId(chunkQueue, `${projectId}-chunk-0`);
      outcomes.push(
        (await recoverFailedChunk({ redis, job, error: new Error('permanently broken') })).action,
      );
    }

    expect(outcomes.filter((action) => action === 'retried')).toHaveLength(MAX_CHUNK_RECOVERIES);
    expect(outcomes[outcomes.length - 1]).toBe('exhausted');

    await worker.close();
  }, 60000);

  it('counts recoveries in Redis, so a restart cannot reset the bound', async () => {
    const key = 'restart-proof-chunk';
    const fakeJob = { id: key, attemptsMade: 1, opts: { attempts: 1 }, retry: async () => {} };

    for (let i = 0; i < MAX_CHUNK_RECOVERIES; i += 1) {
      expect((await recoverFailedChunk({ redis, job: fakeJob, error: null })).action).toBe('retried');
    }
    // A "restarted" worker reads the same counter and refuses to start over.
    expect((await recoverFailedChunk({ redis, job: fakeJob, error: null })).action).toBe('exhausted');

    // ...and a chunk that succeeds forgets its history, so a later unrelated
    // failure gets a full allowance again.
    await clearRecovery(redis, key);
    expect((await recoverFailedChunk({ redis, job: fakeJob, error: null })).action).toBe('retried');
  }, 20000);

  it('leaves a chunk alone while BullMQ still has attempts for it', () => {
    // Recovering early would multiply attempts behind BullMQ's back and skip
    // the backoff that makes a transient failure worth retrying.
    expect(isTerminalFailure({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isTerminalFailure({ attemptsMade: 3, opts: { attempts: 3 } })).toBe(true);
    expect(isTerminalFailure({ attemptsMade: 1, opts: {} })).toBe(true);
  });
});
