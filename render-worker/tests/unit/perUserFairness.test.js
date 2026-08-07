'use strict';

/**
 * Per-user fairness.
 *
 * Admission counts PROJECTS, which is right for capacity and wrong for
 * fairness: it is first-come-first-served, so one account submitting five
 * projects fills all three slots and blocks every other user until they finish.
 * That is fine for one operator testing alone and unacceptable with real users.
 *
 * The cap bounds how much of the platform any one account holds at once. Total
 * concurrency is untouched — this only decides WHOSE work fills the slots.
 *
 * Two properties carry the whole feature, and both are easy to get subtly wrong:
 *
 *   1. A user at their cap must be SKIPPED, not block the queue behind them.
 *      Enforcing the cap while still admitting strictly in FIFO order would
 *      reintroduce head-of-line blocking one layer down — the queue would stall
 *      on an ineligible head while slots sat empty.
 *   2. The position a user is SHOWN has to account for the skipping. Raw FIFO
 *      rank becomes a confident, specific lie the moment the cap exists.
 *
 * Run against a real Redis: the mechanism is a Lua script, and a mock would only
 * pin my idea of what Redis does.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
// Database 7 — the admission suite owns 9 and the freeze suite owns 8. All three
// touch the same keys and vitest runs files in parallel.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/7';
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
    admission.OWNER_KEY,
    admission.STITCHING_KEY,
  );
  config.renderAdmissionLimit = 3;
  config.renderAdmissionPerUserLimit = 2;
});

describe('one user cannot take the whole machine', () => {
  it('admits two of a user’s five projects and queues the rest', async () => {
    const results = [];
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      results.push(await admission.tryAdmit(redis, id, 'userA'));
    }
    expect(results.map((r) => r.admitted)).toEqual([true, true, false, false, false]);
    expect(await redis.zcard(admission.ACTIVE_KEY)).toBe(2);
  });

  it('leaves the third slot for somebody else', async () => {
    // The point of the whole feature: user A queued first and still does not
    // get the last slot.
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      await admission.tryAdmit(redis, id, 'userA');
    }
    const b = await admission.tryAdmit(redis, 'b1', 'userB');
    expect(b.admitted).toBe(true);
    expect(await redis.zcard(admission.ACTIVE_KEY)).toBe(3);
  });

  it('holds the cap under concurrent asks', async () => {
    // Same reason the platform cap is one Lua script: two round trips would let
    // five of one user's projects all read "0 active" and admit themselves.
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => admission.tryAdmit(redis, id, 'userA')),
    );
    expect(results.filter((r) => r.admitted)).toHaveLength(2);
  });

  it('frees a user’s allowance when one of their projects finishes', async () => {
    for (const id of ['a1', 'a2', 'a3']) await admission.tryAdmit(redis, id, 'userA');
    expect((await admission.tryAdmit(redis, 'a3', 'userA')).admitted).toBe(false);

    await admission.release(redis, 'a1');
    expect((await admission.tryAdmit(redis, 'a3', 'userA')).admitted).toBe(true);
  });

  it('still respects the platform cap when many users queue', async () => {
    // Per-user fairness must not raise total concurrency.
    for (const [id, owner] of [
      ['a1', 'userA'],
      ['b1', 'userB'],
      ['c1', 'userC'],
      ['d1', 'userD'],
    ]) {
      await admission.tryAdmit(redis, id, owner);
    }
    expect(await redis.zcard(admission.ACTIVE_KEY)).toBe(3);
    expect((await admission.tryAdmit(redis, 'd1', 'userD')).admitted).toBe(false);
  });
});

describe('a capped user does not block the queue behind them', () => {
  it('skips an ineligible head and admits the first eligible waiter', async () => {
    // THE head-of-line trap. userA is at their cap with a3/a4 queued ahead of
    // b1. Admitting strictly in FIFO order would leave the freed slot empty
    // while a3 sits at the head, ineligible — the exact failure the cap exists
    // to prevent, one layer down.
    for (const id of ['a1', 'a2']) await admission.tryAdmit(redis, id, 'userA');
    await admission.tryAdmit(redis, 'c1', 'userC');
    await admission.tryAdmit(redis, 'a3', 'userA');
    await admission.tryAdmit(redis, 'a4', 'userA');
    await admission.tryAdmit(redis, 'b1', 'userB');

    // A slot frees. a3 is at the head of the queue but its owner is at cap.
    await admission.release(redis, 'c1');

    expect((await admission.tryAdmit(redis, 'a3', 'userA')).admitted).toBe(false);
    expect((await admission.tryAdmit(redis, 'b1', 'userB')).admitted).toBe(true);
  });

  it('gives a capped user their slot back as soon as they have room', async () => {
    for (const id of ['a1', 'a2']) await admission.tryAdmit(redis, id, 'userA');
    await admission.tryAdmit(redis, 'a3', 'userA');
    await admission.tryAdmit(redis, 'b1', 'userB');

    await admission.release(redis, 'a1');
    // Now userA holds one slot, so a3 is eligible again and is ahead of b1.
    expect((await admission.tryAdmit(redis, 'a3', 'userA')).admitted).toBe(true);
  });
});

describe('unowned work is exempt rather than rejected', () => {
  it('admits projects with no owner up to the platform cap', async () => {
    // Older payloads and direct API calls carry no owner. The cap must not
    // become a way to refuse work it cannot classify.
    const results = [];
    for (const id of ['x1', 'x2', 'x3', 'x4']) {
      results.push(await admission.tryAdmit(redis, id, null));
    }
    expect(results.map((r) => r.admitted)).toEqual([true, true, true, false]);
  });

  it('does not lump unowned projects together as one pseudo-user', async () => {
    // If an absent owner became the string "null", three unowned projects would
    // share a cap of two and the third would wait for no reason.
    for (const id of ['x1', 'x2', 'x3']) await admission.tryAdmit(redis, id, null);
    expect(await redis.zcard(admission.ACTIVE_KEY)).toBe(3);
  });

  it('can be switched off entirely for a single-operator box', async () => {
    config.renderAdmissionPerUserLimit = 0;
    const results = [];
    for (const id of ['a1', 'a2', 'a3']) {
      results.push(await admission.tryAdmit(redis, id, 'userA'));
    }
    expect(results.every((r) => r.admitted)).toBe(true);
  });
});

describe('the owner map does not leak', () => {
  it('forgets a project when it is released', async () => {
    await admission.tryAdmit(redis, 'a1', 'userA');
    expect(await redis.hget(admission.OWNER_KEY, 'a1')).toBe('userA');
    await admission.release(redis, 'a1');
    expect(await redis.hget(admission.OWNER_KEY, 'a1')).toBeNull();
  });

  it('forgets a project whose worker died', async () => {
    // Otherwise a crashed project would count against its owner's cap forever,
    // which is the OOM-kill scenario turned into a permanent penalty.
    await admission.tryAdmit(redis, 'a1', 'userA');
    await redis.zadd(admission.ACTIVE_KEY, Date.now() - admission.ADMISSION_TTL_MS - 1000, 'a1');

    await admission.tryAdmit(redis, 'b1', 'userB');

    expect(await redis.hget(admission.OWNER_KEY, 'a1')).toBeNull();
    // ...and userA can start fresh work immediately.
    for (const id of ['a2', 'a3']) {
      expect((await admission.tryAdmit(redis, id, 'userA')).admitted).toBe(true);
    }
  });
});

describe('the position a user is shown reflects the cap', () => {
  const owners = {
    a1: 'A', a2: 'A', a3: 'A', a4: 'A', a5: 'A',
    b1: 'B',
    c1: 'C',
  };

  it('does not tell a user they are sixth when they are next', () => {
    // Raw rank would say 6. Every one of A's five is skipped because A is
    // already at their cap, so B goes in as soon as a slot frees. "Position 6"
    // would be worse than showing nothing: specific, confident and wrong.
    const position = admission.effectiveQueuePosition({
      projectId: 'b1',
      waiting: ['a3', 'a4', 'a5', 'b1'],
      active: ['a1', 'a2', 'c1'],
      owners,
      perUser: 2,
    });
    expect(position).toBe(1);
  });

  it('counts a user’s own earlier projects, cap or no cap', () => {
    // A's queue is FIFO within itself: a5 really does wait for a3 and a4.
    const position = admission.effectiveQueuePosition({
      projectId: 'a5',
      waiting: ['a3', 'a4', 'b1', 'a5'],
      active: ['a1', 'a2', 'c1'],
      owners,
      perUser: 2,
    });
    // a3, a4 (same owner) and b1 (eligible) are all genuinely ahead.
    expect(position).toBe(4);
  });

  it('counts other users normally while they have room', () => {
    const position = admission.effectiveQueuePosition({
      projectId: 'c1',
      waiting: ['b1', 'c1'],
      active: ['a1', 'a2', 'a3'],
      owners: { ...owners, a3: 'A', b1: 'B', c1: 'C' },
      perUser: 2,
    });
    expect(position).toBe(2);
  });

  it('falls back to raw rank when the cap is disabled', () => {
    const position = admission.effectiveQueuePosition({
      projectId: 'b1',
      waiting: ['a3', 'a4', 'a5', 'b1'],
      active: ['a1', 'a2', 'c1'],
      owners,
      perUser: 0,
    });
    expect(position).toBe(4);
  });

  it('returns 0 for a project that is not waiting', () => {
    expect(
      admission.effectiveQueuePosition({
        projectId: 'a1',
        waiting: ['b1'],
        active: ['a1'],
        owners,
        perUser: 2,
      }),
    ).toBe(0);
  });

  it('treats unowned waiters as always ahead', () => {
    const position = admission.effectiveQueuePosition({
      projectId: 'b1',
      waiting: ['x1', 'x2', 'b1'],
      active: ['a1', 'a2', 'c1'],
      owners: { b1: 'B' },
      perUser: 2,
    });
    expect(position).toBe(3);
  });

  it('is what the status endpoint actually uses', () => {
    // The pure function is worthless if the endpoint still reports raw rank.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/queue.js'), 'utf8');
    expect(src).toMatch(/admission\.effectiveQueuePosition\(\{/);
    expect(src).not.toMatch(/snapshot\.waiting\.indexOf\(projectId\) \+ 1/);
  });
});
