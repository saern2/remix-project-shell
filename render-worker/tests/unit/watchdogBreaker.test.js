'use strict';

/**
 * The watchdog circuit breaker (Round A, Item 1).
 *
 * Run against a real Redis, like admissionControl's tests: the mechanism is
 * ZSET window arithmetic plus a SET NX PX expiring key, and a mock would only
 * pin an idea of what Redis does. The clock is injected (`now`) so windows and
 * pruning are tested without sleeping; the one real-expiry test uses a short
 * PX and a single bounded wait.
 */

const fs = require('fs');
const path = require('path');

process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/9';
process.env.REDIS_URL = REDIS_URL;

const IORedis = require('ioredis');
const admission = require('../../src/admissionControl');
const breaker = require('../../src/watchdogBreaker');

const {
  KILLS_KEY,
  OPEN_KEY,
  OPENS_COUNT_KEY,
  BREAKER_REASON_MARKER,
  BREAKER_USER_MESSAGE,
  recordWatchdogKill,
  isBreakerOpen,
  breakerVerdict,
} = breaker;

/** Small numbers so tests drive the mechanism, not the production defaults. */
const OPTS = { threshold: 3, windowMs: 10_000, openMs: 60_000 };

let redis;

beforeAll(async () => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.del(KILLS_KEY, OPEN_KEY, OPENS_COUNT_KEY, admission.ACTIVE_KEY);
});

async function kill(n, now, opts = OPTS) {
  return recordWatchdogKill(redis, { jobId: `job-${n}`, attempt: 1, now }, opts);
}

describe('recordWatchdogKill — the rolling window', () => {
  it('N-1 kills do not trip; the breaker stays closed', async () => {
    const now = 1_000_000;
    for (let i = 0; i < OPTS.threshold - 1; i++) {
      const outcome = await kill(i, now + i * 100);
      expect(outcome.tripped).toBe(false);
      expect(outcome.opened).toBe(false);
    }
    expect(await isBreakerOpen(redis)).toBeNull();
  });

  it('the Nth kill trips and OPENS — and opens exactly once', async () => {
    const now = 1_000_000;
    await kill(0, now);
    await kill(1, now + 100);
    const third = await kill(2, now + 200);
    expect(third.tripped).toBe(true);
    expect(third.opened).toBe(true); // this call gets the level-50 log
    expect(third.openUntil).toBe(now + 200 + OPTS.openMs);

    // Further kills while open: tripped, but never `opened` again — one alarm
    // per opening, not per kill (the reconciler's 205 re-declarations are the
    // cautionary tale).
    const fourth = await kill(3, now + 300);
    expect(fourth.tripped).toBe(true);
    expect(fourth.opened).toBe(false);
  });

  it('kills outside the window are pruned and do not count', async () => {
    const now = 1_000_000;
    await kill(0, now);
    await kill(1, now + 100);
    // The third kill arrives after the window has slid past the first two.
    const late = await kill(2, now + OPTS.windowMs + 5_000);
    expect(late.count).toBe(1);
    expect(late.tripped).toBe(false);
    expect(await isBreakerOpen(redis)).toBeNull();
  });

  it('closes by plain key expiry and reopens on a fresh breach (B2: no half-open state)', async () => {
    const now = 2_000_000;
    const shortOpen = { ...OPTS, openMs: 300 };
    await kill(0, now, shortOpen);
    await kill(1, now + 10, shortOpen);
    const opened = await kill(2, now + 20, shortOpen);
    expect(opened.opened).toBe(true);
    expect(await isBreakerOpen(redis)).not.toBeNull();

    // The close mechanism is the key's own PX expiry — nothing else.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await isBreakerOpen(redis)).toBeNull();

    // A fresh breach reopens, with `opened` true again — new opening, new alarm.
    const reopened = await kill(3, now + 1_000, shortOpen);
    expect(reopened.tripped).toBe(true);
    expect(reopened.opened).toBe(true);
  });

  it('counts OPENINGS in a 24h tally — once per opening, never per kill', async () => {
    // "It fired once" vs "it has been firing all afternoon", from one GET.
    const now = 4_000_000;
    const shortOpen = { ...OPTS, openMs: 300 };
    expect(await redis.get(OPENS_COUNT_KEY)).toBeNull();

    await kill(0, now, shortOpen);
    await kill(1, now + 10, shortOpen);
    await kill(2, now + 20, shortOpen); // opens
    expect(await redis.get(OPENS_COUNT_KEY)).toBe('1');

    // Kills while already open do not bump the tally.
    await kill(3, now + 30, shortOpen);
    await kill(4, now + 40, shortOpen);
    expect(await redis.get(OPENS_COUNT_KEY)).toBe('1');

    // A second opening after expiry bumps it to 2.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await kill(5, now + 1_000, shortOpen); // reopens (window still holds >= threshold)
    expect(await redis.get(OPENS_COUNT_KEY)).toBe('2');

    // Rolling 24h TTL, so the tally reads "openings in the last day".
    const ttl = await redis.pttl(OPENS_COUNT_KEY);
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe('breakerVerdict — what a chunk arriving at the worker should do', () => {
  it('proceeds while closed, even with sub-threshold kills in the window', async () => {
    // The succeeding chunk's guarantee: below the threshold the breaker
    // changes nothing, for admitted and unadmitted projects alike.
    const now = 3_000_000;
    await kill(0, now);
    await kill(1, now + 100);
    await redis.zadd(admission.ACTIVE_KEY, Date.now(), 'project-admitted');
    expect((await breakerVerdict(redis, 'project-admitted')).action).toBe('proceed');
    expect((await breakerVerdict(redis, 'project-waiting')).action).toBe('proceed');
  });

  it('open + admitted -> fail-fast; open + not admitted -> hold', async () => {
    const now = 3_100_000;
    await kill(0, now);
    await kill(1, now + 10);
    await kill(2, now + 20);
    await redis.zadd(admission.ACTIVE_KEY, Date.now(), 'project-admitted');

    const admitted = await breakerVerdict(redis, 'project-admitted');
    expect(admitted.action).toBe('fail-fast');
    expect(admitted.openUntil).toBeGreaterThan(0);

    // A project that is only waiting burns nothing; failing it too would
    // cascade the whole queue through the freed slots. It holds instead.
    const waiting = await breakerVerdict(redis, 'project-waiting');
    expect(waiting.action).toBe('hold');
  });
});

describe('the worded failure (B4)', () => {
  it('is plain language a user can read, and carries the reason marker', () => {
    expect(BREAKER_USER_MESSAGE).toContain(BREAKER_REASON_MARKER);
    expect(BREAKER_USER_MESSAGE).toContain('stopped early');
    expect(BREAKER_USER_MESSAGE).toContain('Nothing was lost from your project');
    // No internals: nothing a describeUserFacingError pass-through would
    // regret putting on screen.
    expect(BREAKER_USER_MESSAGE).not.toMatch(/redis|zset|bullmq|watchdog/i);
  });
});

describe('wiring pins — the healthy path stays untouched', () => {
  const renderJobSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderJob.js'),
    'utf8',
  );

  it('recordWatchdogKill is called from exactly one place: the watchdog.fired branch', () => {
    const calls = renderJobSource.match(/breaker\.recordWatchdogKill\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // Inside the fired branch, after its once-per-kill log line.
    const firedBranch = renderJobSource.indexOf(
      'Chunk killed by watchdog; failing the job so BullMQ retries it',
    );
    expect(firedBranch).toBeGreaterThan(-1);
    expect(renderJobSource.indexOf('breaker.recordWatchdogKill(')).toBeGreaterThan(firedBranch);
  });

  it('the breaker gate runs before the admission gate, so no project is newly admitted into a storm', () => {
    const gateCall = renderJobSource.indexOf('await gateOnBreaker(job, token)');
    const admissionCall = renderJobSource.indexOf('await gateOnAdmission(job, token)');
    expect(gateCall).toBeGreaterThan(-1);
    expect(admissionCall).toBeGreaterThan(-1);
    expect(gateCall).toBeLessThan(admissionCall);
  });

  it('the success path records chunk seconds but never breaker state', () => {
    // recordChunkSeconds (the admission estimate) is the ONLY recording on
    // completion; the breaker records exclusively from kills.
    const successBlock = renderJobSource.slice(
      renderJobSource.indexOf('await admission.recordChunkSeconds('),
      renderJobSource.indexOf("'Render job completed'"),
    );
    expect(successBlock).not.toContain('breaker.');
  });
});
