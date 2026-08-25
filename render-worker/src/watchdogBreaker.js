'use strict';

/**
 * The circuit breaker the 22 August outage was missing.
 *
 * THE MECHANISM IT INTERRUPTS. 42 projects in 40 minutes pushed the healthy
 * chunk median from 93s to 238s — toward the 300s watchdog budget — until
 * chunks whose natural time under contention exceeded the budget died on EVERY
 * attempt, deterministically. Each such chunk burns its full retry ladder
 * (3 BullMQ attempts + 2 recoveries = 5 runs, ~1,500s of a render slot)
 * producing nothing, which deepens the contention that killed it: positive
 * feedback that never self-recovers. Recovery was manual — ~16,000 Redis keys
 * deleted by hand. Counting from the once-per-kill watchdog log line, roughly
 * two-thirds of 12 hours of chunk capacity went to kills.
 *
 * WHAT THIS DOES. Every watchdog kill is recorded in a rolling window. When
 * the window holds WATCHDOG_BREAKER_KILLS kills, the breaker OPENS for
 * WATCHDOG_BREAKER_OPEN_S seconds. While open:
 *
 *   - chunks of ADMITTED projects fail immediately with a plain worded error,
 *     instead of burning another 300s slot-window each producing nothing;
 *   - chunks of projects NOT yet admitted are held at the existing admission
 *     deferral (moveToDelayed — costless, attempt-preserving, and VISIBLE via
 *     the same waiting-slot notice the admission gate publishes). Without this
 *     hold, slots freed by dying projects would admit the next waiters into
 *     the same storm, cascade-failing the whole queue in minutes.
 *
 * The open state is a plain expiring key — deliberately no half-open probe
 * state, no coordination (operator's B2): when the key expires the breaker is
 * closed and normal retry resumes; if kills immediately re-breach the
 * threshold it simply reopens.
 *
 * THE THRESHOLD, DERIVED NOT GUESSED. With 4 chunk slots and >= 300s per
 * kill, the physical ceiling is 12 kills per 900s window. Baseline kill rate
 * is 0.10% (3 kills in 2,895 chunks, 2026-08-12..14) — expected kills in any
 * 900s window ~0.04, so a false trip is effectively impossible. One
 * deterministic bad-content chunk maxes ~3 kills per window (its runs are
 * serial); two concurrent bad chunks ~6. Eight requires three-plus chunks
 * dying at once, which is systemic overload and nothing else. (A proposed 20
 * was above the physical ceiling and could never have tripped.)
 *
 * OBSERVABLE FROM OUTSIDE, like render:chunk-recovery:*:
 *   redis-cli ZRANGE render:watchdog-kills 0 -1 WITHSCORES   — recent kills
 *   redis-cli GET render:watchdog-breaker:open-until          — open? until when?
 *   redis-cli GET render:watchdog-breaker:opens               — openings, last 24h
 * All keys expire on their own; a restart changes nothing they say.
 */

const config = require('./config');
const { ACTIVE_KEY } = require('./admissionControl');

/** Rolling window of recent watchdog kills: score = kill time (ms). */
const KILLS_KEY = 'render:watchdog-kills';
/** Present exactly while the breaker is open; value = open-until (ms epoch). */
const OPEN_KEY = 'render:watchdog-breaker:open-until';
/**
 * How many times the breaker has OPENED in the last 24 hours. With no
 * monitoring on this platform, one `redis-cli GET` has to distinguish "it
 * fired once" from "it has been firing all afternoon" — a count of 1 is an
 * incident that passed; a count of 9 is a box that needs an operator. Bumped
 * once per opening (never per kill); the rolling TTL means it reads as
 * "openings in the last day" and disappears entirely after a quiet day.
 */
const OPENS_COUNT_KEY = 'render:watchdog-breaker:opens';
const OPENS_COUNT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The stable phrase that marks a failure as breaker-caused. The reconciler
 * looks for it in recorded chunk-failure reasons so the PROJECT-level failure
 * message can say "heavy load" instead of a generic segment count (B4).
 */
const BREAKER_REASON_MARKER = 'under heavy load';

/**
 * What a user reads when the breaker stops their render. Plain language by
 * construction: this string is the thrown error, which becomes the chunk's
 * recorded failure reason and survives into render_jobs.error, where
 * describeUserFacingError passes application-authored text through verbatim.
 */
const BREAKER_USER_MESSAGE =
  `The system is ${BREAKER_REASON_MARKER} right now, so this render was stopped early ` +
  'instead of being left to crawl. Nothing was lost from your project — please try again in a few minutes.';

/** The breaker's tuning, from config; overridable per call for tests. */
function settings(overrides = {}) {
  return {
    threshold: overrides.threshold ?? config.watchdogBreakerKills,
    windowMs: overrides.windowMs ?? config.watchdogBreakerWindowSeconds * 1000,
    openMs: overrides.openMs ?? config.watchdogBreakerOpenSeconds * 1000,
  };
}

/**
 * Records one watchdog kill and opens the breaker if the window is breached.
 *
 * Called from exactly one place: the `watchdog.fired` branch of the chunk
 * failure path (a source pin enforces this). A succeeding chunk never records
 * anything and never reads this key — the healthy path is untouched.
 *
 * `opened` is true only for the call that actually opened the breaker (SET NX
 * on the open key), which is what makes the level-50 opening log fire once per
 * opening rather than once per kill — the reconciler's 205 re-declarations
 * already demonstrated what repetition does to an alarm's value.
 *
 * @returns {Promise<{count: number, tripped: boolean, opened: boolean, openUntil: number|null}>}
 */
async function recordWatchdogKill(redis, { jobId, attempt, now = Date.now() }, overrides = {}) {
  const { threshold, windowMs, openMs } = settings(overrides);

  await redis.zadd(KILLS_KEY, now, `${jobId}:${attempt ?? 0}:${now}`);
  await redis.zremrangebyscore(KILLS_KEY, '-inf', now - windowMs);
  // Self-cleaning: with no kills for a full window the key vanishes entirely.
  await redis.pexpire(KILLS_KEY, windowMs);

  const count = Number(await redis.zcard(KILLS_KEY));
  if (count < threshold) {
    return { count, tripped: false, opened: false, openUntil: null };
  }

  const openUntil = now + openMs;
  // NX: only the kill that finds the breaker closed opens it. While open,
  // further kills neither extend the window nor re-log — the key's own PX
  // expiry is the whole close mechanism (B2: no half-open state, auditable
  // with one GET).
  const wasClosed = await redis.set(OPEN_KEY, String(openUntil), 'PX', openMs, 'NX');
  const opened = wasClosed === 'OK';
  if (opened) {
    // The 24h openings tally — one GET answers "once, or all afternoon?".
    // Advisory: a counter failure must never turn an opening into an error.
    try {
      await redis.incr(OPENS_COUNT_KEY);
      await redis.pexpire(OPENS_COUNT_KEY, OPENS_COUNT_TTL_MS);
    } catch {
      // The opening itself, and its level-50 log, still stand.
    }
  }
  return {
    count,
    tripped: true,
    opened,
    openUntil: opened ? openUntil : null,
  };
}

/**
 * Open-until timestamp (ms) while the breaker is open, or null when closed.
 * Closed is the default in every failure mode: an unreadable key must degrade
 * to normal operation, never to refusing work.
 */
async function isBreakerOpen(redis) {
  try {
    const raw = await redis.get(OPEN_KEY);
    if (raw == null) return null;
    const openUntil = Number(raw);
    return Number.isFinite(openUntil) ? openUntil : null;
  } catch {
    return null;
  }
}

/**
 * What a chunk arriving at the worker should do, given the breaker state.
 *
 *   'proceed'   — breaker closed (the only verdict a succeeding chunk ever
 *                 sees; sub-threshold kills in the window change nothing)
 *   'fail-fast' — open, and this project holds an admission slot: it is the
 *                 work burning capacity, so it fails now, visibly, in
 *                 milliseconds instead of 300s
 *   'hold'      — open, project not admitted: it is only waiting and burning
 *                 nothing, so it keeps waiting at the existing deferral path
 *                 rather than being fed into the storm as slots free up
 */
async function breakerVerdict(redis, projectId) {
  const openUntil = await isBreakerOpen(redis);
  if (!openUntil) return { action: 'proceed', openUntil: null };
  let admitted = null;
  try {
    admitted = projectId ? await redis.zscore(ACTIVE_KEY, projectId) : null;
  } catch {
    // Cannot tell: treat as admitted. Failing fast is the breaker's honest
    // posture; silently holding work it cannot classify is not.
    admitted = '1';
  }
  return { action: admitted != null ? 'fail-fast' : 'hold', openUntil };
}

module.exports = {
  KILLS_KEY,
  OPEN_KEY,
  OPENS_COUNT_KEY,
  BREAKER_REASON_MARKER,
  BREAKER_USER_MESSAGE,
  recordWatchdogKill,
  isBreakerOpen,
  breakerVerdict,
};
