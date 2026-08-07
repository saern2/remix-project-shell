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
/** projectId -> owning user id. Admission counts projects; fairness needs users. */
const OWNER_KEY = 'admission:owner';
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
local activeKey, waitingKey, seenKey, ownerKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local projectId, now, ttl, cap, perUser, ownerId =
  ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6]

-- Admissions whose worker stopped heartbeating. A container killed by the OOM
-- reaper must not hold a slot forever, and that is exactly when it would.
local expired = redis.call('ZRANGEBYSCORE', activeKey, '-inf', now - ttl)
for i = 1, #expired do
  redis.call('HDEL', ownerKey, expired[i])
end
redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now - ttl)

-- Waiters that stopped polling: a project that was cancelled or died would
-- otherwise inflate every other waiter's displayed position for good.
local seen = redis.call('HGETALL', seenKey)
for i = 1, #seen, 2 do
  if tonumber(seen[i + 1]) < now - ttl then
    redis.call('ZREM', waitingKey, seen[i])
    redis.call('HDEL', seenKey, seen[i])
    redis.call('HDEL', ownerKey, seen[i])
  end
end

if ownerId ~= '' then
  redis.call('HSET', ownerKey, projectId, ownerId)
end

-- How many slots a user already holds. Counted from the live active set rather
-- than kept as a counter: a counter and the set can disagree after a crash, and
-- the set is what capacity is actually measured from.
local function activeCountFor(uid)
  if uid == '' then return 0 end
  local members = redis.call('ZRANGE', activeKey, 0, -1)
  local n = 0
  for i = 1, #members do
    if redis.call('HGET', ownerKey, members[i]) == uid then n = n + 1 end
  end
  return n
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

-- A user already at their own cap is not eligible even when the platform has
-- room: the slot is left for somebody else rather than handed to them again.
local mineActive = activeCountFor(ownerId)
local eligible = (ownerId == '' or perUser <= 0 or mineActive < perUser)

if eligible and redis.call('ZCARD', activeKey) < cap then
  -- The FIRST ELIGIBLE waiter takes a freed slot, not simply the first. Taking
  -- the plain head would let one user's queued projects block everyone behind
  -- them, which is head-of-line blocking: the exact failure the per-user cap
  -- exists to prevent, reintroduced one layer down.
  local waiters = redis.call('ZRANGE', waitingKey, 0, -1)
  local firstEligible = nil
  local pending = {}
  for i = 1, #waiters do
    local wid = waiters[i]
    local wowner = redis.call('HGET', ownerKey, wid) or ''
    if wowner == '' or perUser <= 0 or (pending[wowner] or 0) + activeCountFor(wowner) < perUser then
      firstEligible = wid
      break
    end
    pending[wowner] = (pending[wowner] or 0) + 1
  end

  if firstEligible == nil or firstEligible == projectId then
    admit()
    return {1, 0}
  end
end

-- Full, or this user is at their cap. Record when this project FIRST asked, so
-- its position is stable.
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
  redis.defineCommand('admissionTryAdmit', { numberOfKeys: 4, lua: TRY_ADMIT_SCRIPT });
  scriptRegistered = true;
}

/** Slots, from RENDER_ADMISSION_LIMIT. */
function admissionLimit() {
  return config.renderAdmissionLimit;
}

/**
 * Slots one user may hold at once, from RENDER_ADMISSION_PER_USER_LIMIT.
 *
 * Admission counts PROJECTS, which is right for capacity and wrong for
 * fairness: it is first-come-first-served, so one user submitting five projects
 * fills every slot and blocks everyone else until they are all done. The cap
 * bounds how much of the platform any one account can hold at once. Total
 * concurrency is unchanged — this only decides WHOSE work fills the slots.
 *
 * 0 disables it, which is the right escape hatch for a single-operator install.
 */
function perUserLimit() {
  return config.renderAdmissionPerUserLimit;
}

/**
 * @returns {Promise<{admitted: boolean, position: number}>} position is 1-based
 *   among waiting projects, or 0 when admitted.
 */
async function tryAdmit(redis, projectId, ownerId = null) {
  if (!projectId) return { admitted: true, position: 0 };
  registerScript(redis);
  const [admitted, position] = await redis.admissionTryAdmit(
    ACTIVE_KEY,
    WAITING_KEY,
    WAITING_SEEN_KEY,
    OWNER_KEY,
    projectId,
    String(Date.now()),
    String(ADMISSION_TTL_MS),
    String(admissionLimit()),
    String(perUserLimit()),
    // Empty string, not null: Lua has no null, and an absent owner must mean
    // "unowned, exempt from the per-user cap" rather than a user literally
    // named "null" who would then share a cap with every other unowned project.
    ownerId ? String(ownerId) : '',
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
    redis.hdel(OWNER_KEY, projectId),
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
  const [active, waiting, stitching, secondsPerChunk, owners] = await Promise.all([
    redis.zrange(ACTIVE_KEY, 0, -1),
    redis.zrange(WAITING_KEY, 0, -1),
    redis.zrange(STITCHING_KEY, 0, -1),
    measuredChunkSeconds(redis),
    redis.hgetall(OWNER_KEY).catch(() => ({})),
  ]);
  return {
    limit: admissionLimit(),
    perUserLimit: perUserLimit(),
    owners: owners ?? {},
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

/**
 * The position a user is actually told, accounting for the per-user cap.
 *
 * Raw FIFO rank became a lie the moment the cap existed. If user A has five
 * projects queued ahead of user B's one, B's rank is 6 but B goes in as soon as
 * a slot frees, because A is already at their cap and every one of those five
 * is skipped. Telling B "position 6" would be a worse failure than showing no
 * number: it is specific, confident and wrong.
 *
 * The model, stated plainly because it is an approximation: walk the queue in
 * arrival order and count only the projects that would genuinely be admitted
 * before this one. A project ahead counts if its owner still has room under the
 * cap, and always counts if it belongs to the SAME user — a user's own projects
 * queue behind each other regardless of anyone else's caps.
 *
 * Pure, so the rule is testable without Redis.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string[]} args.waiting        Waiting project ids, arrival order.
 * @param {string[]} args.active         Currently admitted project ids.
 * @param {Record<string,string>} args.owners  projectId -> userId.
 * @param {number} args.perUser          Per-user cap; 0 disables.
 * @returns {number} 1-based position, or 0 when not waiting.
 */
function effectiveQueuePosition({ projectId, waiting, active, owners, perUser }) {
  const index = waiting.indexOf(projectId);
  if (index < 0) return 0;
  if (!perUser || perUser <= 0) return index + 1;

  const myOwner = owners[projectId] ?? '';

  // Slots each user already holds; the cap is measured against these.
  const held = new Map();
  for (const id of active) {
    const owner = owners[id] ?? '';
    if (!owner) continue;
    held.set(owner, (held.get(owner) ?? 0) + 1);
  }

  let ahead = 0;
  for (const id of waiting.slice(0, index)) {
    const owner = owners[id] ?? '';

    // Unowned projects are exempt from the cap, so they always go ahead.
    if (!owner) {
      ahead += 1;
      continue;
    }
    // My own earlier projects are ahead of me no matter what: my queue is FIFO
    // within itself even when I am at my cap.
    if (owner === myOwner) {
      ahead += 1;
      held.set(owner, (held.get(owner) ?? 0) + 1);
      continue;
    }
    if ((held.get(owner) ?? 0) < perUser) {
      ahead += 1;
      held.set(owner, (held.get(owner) ?? 0) + 1);
    }
    // Otherwise that user is at their cap and will be skipped in favour of
    // whoever is eligible — so it is not ahead of me in any real sense.
  }

  return ahead + 1;
}

/** 1-based position among waiters, ignoring the per-user cap. Diagnostic only. */
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
  OWNER_KEY,
  CHUNK_SECONDS_KEY,
  ADMISSION_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  admissionLimit,
  perUserLimit,
  effectiveQueuePosition,
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
