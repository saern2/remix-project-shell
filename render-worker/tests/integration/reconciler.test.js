'use strict';

/**
 * The reconciler: work that leaves the runnable path comes back and says so.
 *
 * Every alarm this worker owns watches RUNNING work — the chunk watchdog arms on
 * start, stall notices track active chunks, BullMQ's stalled detection needs a
 * lock to go missing, and the stitch parent waits on its children without ever
 * asking whether they still exist. Four projects sat one chunk from done for
 * five hours and not one of those mechanisms had anything to say.
 *
 * chunkRecovery closes the specific door found in that incident. This closes the
 * class. These tests therefore do NOT reproduce the known bug — they invent new
 * ways for a chunk to vanish and check the parent still notices.
 *
 * Real Redis and real flows throughout: the whole subject is what BullMQ does
 * with dependencies when a child misbehaves.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
// Database 5 — 6, 7, 8 and 9 belong to other suites and vitest runs files in parallel.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/5';
process.env.REDIS_URL = REDIS_URL;

const IORedis = require('ioredis');
const { Queue, Worker, FlowProducer, Job } = require('bullmq');
const {
  reconcileOnce,
  resetReconcilerState,
  CONFIRMATIONS_BEFORE_ACTION,
  MAX_RECONCILES_PER_PROJECT,
} = require('../../src/reconciler');

const CHUNK_QUEUE = 'test-recon-chunk';
const STITCH_QUEUE = 'test-recon-stitch';

let redis;
let chunkQueue;
let stitchQueue;
let flow;
const workers = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeoutMs = 15000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(everyMs);
  }
  return false;
}

const conn = () => new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

beforeAll(async () => {
  redis = conn();
  await redis.ping();
  chunkQueue = new Queue(CHUNK_QUEUE, { connection: conn() });
  stitchQueue = new Queue(STITCH_QUEUE, { connection: conn() });
  flow = new FlowProducer({ connection: conn() });
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
  resetReconcilerState();
});

async function buildFlow(projectId, chunkCount, { attempts = 1 } = {}) {
  return flow.add({
    name: 'stitch',
    queueName: STITCH_QUEUE,
    data: { is_stitch: true, chunks_total: chunkCount },
    opts: { jobId: `${projectId}-stitch` },
    children: Array.from({ length: chunkCount }, (_, index) => ({
      name: 'chunk',
      queueName: CHUNK_QUEUE,
      data: { is_chunk: true, chunk_index: index, chunks_total: chunkCount, job_id: projectId },
      opts: { jobId: `${projectId}-chunk-${index}`, attempts },
    })),
  });
}

const sweep = () => reconcileOnce({ stitchQueue, chunkQueue, redis });

describe('a healthy project is left completely alone', () => {
  it('says nothing while chunks are queued and runnable', async () => {
    await buildFlow('healthy', 3);

    // Waiting on work that exists and can run: the normal state of every
    // in-flight project. A reconciler that touches this would be worse than
    // none at all.
    expect(await sweep()).toEqual([]);
    expect(await sweep()).toEqual([]);
    expect(await sweep()).toEqual([]);
    expect(await chunkQueue.getWaitingCount()).toBe(3);
  }, 30000);
});

describe('a chunk that vanishes from every queue', () => {
  it('is noticed and reported rather than waited on forever', async () => {
    // A door nobody has walked through yet: the job is simply gone. It cannot
    // be rebuilt — its clip list lived in the job, and inventing new chunk
    // boundaries would silently produce a different video — so the reconciler's
    // job here is to be loud, not clever.
    await buildFlow('vanisher', 2);
    // Delete the job HASH, leaving the parent's dependency intact. job.remove()
    // would be the wrong simulation: BullMQ tears down the dependency link with
    // it, so the parent stops waiting and there is nothing to reconcile. The
    // dangerous shape is the one where the parent still waits for something
    // that is no longer there.
    await redis.del(`bull:${CHUNK_QUEUE}:vanisher-chunk-1`);

    // One sweep is not enough: acting on a single observation would race
    // ordinary state transitions.
    expect(await sweep()).toEqual([]);

    const findings = await sweep();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ projectId: 'vanisher', action: 'repaired', missing: 1 });
  }, 30000);

  it('needs the SAME project to look wrong twice', async () => {
    expect(CONFIRMATIONS_BEFORE_ACTION).toBe(2);
    await buildFlow('flapper', 2);
    const snapshot = await redis.hgetall(`bull:${CHUNK_QUEUE}:flapper-chunk-1`);
    await redis.del(`bull:${CHUNK_QUEUE}:flapper-chunk-1`);

    expect(await sweep()).toEqual([]);

    // The project recovers on its own before the second sweep — a real
    // possibility while a chunk is mid-transition. The strike must reset.
    await redis.hset(`bull:${CHUNK_QUEUE}:flapper-chunk-1`, snapshot);

    expect(await sweep()).toEqual([]);
  }, 30000);
});

describe('a terminally failed chunk is put back', () => {
  it('requeues it and the project finishes', async () => {
    await buildFlow('failer', 1, { attempts: 1 });

    let attempts = 0;
    const worker = new Worker(
      CHUNK_QUEUE,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('bad clip');
        return { ok: true };
      },
      { connection: conn() },
    );
    workers.push(worker);

    await until(async () => (await chunkQueue.getFailedCount()) === 1);
    await worker.pause();

    await sweep();
    const findings = await sweep();
    expect(findings[0]).toMatchObject({ projectId: 'failer', action: 'repaired', requeued: 1 });

    await worker.resume();
    const released = await until(async () => {
      const parent = await Job.fromId(stitchQueue, 'failer-stitch');
      const state = await parent?.getState();
      return state === 'waiting' || state === 'active' || state === 'completed';
    });
    expect(released).toBe(true);

    await worker.close();
  }, 60000);
});

describe('the reconciler cannot become its own silent loop', () => {
  it('fails the render visibly after MAX_RECONCILES_PER_PROJECT', async () => {
    // Repairing forever would be the exact failure this exists to prevent,
    // wearing its uniform.
    await buildFlow('hopeless', 2);
    await redis.del(`bull:${CHUNK_QUEUE}:hopeless-chunk-1`);

    let declared = null;
    for (let round = 0; round < (MAX_RECONCILES_PER_PROJECT + 1) * 2; round += 1) {
      const findings = await sweep();
      const verdict = findings.find((finding) => finding.action === 'declared-unrecoverable');
      if (verdict) {
        declared = verdict;
        break;
      }
    }

    expect(declared).not.toBeNull();

    // The verdict is written where getJobStatus already looks, so the client
    // sees a failure through the path it is already polling.
    const parent = await Job.fromId(stitchQueue, 'hopeless-stitch');
    expect(parent.data._status).toBe('failed');
    expect(parent.data._error).toMatch(/could not finish/i);
    // A person reads this, so it says what to do and that nothing was lost.
    expect(parent.data._error).toMatch(/start the render again/i);
    expect(parent.data._error).not.toMatch(/dependency|unprocessed|bullmq/i);
  }, 60000);
});

describe('the janitor cannot destroy what the reconciler needs', () => {
  it('skips temp directories belonging to a project still waiting', () => {
    // MEASURED on 2026-08-09: the sweep deleted 61 directories and 968 MB
    // belonging to two of the four stalled projects, judging by mtime alone
    // while their stitch parents were still waiting. Recovering those chunks
    // afterwards could not have worked — the stitch would have died on "Chunk
    // file missing for concat". A repair path is worthless if the janitor
    // throws away the parts first.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const sweepFn = source.slice(source.indexOf('async function sweepOrphanedTempDirs'));

    expect(sweepFn).toMatch(/getWaitingChildren\(\)/);
    expect(sweepFn).toMatch(/liveProjects\.has\(owningProject\)/);
    // The guard must sit BEFORE the age test, or an old directory is deleted
    // before anyone asks who owns it.
    expect(sweepFn.indexOf('liveProjects.has(owningProject)')).toBeLessThan(
      sweepFn.indexOf('ORPHAN_AGE_MS'),
    );
    // And when it cannot tell, it sweeps nothing: disk is recoverable, a render
    // is not.
    expect(sweepFn).toMatch(/skipping this sweep/);
  });
});
