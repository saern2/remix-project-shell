/**
 * Measured job durations — the ETA source (Item 2 / D10).
 *
 * Same shape as the render worker's admission:chunk-seconds: a bounded
 * Redis list of the most recent SUCCESSFUL job durations, median not mean
 * (one pathological job must not drag every quoted wait), seeded with the
 * single production measurement (42m19s = 2539s) so the very first user
 * sees an honest number instead of a guess — and it self-corrects as real
 * durations land.
 */

import config from './config.js';

export async function seedJobSeconds(redis) {
  try {
    const len = await redis.llen(config.jobSecondsKey);
    if (len === 0) await redis.lpush(config.jobSecondsKey, String(config.jobSecondsSeed));
  } catch {
    // Advisory: a failed seed only costs the first ETA.
  }
}

export async function recordJobSeconds(redis, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    await redis.lpush(config.jobSecondsKey, String(Math.round(seconds)));
    await redis.ltrim(config.jobSecondsKey, 0, config.jobSecondsSamples - 1);
  } catch {
    // Advisory.
  }
}

export async function medianJobSeconds(redis) {
  try {
    const raw = await redis.lrange(config.jobSecondsKey, 0, config.jobSecondsSamples - 1);
    const values = raw
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!values.length) return config.jobSecondsSeed;
    return values[Math.floor(values.length / 2)];
  } catch {
    return config.jobSecondsSeed;
  }
}

/**
 * The wait a user at `position` (1-based, among waiting jobs) is quoted:
 * everything ahead of them plus their own job, at the measured median, over
 * the configured concurrency. Deliberately simple and derived from measured
 * numbers — the caller labels it an estimate.
 */
export function estimateWaitSeconds({ position, medianSeconds, concurrency, activeCount }) {
  const lanes = Math.max(1, concurrency);
  const ahead = Math.max(0, position - 1) + Math.max(0, activeCount);
  return Math.round(((ahead + 1) / lanes) * medianSeconds);
}
