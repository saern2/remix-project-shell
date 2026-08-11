'use strict';

/**
 * A chunk held at an admission gate is invisible to every queue the poll reads.
 *
 * MEASURED 2026-08-13, project a1a7c67e: 318 consecutive seconds — 80% of a
 * 6m39s render — reported as chunk_state "waiting" with chunks_ahead 0 and 0%
 * progress. Zero ahead is a measurement stating that nothing is in the way, so
 * the screen read as stuck. The render then finished in 80 seconds.
 *
 * The mechanism is structural rather than a mistake in the counting: a gated
 * chunk is moved to DELAYED by deferChunk, and a delayed job appears in
 * neither getActive() nor getPrioritized(). This test reproduces exactly that
 * shape — a real flow whose chunks are delayed, nothing active, nothing
 * prioritized — and asserts the poll now explains it.
 *
 * Real Redis and a real BullMQ flow, because the whole subject is what the
 * queue views do and do not contain.
 */
process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
// Databases 1-11 belong to other suites; vitest runs files in parallel.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/12';
process.env.REDIS_URL = REDIS_URL;

const IORedis = require('ioredis');
const { Queue, FlowProducer, Job } = require('bullmq');
const { getJobStatus, QUEUE_STITCH } = require('../../src/queue');
const { publishJobHealth } = require('../../src/resourceControl');

let redis;
let stitchQueue;
let chunkQueue;
let flow;

const conn = () => new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

beforeAll(async () => {
  redis = conn();
  await redis.ping();
  // The real queue names, because getJobStatus resolves them itself.
  stitchQueue = new Queue('render-stitch', { connection: conn() });
  chunkQueue = new Queue('render-chunk', { connection: conn() });
  flow = new FlowProducer({ connection: conn() });
}, 30000);

afterAll(async () => {
  await stitchQueue.close();
  await chunkQueue.close();
  await flow.close();
  await redis.flushdb();
  await redis.quit();
  const { closeQueueResources } = require('../../src/queue');
  await closeQueueResources();
}, 30000);

beforeEach(async () => {
  await redis.flushdb();
});

/** A project whose chunks exist but are DELAYED — the deferred-chunk shape. */
async function buildDelayedProject(projectId, chunkCount = 4) {
  await flow.add({
    name: 'stitch',
    queueName: 'render-stitch',
    data: { is_stitch: true, chunks_total: chunkCount },
    opts: { jobId: `${projectId}-stitch` },
    children: Array.from({ length: chunkCount }, (_, index) => ({
      name: 'chunk',
      queueName: 'render-chunk',
      data: { is_chunk: true, chunk_index: index, chunks_total: chunkCount, job_id: projectId },
      opts: {
        jobId: `${projectId}-chunk-${index}`,
        // What deferChunk does: park the chunk instead of running it.
        delay: 60_000,
      },
    })),
  });
}

const statusOf = async (projectId) =>
  getJobStatus(await Job.fromId(stitchQueue, `${projectId}-stitch`));

describe('a chunk parked at the admission gate', () => {
  it('is in neither queue the poll reads — the blind spot itself', async () => {
    await buildDelayedProject('blindspot');
    // This is the precondition that made the old output misleading. If either
    // of these ever becomes non-empty, the bug being fixed has changed shape.
    expect(await chunkQueue.getActive()).toEqual([]);
    expect(await chunkQueue.getPrioritized(0, 1000)).toEqual([]);
    expect(await chunkQueue.getDelayedCount()).toBe(4);
  }, 30000);

  it('reported "waiting, 0 ahead" with no notice — the 318-second screen', async () => {
    await buildDelayedProject('nonotice');
    const status = await statusOf('nonotice');
    // Reproduces the deployed output verbatim when nothing explains the wait.
    expect(status.chunk_state).toBe('waiting');
    expect(status.chunks_ahead).toBe(0);
    expect(status.progress_pct).toBe(0);
    expect(status.chunks_completed).toBe(0);
  }, 30000);

  it('says it is queued for a slot, and where, once the gate has spoken', async () => {
    await buildDelayedProject('slotwait');
    await publishJobHealth(redis, 'slotwait', {
      state: 'waiting-slot',
      phase: 'admission',
      chunkIndex: 0,
      position: 3,
      limit: 3,
    });

    const status = await statusOf('slotwait');
    expect(status.chunk_state).toBe('waiting-slot');
    // NOT zero. Zero said nothing was in the way.
    expect(status.chunks_ahead).toBeNull();
    expect(status.queue_position).toBe(3);
  }, 30000);

  it('says it is waiting on memory when that is the gate', async () => {
    await buildDelayedProject('memwait');
    await publishJobHealth(redis, 'memwait', {
      state: 'waiting-memory',
      phase: 'admission',
      chunkIndex: 0,
      elapsedMs: 42_000,
    });

    const status = await statusOf('memwait');
    expect(status.chunk_state).toBe('waiting-memory');
    expect(status.chunks_ahead).toBeNull();
    // A memory hold is not a stall and must not raise the stall warning.
    expect(status.stalled).toBe(false);
  }, 30000);

  it('does not mistake a stall notice for an admission gate', async () => {
    // The health key is shared by every chunk of the project. A watchdog
    // notice must keep its own meaning and still set `stalled`.
    await buildDelayedProject('stalling');
    await publishJobHealth(redis, 'stalling', {
      state: 'stalled',
      phase: 'encoding',
      chunkIndex: 2,
      elapsedMs: 120_000,
    });

    const status = await statusOf('stalling');
    expect(status.chunk_state).toBe('waiting');
    expect(status.stalled).toBe(true);
  }, 30000);

  it('stops explaining once a chunk has actually completed', async () => {
    // From then on the segment counter moves and speaks for itself. A stale
    // "queued for a slot" alongside "1 of 4 segments rendered" would be a new
    // contradiction in place of the old one.
    await flow.add({
      name: 'stitch',
      queueName: 'render-stitch',
      data: { is_stitch: true, chunks_total: 4 },
      opts: { jobId: 'progressing-stitch' },
      children: Array.from({ length: 4 }, (_, index) => ({
        name: 'chunk',
        queueName: 'render-chunk',
        data: { is_chunk: true, chunk_index: index, chunks_total: 4, job_id: 'progressing' },
        // Chunk 0 is runnable; the rest stay parked at the gate.
        opts: { jobId: `progressing-chunk-${index}`, ...(index === 0 ? {} : { delay: 60_000 }) },
      })),
    });
    await publishJobHealth(redis, 'progressing', {
      state: 'waiting-slot',
      phase: 'admission',
      position: 2,
      limit: 3,
    });

    const { Worker } = require('bullmq');
    const worker = new Worker('render-chunk', async () => ({ ok: true }), {
      connection: conn(),
    });
    try {
      const deadline = Date.now() + 15000;
      let status = await statusOf('progressing');
      while (Date.now() < deadline && (status.chunks_completed ?? 0) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await statusOf('progressing');
      }
      expect(status.chunks_completed).toBe(1);
      // The whole visibility block is gated on nothing having completed, so
      // the notice goes quiet even though the health record is still live.
      expect(status.chunk_state).toBeUndefined();
      expect(status.chunks_ahead).toBeUndefined();
      // And progress is moving on its own now.
      expect(status.progress_pct).toBeGreaterThan(0);
    } finally {
      await worker.close();
    }
  }, 30000);
});
