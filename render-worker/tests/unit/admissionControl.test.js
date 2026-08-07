'use strict';

/**
 * Admission control: how many projects render at once, and in what order.
 *
 * THE RUN THIS COMES FROM. On 2026-08-07 five ~45-minute projects were admitted
 * together. Aggregate throughput was fine; ordering was not. All five finish
 * lines converged, and the last project sat for 15m10s between its final chunk
 * and its video — a stitch of about 3m30s behind other projects' stitches.
 *
 * Capping concurrent projects does not make the machine faster. It makes
 * finishing times sequential and, more importantly, KNOWABLE: a project that is
 * waiting can be told where it is in line. These tests pin the two properties
 * that claim depends on — the cap actually holds under concurrent asks, and the
 * order a project is shown is the order it is admitted in.
 *
 * Run against a real Redis rather than a mock, because the whole mechanism is a
 * Lua script and a mock would only pin my idea of what Redis does.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const fs = require('fs');
const path = require('path');

process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/9';
process.env.REDIS_URL = REDIS_URL;

const IORedis = require('ioredis');
const config = require('../../src/config');
const admission = require('../../src/admissionControl');

let redis;

beforeAll(async () => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.del(
    admission.ACTIVE_KEY,
    admission.WAITING_KEY,
    admission.WAITING_SEEN_KEY,
    admission.STITCHING_KEY,
    admission.CHUNK_SECONDS_KEY,
  );
  config.renderAdmissionLimit = 3;
});

describe('the cap', () => {
  it('admits up to the limit and queues the rest', async () => {
    const results = [];
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      results.push(await admission.tryAdmit(redis, id));
    }
    expect(results.map((r) => r.admitted)).toEqual([true, true, true, false]);
    expect(results[3].position).toBe(1);
  });

  it('holds when four projects ask at the same moment', async () => {
    // The reason the check-and-add is one Lua script: two round trips would let
    // every one of these read "2 active" and all four admit themselves.
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) => admission.tryAdmit(redis, id)),
    );
    expect(results.filter((r) => r.admitted)).toHaveLength(3);
    expect(await redis.zcard(admission.ACTIVE_KEY)).toBe(3);
  });

  it('does not consume a second slot when an admitted project asks again', async () => {
    // Every chunk of an admitted project calls this. If each ask took a slot the
    // cap would be meaningless after the first few chunks.
    await admission.tryAdmit(redis, 'p1');
    for (let i = 0; i < 10; i += 1) {
      const again = await admission.tryAdmit(redis, 'p1');
      expect(again.admitted).toBe(true);
    }
    expect(await redis.zcard(admission.ACTIVE_KEY)).toBe(1);
  });
});

describe('the queue position we show is the order we admit in', () => {
  it('keeps a waiting project at the same position while it polls', async () => {
    for (const id of ['p1', 'p2', 'p3']) await admission.tryAdmit(redis, id);
    await admission.tryAdmit(redis, 'p4');
    await admission.tryAdmit(redis, 'p5');

    for (let i = 0; i < 5; i += 1) {
      expect((await admission.tryAdmit(redis, 'p4')).position).toBe(1);
      expect((await admission.tryAdmit(redis, 'p5')).position).toBe(2);
    }
  });

  it('gives a freed slot to the longest waiter, not to whoever polls first', async () => {
    // Without the head-of-queue check this passes only by luck of scheduling,
    // and the position shown to p4 would be a lie the moment p5 jumped it.
    for (const id of ['p1', 'p2', 'p3']) await admission.tryAdmit(redis, id);
    await admission.tryAdmit(redis, 'p4');
    await admission.tryAdmit(redis, 'p5');

    await admission.release(redis, 'p1');

    const jumper = await admission.tryAdmit(redis, 'p5');
    expect(jumper.admitted).toBe(false);
    expect(jumper.position).toBe(2);

    const head = await admission.tryAdmit(redis, 'p4');
    expect(head.admitted).toBe(true);

    // p5 moves up only once p4 is out of the queue.
    expect((await admission.tryAdmit(redis, 'p5')).position).toBe(1);
  });

  it('reports position 0 for a project that is not waiting', async () => {
    await admission.tryAdmit(redis, 'p1');
    expect(await admission.queuePosition(redis, 'p1')).toBe(0);
    expect(await admission.queuePosition(redis, 'never-seen')).toBe(0);
  });
});

describe('a dead worker cannot hold capacity', () => {
  it('ages out an admission that stopped heartbeating', async () => {
    // The OOM kills are exactly when a slot would leak: the process dies with no
    // chance to release. Expiry is what makes that survivable.
    for (const id of ['p1', 'p2', 'p3']) await admission.tryAdmit(redis, id);
    expect((await admission.tryAdmit(redis, 'p4')).admitted).toBe(false);

    const stale = Date.now() - admission.ADMISSION_TTL_MS - 1000;
    await redis.zadd(admission.ACTIVE_KEY, stale, 'p1');

    const after = await admission.tryAdmit(redis, 'p4');
    expect(after.admitted).toBe(true);
    expect(await redis.zscore(admission.ACTIVE_KEY, 'p1')).toBeNull();
  });

  it('keeps a slot alive while the heartbeat runs', async () => {
    await admission.tryAdmit(redis, 'p1');
    const stale = Date.now() - admission.ADMISSION_TTL_MS - 1000;
    await redis.zadd(admission.ACTIVE_KEY, stale, 'p1');

    await admission.refresh(redis, 'p1');

    // A sweep triggered by someone else's ask must not evict it now.
    await admission.tryAdmit(redis, 'p2');
    expect(await redis.zscore(admission.ACTIVE_KEY, 'p1')).not.toBeNull();
  });

  it('drops a waiter that stopped polling instead of inflating the queue', async () => {
    for (const id of ['p1', 'p2', 'p3']) await admission.tryAdmit(redis, id);
    await admission.tryAdmit(redis, 'dead');
    await admission.tryAdmit(redis, 'live');
    expect((await admission.tryAdmit(redis, 'live')).position).toBe(2);

    // `dead` was cancelled and will never ask again. Its WAITING_KEY score is its
    // first ask, so only the separate last-seen record can tell it apart from a
    // patient waiter.
    await redis.hset(
      admission.WAITING_SEEN_KEY,
      'dead',
      String(Date.now() - admission.ADMISSION_TTL_MS - 1000),
    );

    expect((await admission.tryAdmit(redis, 'live')).position).toBe(1);
  });
});

describe('stitches are counted in the same view', () => {
  it('reports active, waiting and stitching together', async () => {
    for (const id of ['p1', 'p2', 'p3']) await admission.tryAdmit(redis, id);
    await admission.tryAdmit(redis, 'p4');
    await admission.markStitching(redis, 'p1');

    const snapshot = await admission.admissionSnapshot(redis);
    expect(snapshot.limit).toBe(3);
    expect(snapshot.activeCount).toBe(3);
    expect(snapshot.waitingCount).toBe(1);
    expect(snapshot.stitchingCount).toBe(1);
    // A stitching project is still an ADMITTED project — the whole point is that
    // it holds its slot through the stitch.
    expect(snapshot.active).toContain('p1');
  });

  it('frees everything on release', async () => {
    await admission.tryAdmit(redis, 'p1');
    await admission.markStitching(redis, 'p1');
    await admission.release(redis, 'p1');

    const snapshot = await admission.admissionSnapshot(redis);
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.stitchingCount).toBe(0);
  });
});

describe('the wait estimate is measured, not invented', () => {
  it('returns null until this machine has actually timed a chunk', async () => {
    expect(await admission.measuredChunkSeconds(redis)).toBeNull();
    const snapshot = await admission.admissionSnapshot(redis);
    expect(snapshot.secondsPerChunk).toBeNull();
  });

  it('takes the median so one watchdog kill cannot distort it', async () => {
    for (const seconds of [40, 42, 44, 46, 48]) {
      await admission.recordChunkSeconds(redis, seconds);
    }
    expect(await admission.measuredChunkSeconds(redis)).toBe(44);

    // A chunk killed at CHUNK_TIMEOUT_SECONDS would drag a mean from 44 to 87.
    await admission.recordChunkSeconds(redis, 300);
    const median = await admission.measuredChunkSeconds(redis);
    expect(median).toBeLessThan(50);
  });

  it('ignores nonsense samples', async () => {
    await admission.recordChunkSeconds(redis, 0);
    await admission.recordChunkSeconds(redis, -5);
    await admission.recordChunkSeconds(redis, NaN);
    expect(await admission.measuredChunkSeconds(redis)).toBeNull();
  });
});

describe('estimateWaitSeconds', () => {
  it('is zero for a project that is not waiting', () => {
    expect(admission.estimateWaitSeconds({ position: 0, chunksAhead: 40 })).toBe(0);
  });

  it('scales with the work ahead and shrinks with the lanes', () => {
    // 40 chunks at 45s across 4 lanes = 450s.
    expect(
      admission.estimateWaitSeconds({
        position: 1,
        chunksAhead: 40,
        secondsPerChunk: 45,
        chunkConcurrency: 4,
      }),
    ).toBe(450);

    expect(
      admission.estimateWaitSeconds({
        position: 2,
        chunksAhead: 80,
        secondsPerChunk: 45,
        chunkConcurrency: 4,
      }),
    ).toBe(900);
  });

  it('still produces a number when nothing has been measured', () => {
    // Showing "about 10 minutes" beats showing a spinner, as long as the caller
    // labels it an estimate.
    const estimate = admission.estimateWaitSeconds({ position: 1 });
    expect(estimate).toBeGreaterThan(0);
  });
});

describe('the slot is held until the stitch finishes', () => {
  // This is the decision the module exists for, and it lives in control flow
  // rather than in a value, so it is pinned at the source.
  const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderJob.js'), 'utf8');
  const chunkFn = SOURCE.slice(
    SOURCE.indexOf('async function processRenderJob'),
    SOURCE.length,
  );
  const stitchFn = SOURCE.slice(
    SOURCE.indexOf('async function processStitchJob'),
    SOURCE.indexOf('async function processRenderJob'),
  );

  it('releases in the stitch, not in the chunk', () => {
    expect(stitchFn).toMatch(/admission\.release\(/);
    expect(chunkFn).not.toMatch(/admission\.release\(/);
  });

  it('heartbeats through both phases', () => {
    expect(stitchFn).toMatch(/admission\.startHeartbeat\(/);
    expect(SOURCE.slice(0, SOURCE.indexOf('async function processStitchJob'))
      .concat(chunkFn)).toMatch(/admission\.startHeartbeat\(/);
  });

  it('defers a chunk instead of failing it when there is no room', () => {
    // moveToDelayed + DelayedError, not throw: waiting for capacity must not
    // spend one of the job's three attempts.
    expect(SOURCE).toMatch(/moveToDelayed\(Date\.now\(\) \+ ADMISSION_RETRY_MS, token\)/);
    expect(SOURCE).toMatch(/new DelayedError\(\)/);
  });

  it('checks free memory before starting a chunk', () => {
    expect(SOURCE).toMatch(/hasAdmissionMemoryHeadroom\(\)/);
  });

  it('announces a memory wait and bounds it', () => {
    // A gate that can wait forever silently is the failure mode the watchdog
    // work existed to remove. Waiting must be visible, and it must end.
    expect(SOURCE).toMatch(/state: 'waiting-memory'/);
    expect(SOURCE).toMatch(/waitedMs < MEMORY_WAIT_BUDGET_MS/);
  });
});

describe('the memory gate', () => {
  const resourceControl = require('../../src/resourceControl');
  let savedThreshold;

  beforeEach(() => {
    savedThreshold = config.admissionMinFreeMemoryBytes;
  });

  afterEach(() => {
    config.admissionMinFreeMemoryBytes = savedThreshold;
  });

  it('lets a chunk start when there is headroom', async () => {
    config.admissionMinFreeMemoryBytes = 0;
    const result = await resourceControl.hasAdmissionMemoryHeadroom();
    expect(result.ok).toBe(true);
    expect(result.availableBytes).toBeGreaterThan(0);
  });

  it('holds a chunk back when there is not', async () => {
    // Deliberately unreachable: the point is that the gate reads live memory
    // rather than a startup snapshot, so raising the container limit does not
    // switch it off.
    config.admissionMinFreeMemoryBytes = Number.MAX_SAFE_INTEGER;
    const result = await resourceControl.hasAdmissionMemoryHeadroom();
    expect(result.ok).toBe(false);
    expect(result.requiredBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is a separate, higher bar than the hard failure floor', () => {
    // minFreeMemoryBytes FAILS the job; this one DEFERS it. Collapsing them
    // would turn every transient spike into a spent retry attempt.
    expect(config.admissionMinFreeMemoryBytes).toBeGreaterThan(config.minFreeMemoryBytes);
  });
});
