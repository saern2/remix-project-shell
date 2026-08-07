'use strict';

/**
 * The stitch gets the treatment the chunks got in round 7.
 *
 * A stuck stitch was the last silent failure mode left: chunks had a scaled
 * watchdog, a stall notice at half budget, and retries; the stitch had a fixed
 * 600s kill, no notice, and — the sharpest edge — NO retries, because its job
 * opts never set attempts and BullMQ defaults to 1. A stitch killed by its own
 * timeout therefore failed terminally, discarding a project whose every chunk
 * had rendered.
 *
 * These tests pin the deadline arithmetic, the retry configuration, and the
 * control-flow decisions that make a retry actually able to succeed (the chunk
 * outputs must still exist when it runs).
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const fs = require('fs');
const path = require('path');

process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';

const config = require('../../src/config');
const { stitchDeadlineMs } = require('../../src/renderJob');
const { buildStitchOpts, buildChunkOpts } = require('../../src/pipelineReliability');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderJob.js'), 'utf8');
const stitchFn = SOURCE.slice(
  SOURCE.indexOf('async function processStitchJob'),
  SOURCE.indexOf('async function processRenderJob'),
);

function clipsOfSeconds(totalSeconds, count = 10) {
  const each = totalSeconds / count;
  return Array.from({ length: count }, () => ({ start: 0, end: each }));
}

describe('the stitch deadline scales with the video', () => {
  it('keeps the configured timeout as the floor for short videos', () => {
    // A 5-minute video: expected = max(120s, 30s) = 120s, hard = max(600s, 360s).
    // Short videos keep exactly the behaviour they had before this change.
    const d = stitchDeadlineMs(clipsOfSeconds(300));
    expect(d.hardMs).toBe(config.stitchTimeoutSeconds * 1000);
  });

  it('grows for videos where 600s would be too tight', () => {
    // 90 minutes of video: expected 540s, and the old fixed 600s hard limit
    // left almost no margin over a healthy stitch. 3x expected = 1620s.
    const d = stitchDeadlineMs(clipsOfSeconds(90 * 60));
    expect(d.expectedMs).toBe(540 * 1000);
    expect(d.hardMs).toBe(1620 * 1000);
  });

  it('warns at twice the expected duration, well before the kill', () => {
    const d = stitchDeadlineMs(clipsOfSeconds(45 * 60));
    expect(d.noticeMs).toBe(d.expectedMs * 2);
    expect(d.noticeMs).toBeLessThan(d.hardMs);
  });

  it('would not have flagged the measured healthy stitch', () => {
    // The 2026-08-07 run measured 3m28s for a ~45-minute project — the stitch
    // itself, net of queue wait. The notice must not cry wolf on that.
    const d = stitchDeadlineMs(clipsOfSeconds(45 * 60));
    expect(d.noticeMs).toBeGreaterThan(208 * 1000 * 2);
  });

  it('survives an empty clip list', () => {
    const d = stitchDeadlineMs([]);
    expect(d.expectedMs).toBeGreaterThan(0);
    expect(d.hardMs).toBeGreaterThanOrEqual(config.stitchTimeoutSeconds * 1000);
  });
});

describe('a killed stitch retries', () => {
  it('configures the same attempts as the chunks it combines', () => {
    const stitch = buildStitchOpts(config);
    const chunk = buildChunkOpts(clipsOfSeconds(60), config);
    expect(stitch.attempts).toBe(chunk.attempts);
    expect(stitch.attempts).toBeGreaterThan(1);
    expect(stitch.backoff).toEqual(chunk.backoff);
  });

  it('keeps the chunk outputs a retry will need', () => {
    // Cleanup used to delete every chunk dir on every exit path. With retries
    // that guarantees the retry dies with "Chunk file missing for concat" —
    // a retry that cannot succeed is worse than none, because it looks like one.
    expect(stitchFn).toMatch(/retryPending = !stitchSucceeded && willRetry\(job\)/);
    expect(stitchFn).toMatch(/if \(!retryPending\) \{\s*\n\s*for \(let i = 0; i < payload\.chunks_total/);
  });

  it('keeps the admission slot across the retry gap', () => {
    // Releasing on a retryable failure would admit a new project into the gap,
    // putting the retry behind a stranger's chunks — the exact wait the slot
    // exists to prevent.
    expect(stitchFn).toMatch(/if \(!retryPending\) \{\s*\n\s*await admission\.release/);
  });

  it('publishes the retry so the client can say so', () => {
    expect(stitchFn).toMatch(/state: 'retrying',\s*\n\s*reason: 'stitch-timeout'/);
  });
});

describe('the stall notice', () => {
  it('publishes at the notice threshold with the stitch phase named', () => {
    expect(stitchFn).toMatch(/reason: 'slow-stitch'/);
    expect(stitchFn).toMatch(/deadline\.noticeMs/);
  });

  it('clears on success so a slow-but-successful stitch leaves no warning', () => {
    expect(stitchFn).toMatch(/stitchSucceeded = true;\s*\n\s*await clearJobHealth\(/);
  });
});
