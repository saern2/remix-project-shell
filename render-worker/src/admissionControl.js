'use strict';

/**
 * How many projects may be RENDERING at once.
 *
 * WHY. In the 2026-08-07 run, five ~45-minute projects were admitted at once.
 * All 220 chunks competed for 4 slots, so every project crawled, and the five
 * finish lines converged: the 13th finished its chunks at 07:14:16 and did not
 * produce a video until 07:29:26 — 15m10s, of which the stitch itself was about
 * 3.5 minutes. The rest was queue wait behind other projects' stitches.
 *
 * Throughput was never the problem; ordering was. Five projects sharing a
 * machine finish at roughly the same late moment. Three projects running and
 * two waiting finish sooner, in a predictable order, and the two that are
 * waiting can be TOLD they are waiting — which is the part a user actually
 * needs. This trades nothing away: the aggregate encode budget is identical.
 *
 * A project holds its slot from its first chunk until its STITCH finishes, not
 * until its last chunk. Releasing at the last chunk would admit a new project
 * into the stitch contention this exists to prevent.
 *
 * Crash safety comes from a heartbeat rather than cleanup on exit: an admitted
 * project whose worker dies stops refreshing and ages out, so a killed container
 * cannot permanently consume capacity. That mattered here — the OOM kills are
 * exactly when slots would otherwise leak.
 */

const config = require('./config');
const logger = require('./logger');

const ACTIVE_KEY = 'admission:active';
const WAITING_KEY = 'admission:waiting';
/** Waiters' last poll time. Their WAITING_KEY score is their FIRST ask — that is
 * what makes a displayed position stable — so it cannot double as liveness. */
const WAITING_SEEN_KEY = 'admission:waiting-seen';
/** Projects currently in the stitch phase. Same accounting, so the wait a user
 * is shown includes the stitch contention that caused the 15m10s. */
const STITCHING_KEY = 'admission:stitching';
/** Recent per-chunk durations, in seconds, newest first. */
const CHUNK_SECONDS_KEY = 'admission:chunk-seconds';
const CHUNK_SECONDS_SAMPLES = 50;

/**
 * How long an admission survives without a heartbeat. Comfortably longer than a
 * chunk (CHUNK_TIMEOUT_SECONDS) so a slow chunk never loses its project's slot,
 * short enough that a killed worker frees capacity within a couple of minutes.
 */
const ADMISSION_TTL_MS = 180_000;

/** Heartbeat cadence: three beats inside one TTL, so a single missed beat is survivable. */
const HEARTBEAT_INTERVAL_MS = Math.floor(ADMISSION_TTL_MS / 3);

/**
 * Claims or refreshes a slot, atomically.
 *
 * Lua because check-then-add across two round trips would let concurrent chunk
 * starts overshoot the cap — which is precisely the situation this guards.
 */
const TRY_ADMIT_SCRIPT = `
local activeKey, waitingKey, seenKey = KEYS[1], KEYS[2], KEYS[3]
local projectId, now, ttl, cap = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])

-- Admissions whose worker stopped heartbeating. A container killed by the OOM
-- reaper must not hold a slot forever, and that is exactly when it would.
redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now - ttl)

-- Waiters that stopped polling: a project that was cancelled or died would
-- otherwise inflate every other waiter's displayed position for good.
local seen = redis.call('HGETALL', seenKey)
for i = 1, #seen, 2 do
  if tonumber(seen[i + 1]) < now - ttl then
    redis.call('ZREM', waitingKey, seen[i])
    redis.call('HDEL', seenKey, seen[i])
  end
end

local function admit()
  redis.call('ZADD', activeKey, now, projectId)
  redis.call('ZREM', waitingKey, projectId)
  redis.call('HDEL', seenKey, projectId)
end

if redis.call('ZSCORE', activeKey, projectId) then
  admit()
  return {1, 0}
end

if redis.call('ZCARD', activeKey) < cap then
  -- Only the head of the queue may take a freed slot. Without this, whichever
  -- project happened to poll first would jump the line and the position we
  -- showed the others would be a lie.
  local head = redis.call('ZRANGE', waitingKey, 0, 0)
  if #head == 0 or head[1] == projectId then
    admit()
    return {1, 0}
  end
end

-- Full. Record when this project FIRST asked, so its position is stable.
if not redis.call('ZSCORE', waitingKey, projectId) then
  redis.call('ZADD', waitingKey, now, projectId)
end
redis.call('HSET', seenKey, projectId, now)
local rank = redis.call('ZRANK', waitingKey, projectId)
return {0, rank + 1}
`;

let scriptRegistered = false;

function registerScript(redis) {
  if (scriptRegistered || typeof redis.defineCommand !== 'function') return;
  redis.defineCommand('admissionTryAdmit', { numberOfKeys: 3, lua: TRY_ADMIT_SCRIPT });
  scriptRegistered = true;
}

/** Slots, from RENDER_ADMISSION_LIMIT. */
function admissionLimit() {
  return config.renderAdmissionLimit;
}

/**
 * @returns {Promise<{admitted: boolean, position: number}>} position is 1-based
 *   among waiting projects, or 0 when admitted.
 */
async function tryAdmit(redis, projectId) {
  if (!projectId) return { admitted: true, position: 0 };
  registerScript(redis);
  const [admitted, position] = await redis.admissionTryAdmit(
    ACTIVE_KEY,
    WAITING_KEY,
    WAITING_SEEN_KEY,
    projectId,
    String(Date.now()),
    String(ADMISSION_TTL_MS),
    String(admissionLimit()),
  );
  return { admitted: admitted === 1, position: Number(position) || 0 };
}

/**
 * Keeps an admitted project's slot alive.
 *
 * Unconditional rather than compare-and-set: by the time this runs the project
 * is already doing the work, so if its entry has aged out the right answer is to
 * put it back, not to strand a running render outside the accounting.
 */
async function refresh(redis, projectId, { stitching = false } = {}) {
  if (!projectId) return;
  const now = Date.now();
  await redis.zadd(ACTIVE_KEY, now, projectId);
  if (stitching) await redis.zadd(STITCHING_KEY, now, projectId);
}

/**
 * Starts the heartbeat for work that is already under way.
 *
 * @returns {() => void} stop function; safe to call more than once.
 */
function startHeartbeat(redis, projectId, { stitching = false } = {}) {
  if (!projectId) return () => {};
  const timer = setInterval(() => {
    refresh(redis, projectId, { stitching }).catch((err) => {
      logger.warn({ projectId, err: err.message }, 'Admission heartbeat failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Enters the stitch phase, keeping the slot the chunks already held. */
async function markStitching(redis, projectId) {
  if (!projectId) return;
  await refresh(redis, projectId, { stitching: true });
}

/** Frees the slot. Safe to call for a project that never held one. */
async function release(redis, projectId) {
  if (!projectId) return;
  await Promise.all([
    redis.zrem(ACTIVE_KEY, projectId),
    redis.zrem(WAITING_KEY, projectId),
    redis.zrem(STITCHING_KEY, projectId),
    redis.hdel(WAITING_SEEN_KEY, projectId),
  ]);
}

/**
 * Records how long a chunk took, so the wait estimate is measured rather than
 * guessed. Bounded to the most recent samples: the estimate should track this
 * machine's current load, not its history.
 */
async function recordChunkSeconds(redis, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    await redis.lpush(CHUNK_SECONDS_KEY, String(Math.round(seconds)));
    await redis.ltrim(CHUNK_SECONDS_KEY, 0, CHUNK_SECONDS_SAMPLES - 1);
  } catch (err) {
    logger.warn({ err: err.message }, 'Chunk duration sample not recorded');
  }
}

/**
 * Median recent chunk duration, or null when nothing has been measured yet.
 *
 * Median, not mean: a single watchdog-killed chunk sits at the full
 * CHUNK_TIMEOUT_SECONDS and would drag a mean far enough to make every estimate
 * wrong. The median ignores it.
 */
async function measuredChunkSeconds(redis) {
  try {
    const raw = await redis.lrange(CHUNK_SECONDS_KEY, 0, CHUNK_SECONDS_SAMPLES - 1);
    const values = raw
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!values.length) return null;
    return values[Math.floor(values.length / 2)];
  } catch {
    return null;
  }
}

/** Live counts, for the status endpoint and for logging. */
async function admissionSnapshot(redis) {
  const cutoff = Date.now() - ADMISSION_TTL_MS;
  await Promise.all([
    redis.zremrangebyscore(ACTIVE_KEY, '-inf', cutoff),
    redis.zremrangebyscore(STITCHING_KEY, '-inf', cutoff),
  ]);
  const [active, waiting, stitching, secondsPerChunk] = await Promise.all([
    redis.zrange(ACTIVE_KEY, 0, -1),
    redis.zrange(WAITING_KEY, 0, -1),
    redis.zrange(STITCHING_KEY, 0, -1),
    measuredChunkSeconds(redis),
  ]);
  return {
    limit: admissionLimit(),
    active,
    waiting,
    stitching,
    activeCount: active.length,
    waitingCount: waiting.length,
    stitchingCount: stitching.length,
    chunkConcurrency: config.workerConcurrencyChunks,
    secondsPerChunk,
  };
}

/** 1-based position, or 0 when the project is not waiting. */
async function queuePosition(redis, projectId) {
  if (!projectId) return 0;
  const rank = await redis.zrank(WAITING_KEY, projectId);
  return rank === null || rank === undefined ? 0 : Number(rank) + 1;
}

/**
 * Estimated wait for a project at `position`, in seconds.
 *
 * Deliberately crude and derived from measured numbers rather than modelled:
 * chunks run `chunkConcurrency` at a time at roughly `secondsPerChunk` each, so
 * a project takes about chunks / chunkConcurrency * secondsPerChunk, and a
 * waiting project needs `position` of those to drain.
 *
 * `chunksAhead` uses THIS project's chunk count as the stand-in for the projects
 * ahead of it, because their sizes are not knowable from here. That biases the
 * number high, since the projects ahead are already part-way through — which is
 * the kinder direction to be wrong in, and the caller labels it an estimate
 * either way.
 */
function estimateWaitSeconds({ position, chunksAhead, secondsPerChunk, chunkConcurrency }) {
  if (!position || position < 1) return 0;
  const perChunk = secondsPerChunk > 0 ? secondsPerChunk : 60;
  const lanes = chunkConcurrency > 0 ? chunkConcurrency : 1;
  const chunks = chunksAhead > 0 ? chunksAhead : 40 * position;
  return Math.round((chunks / lanes) * perChunk);
}

module.exports = {
  ACTIVE_KEY,
  WAITING_KEY,
  WAITING_SEEN_KEY,
  STITCHING_KEY,
  CHUNK_SECONDS_KEY,
  ADMISSION_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  admissionLimit,
  tryAdmit,
  refresh,
  startHeartbeat,
  markStitching,
  release,
  recordChunkSeconds,
  measuredChunkSeconds,
  admissionSnapshot,
  queuePosition,
  estimateWaitSeconds,
  // Exported for the test that pins the Lua against a real Redis.
  TRY_ADMIT_SCRIPT,
};
