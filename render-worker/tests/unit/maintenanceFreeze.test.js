'use strict';

/**
 * Maintenance freeze: a pause, not a crash.
 *
 * THE RISK. Every safety mechanism this worker has is built to notice work that
 * has stopped making progress, because that is what a hang looks like. A freeze
 * looks exactly the same from the inside. Left alone:
 *
 *   - the chunk watchdog kills anything past CHUNK_TIMEOUT_SECONDS and fails
 *     the job so BullMQ retries it,
 *   - the catch block reads an aborted controller as "CANCELLED: user
 *     requested", which is terminal and never retried,
 *   - the stitch's finally deletes every chunk directory of the project.
 *
 * A naive freeze therefore turns a two-minute deploy into 51 failed chunks and
 * a 45-minute re-render. These tests pin the three things that stop that, and
 * the resume semantics that make it a pause.
 *
 * The behaviours that live in control flow rather than in a value are pinned at
 * the source, because they cannot be exercised without a live BullMQ worker and
 * a mock of one would only pin my idea of what BullMQ does.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const fs = require('fs');
const path = require('path');

process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
// Database 8, NOT the 9 the admission suite uses. Both files touch the same
// admission keys, vitest runs files in parallel, and sharing a database meant
// each one's beforeEach cleared the other's state mid-test.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/8';
process.env.REDIS_URL = REDIS_URL;

const IORedis = require('ioredis');
const config = require('../../src/config');
const admission = require('../../src/admissionControl');
const maintenance = require('../../src/maintenance');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderJob.js'), 'utf8');
const chunkFn = SOURCE.slice(SOURCE.indexOf('async function processRenderJob'));
const stitchFn = SOURCE.slice(
  SOURCE.indexOf('async function processStitchJob'),
  SOURCE.indexOf('async function processRenderJob'),
);

let redis;

beforeAll(async () => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  delete process.env.MAINTENANCE_MODE;
  await redis.del(
    maintenance.STATE_KEY,
    maintenance.FROZEN_KEY,
    maintenance.ADMISSION_SNAPSHOT_KEY,
    admission.ACTIVE_KEY,
    admission.WAITING_KEY,
    admission.WAITING_SEEN_KEY,
  );
  config.renderAdmissionLimit = 3;
});

describe("the env var is an emergency brake, so it wins in both directions", () => {
  it("forces maintenance ON over a database flag that says off", async () => {
    await maintenance.setState(redis, { enabled: false });
    process.env.MAINTENANCE_MODE = 'true';

    const state = await maintenance.readState(redis);
    expect(state.enabled).toBe(true);
    expect(state.source).toBe('env');
    expect(state.overridden).toBe(true);
    expect(await maintenance.isFrozen(redis)).toBe(true);
  });

  it("forces maintenance OFF over a database flag that says on", async () => {
    // The direction a truthiness check would get wrong. A brake that cannot be
    // released is not a brake — if the database is stuck saying "on" and the
    // dashboard that would turn it off is itself unreachable, this is the way out.
    await maintenance.setState(redis, { enabled: true, enabledBy: 'admin@example.com' });
    process.env.MAINTENANCE_MODE = 'false';

    const state = await maintenance.readState(redis);
    expect(state.enabled).toBe(false);
    expect(state.source).toBe('env');
    expect(state.overridden).toBe(true);
    expect(await maintenance.isFrozen(redis)).toBe(false);
  });

  it("stands aside when unset", async () => {
    await maintenance.setState(redis, { enabled: true });
    const state = await maintenance.readState(redis);
    expect(state.enabled).toBe(true);
    expect(state.source).toBe('database');
    expect(state.overridden).toBe(false);
  });

  it("reports 'overridden' only when it actually contradicts the stored flag", () => {
    // Agreeing with the database is not an override, and telling the admin their
    // toggle is dead when it is not would be its own kind of wrong.
    expect(maintenance.resolveState({ enabled: true }, true).overridden).toBe(false);
    expect(maintenance.resolveState({ enabled: false }, false).overridden).toBe(false);
    expect(maintenance.resolveState({ enabled: false }, true).overridden).toBe(true);
    expect(maintenance.resolveState({ enabled: true }, false).overridden).toBe(true);
  });

  it("treats a malformed value as ON rather than guessing", () => {
    expect(maintenance.envOverride({ MAINTENANCE_MODE: 'banana' })).toBe(true);
    expect(maintenance.envOverride({ MAINTENANCE_MODE: '' })).toBeNull();
    expect(maintenance.envOverride({})).toBeNull();
    for (const yes of ['1', 'true', 'ON', 'yes', 'enabled']) {
      expect(maintenance.envOverride({ MAINTENANCE_MODE: yes })).toBe(true);
    }
    for (const no of ['0', 'false', 'OFF', 'no', 'disabled']) {
      expect(maintenance.envOverride({ MAINTENANCE_MODE: no })).toBe(false);
    }
  });
});

describe("frozen state survives a restart", () => {
  it("keeps the flag in Redis, not in worker memory", async () => {
    // The OOM kills are exactly when this would otherwise leak: a flag held in
    // a variable dies with the process and the platform silently un-freezes
    // itself mid-deploy.
    await maintenance.setState(redis, { enabled: true, message: 'Back at 3pm', enabledBy: 'ops' });

    // A second require with a cleared module cache stands in for a restarted
    // worker: same Redis, no shared memory.
    delete require.cache[require.resolve('../../src/maintenance')];
    const rebooted = require('../../src/maintenance');

    const state = await rebooted.readState(redis);
    expect(state.enabled).toBe(true);
    expect(state.message).toBe('Back at 3pm');
    expect(state.enabledBy).toBe('ops');
    expect(await rebooted.isFrozen(redis)).toBe(true);
  });

  it("keeps the frozen-project list too, so a job that never resumes is visible", async () => {
    await maintenance.setState(redis, { enabled: true });
    await maintenance.noteFrozen(redis, {
      projectId: 'p1',
      jobId: 'p1-chunk-30',
      phase: 'encoding',
      chunkIndex: 30,
      chunksTotal: 51,
    });

    const frozen = await maintenance.listFrozen(redis);
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ projectId: 'p1', chunkIndex: 30, chunksTotal: 51 });
    expect(frozen[0].frozenAt).toBeTruthy();
  });

  it("takes a project's note down when it resumes", async () => {
    await maintenance.noteFrozen(redis, { projectId: 'p1', jobId: 'p1-chunk-30', phase: 'encoding' });
    await maintenance.clearFrozen(redis, 'p1');
    expect(await maintenance.listFrozen(redis)).toHaveLength(0);
  });
});

describe("a frozen project keeps its place in the admission queue", () => {
  it("restores the queue in its pre-freeze order", async () => {
    for (const id of ['a', 'b', 'c']) await admission.tryAdmit(redis, id);
    await admission.tryAdmit(redis, 'd');
    await admission.tryAdmit(redis, 'e');

    await maintenance.setState(redis, { enabled: true });
    // A long maintenance window: everything ages out of the live queue, which
    // is correct — nothing is heartbeating because nothing is running.
    await redis.del(admission.ACTIVE_KEY, admission.WAITING_KEY, admission.WAITING_SEEN_KEY);

    await maintenance.setState(redis, { enabled: false });

    const after = await admission.admissionSnapshot(redis);
    expect(after.active).toEqual(['a', 'b', 'c']);
    expect(after.waiting).toEqual(['d', 'e']);
    // The point of restoring: the frozen project resumes immediately instead of
    // queueing behind projects that arrived during the deploy.
    expect((await admission.tryAdmit(redis, 'a')).admitted).toBe(true);
    expect((await admission.tryAdmit(redis, 'newcomer')).admitted).toBe(false);
  });

  it("restores with fresh timestamps so nothing resumes already expired", async () => {
    await admission.tryAdmit(redis, 'a');
    await maintenance.setState(redis, { enabled: true });
    await redis.del(admission.ACTIVE_KEY);
    await maintenance.setState(redis, { enabled: false });

    const score = Number(await redis.zscore(admission.ACTIVE_KEY, 'a'));
    // Replaying the original timestamp after an hour of maintenance would put
    // the entry past its TTL, and the next sweep would evict a project that had
    // just been told it kept its slot.
    expect(Date.now() - score).toBeLessThan(admission.ADMISSION_TTL_MS);
  });

  it("leaves the frozen list standing so a project that never resumes shows up", async () => {
    // Clearing the list on resume would make every resume look successful,
    // which defeats the only purpose the list has.
    await maintenance.setState(redis, { enabled: true });
    await maintenance.noteFrozen(redis, { projectId: 'resumes', jobId: 'r-chunk-1', phase: 'encoding' });
    await maintenance.noteFrozen(redis, { projectId: 'stuck', jobId: 's-chunk-1', phase: 'encoding' });

    await maintenance.setState(redis, { enabled: false });
    expect(await maintenance.listFrozen(redis)).toHaveLength(2);

    // One project's jobs come back and take their own note down; the other's
    // never do, and it stays visible.
    await maintenance.clearFrozen(redis, 'resumes');
    const stillFrozen = await maintenance.listFrozen(redis);
    expect(stillFrozen).toHaveLength(1);
    expect(stillFrozen[0].projectId).toBe('stuck');
  });
});

describe("the freeze check fails open", () => {
  it("reports not-frozen when Redis is unreachable", async () => {
    // A Redis blip must not freeze the platform. The env var is there for the
    // case where the operator needs a guarantee rather than a best effort.
    const broken = {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    expect(await maintenance.isFrozen(broken)).toBe(false);
  });

  it("still honours the env var when Redis is unreachable", async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const broken = {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    // Checked before Redis is touched at all — this is the "database-only flag
    // is useless during database maintenance" case.
    expect(await maintenance.isFrozen(broken)).toBe(true);
  });
});

describe("the freeze cannot be killed by the watchdog", () => {
  it("exits the job rather than sleeping inside it", () => {
    // The watchdog is cancelled in `finally`, so the only way to disarm it is to
    // leave the function. A freeze that blocked in place would keep the timer
    // armed and be killed by it — the failure this whole design avoids.
    expect(chunkFn).toMatch(/moveToDelayed\(Date\.now\(\) \+ maintenance\.FREEZE_RECHECK_MS, token\)/);
    expect(SOURCE).toMatch(/watchdog\.cancel\(\)/);
    // No sleep-until-unfrozen anywhere in the job body.
    expect(chunkFn).not.toMatch(/while\s*\(await maintenance\.isFrozen/);
  });

  it("checks frozen BEFORE cancellation, so a deploy is not recorded as a cancel", () => {
    const frozenAt = chunkFn.indexOf('if (frozen.value)');
    const cancelAt = chunkFn.indexOf('const cancelledByUser');
    expect(frozenAt).toBeGreaterThan(-1);
    expect(frozenAt).toBeLessThan(cancelAt);
  });

  it("checks frozen before the stitch's timeout and cancellation too", () => {
    const frozenAt = stitchFn.indexOf('if (frozen.value)');
    const timedOutAt = stitchFn.indexOf('if (timedOut)');
    const cancelAt = stitchFn.indexOf('const cancelledByUser');
    expect(frozenAt).toBeGreaterThan(-1);
    expect(frozenAt).toBeLessThan(timedOutAt);
    expect(frozenAt).toBeLessThan(cancelAt);
  });

  it("sets the flag before aborting, so the flag is readable in the catch", () => {
    const poll = fs.readFileSync(path.join(__dirname, '../../src/maintenance.js'), 'utf8');
    const body = poll.slice(poll.indexOf('async function pollFreezeUntilDone'));
    expect(body.indexOf('frozen.value = true')).toBeLessThan(body.indexOf('controller.abort()'));
  });
});

describe("a frozen job does not spend a retry attempt", () => {
  it("parks with DelayedError rather than throwing a failure", () => {
    // moveToDelayed + DelayedError is the BullMQ contract for "not now" as
    // opposed to "this failed". A project frozen through three deploys must
    // still have all three attempts left for a real error.
    for (const fn of [chunkFn, stitchFn]) {
      const frozenBlock = fn.slice(fn.indexOf('if (frozen.value)'), fn.indexOf('if (frozen.value)') + 1200);
      expect(frozenBlock).toMatch(/moveToDelayed/);
      expect(frozenBlock).toMatch(/throw new DelayedError\(\)/);
    }
  });

  it("gates before any work is done, so parking costs nothing", () => {
    // gateOnMaintenance runs before admission, before mkdir, before downloads.
    const gateAt = chunkFn.indexOf('gateOnMaintenance');
    const admissionAt = chunkFn.indexOf('gateOnAdmission');
    const mkdirAt = chunkFn.indexOf('fsp.mkdir(tempDir');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(admissionAt);
    expect(gateAt).toBeLessThan(mkdirAt);
  });

  it("gates the stitch before it builds anything either", () => {
    const gateAt = stitchFn.indexOf('gateOnMaintenance');
    const mkdirAt = stitchFn.indexOf('fsp.mkdir(tempDir');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(mkdirAt);
  });
});

describe("chunk outputs survive a freeze", () => {
  it("deletes nothing at all when a chunk is frozen", () => {
    // Every other exit path decides WHAT to delete. This one has to decide to
    // delete nothing, or the resumed run re-downloads hundreds of megabytes it
    // already has on disk.
    const cleanup = chunkFn.slice(chunkFn.indexOf('Temp directory cleanup'));
    const frozenBranch = cleanup.slice(
      cleanup.indexOf('if (frozen.value)'),
      cleanup.indexOf('} else if (!payload.is_chunk)'),
    );
    expect(frozenBranch).toBeTruthy();
    expect(frozenBranch).not.toMatch(/fsp\.rm/);
    // ...and it is the FIRST branch, so no other rule can reach the files.
    expect(cleanup.indexOf('if (frozen.value)')).toBeLessThan(cleanup.indexOf('fsp.rm'));
  });

  it("keeps every chunk directory when the STITCH is frozen", () => {
    // The destructive case: the stitch's cleanup loops over all chunk dirs of
    // the project. A frozen stitch falling through would delete all 51 finished
    // outputs and turn a deploy into a full re-render.
    expect(stitchFn).toMatch(/const retryPending = !stitchSucceeded && \(frozen\.value \|\| willRetry\(job\)\)/);
    const cleanup = stitchFn.slice(stitchFn.indexOf('Cleanup chunk temp dirs'));
    expect(cleanup).toMatch(/if \(!retryPending\)/);
  });

  it("reuses the existing verified-output machinery rather than a new marker", () => {
    // readyChunkOutput checks the file AND its marker, and is what makes
    // resuming skip finished chunks. Reinventing it would mean a second
    // definition of "this output is trustworthy".
    expect(SOURCE).toMatch(/readyChunkOutput|markChunkReady/);
    const resource = fs.readFileSync(path.join(__dirname, '../../src/resourceControl.js'), 'utf8');
    expect(resource).toMatch(/function readyChunkOutput/);
    expect(resource).toMatch(/output\.size > 0 && marker\.isFile\(\)/);
  });

  it("keeps the admission slot for a frozen stitch", () => {
    // retryPending gates the release as well as the cleanup, so a frozen stitch
    // holds its slot — matching the snapshot taken at freeze.
    expect(stitchFn).toMatch(/if \(!retryPending\) \{\s*await admission\.release/);
  });
});

describe("the client is told paused, not failed", () => {
  it("never writes an error for a freeze", () => {
    const frozenBlock = stitchFn.slice(
      stitchFn.indexOf('if (frozen.value)'),
      stitchFn.indexOf('if (timedOut)'),
    );
    expect(frozenBlock).toMatch(/_status: 'paused_for_maintenance'/);
    // `error` is terminal, and the poll handler treats a non-null error on a
    // finished job as a failure. A pause is not a failure.
    expect(frozenBlock).not.toMatch(/_error:/);
  });
});
