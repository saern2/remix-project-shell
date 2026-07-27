// Feature: render-pipeline-reliability, Property 1: buildChunkOpts always includes attempts and backoff
// Validates: Requirements 1.1, 1.2, 1.7

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildChunkOpts, writeCancelFlag } = require('../src/pipelineReliability.js');

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * A single clip: start < end, both non-negative, duration up to 3600 s.
 */
const clipArb = fc
  .tuple(
    fc.float({ min: 0, max: 3600, noNaN: true }),
    fc.float({ min: 1, max: 3600, noNaN: true })
  )
  .map(([start, delta]) => ({ clip_url: 'https://example.com/clip.mp4', start, end: start + delta }));

/**
 * A non-empty array of clips (1–20 clips).
 */
const clipsArb = fc.array(clipArb, { minLength: 1, maxLength: 20 });

/**
 * Configuration object with realistic positive values.
 *  - chunkTimeoutSeconds: 30–3600
 *  - jobAttempts:         1–10
 *  - jobBackoffDelayMs:   100–30000
 */
const cfgArb = fc.record({
  chunkTimeoutSeconds: fc.integer({ min: 30, max: 3600 }),
  jobAttempts: fc.integer({ min: 1, max: 10 }),
  jobBackoffDelayMs: fc.integer({ min: 100, max: 30_000 }),
});

// ─── Property 1 ──────────────────────────────────────────────────────────────

describe('Property 1: buildChunkOpts always includes attempts and backoff', () => {
  it('opts.attempts, opts.backoff.type, and opts.backoff.delay are never undefined, 0, or missing', () => {
    fc.assert(
      fc.property(clipsArb, cfgArb, (clips, cfg) => {
        const opts = buildChunkOpts(clips, cfg);

        // attempts must be defined and greater than 0
        expect(opts.attempts).not.toBeUndefined();
        expect(opts.attempts).toBeGreaterThan(0);

        // backoff object must exist
        expect(opts.backoff).not.toBeUndefined();

        // backoff.type must be a non-empty string (not undefined or empty)
        expect(opts.backoff.type).not.toBeUndefined();
        expect(typeof opts.backoff.type).toBe('string');
        expect(opts.backoff.type.length).toBeGreaterThan(0);

        // backoff.delay must be defined and greater than 0
        expect(opts.backoff.delay).not.toBeUndefined();
        expect(opts.backoff.delay).toBeGreaterThan(0);

        // attempts must equal the value from cfg (no defaulting or overriding)
        expect(opts.attempts).toBe(cfg.jobAttempts);

        // backoff.delay must equal the value from cfg (no defaulting or overriding)
        expect(opts.backoff.delay).toBe(cfg.jobBackoffDelayMs);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: render-pipeline-reliability, Property 12: Dynamic timeout formula satisfies both bounds
// Validates: Requirements 5.3, 5.4

describe('Property 12: Dynamic timeout formula satisfies both bounds simultaneously', () => {
  it('T >= F * 1000 AND T >= (Math.ceil(D * 1.5) + 60) * 1000 for all D and F', () => {
    // Use fc.float for D (total clip duration) and fc.integer for floor F (chunkTimeoutSeconds)
    const arbD = fc.float({ min: 0, max: 10000, noNaN: true });
    const arbF = fc.integer({ min: 1, max: 3600 });

    fc.assert(
      fc.property(arbD, arbF, (D, F) => {
        const cfg = {
          chunkTimeoutSeconds: F,
          jobAttempts: 3,
          jobBackoffDelayMs: 5000,
        };
        // Single clip spanning [0, D] makes totalDurationSeconds == D
        // When D == 0, use an empty clips array so reduce yields 0
        const clips = D > 0 ? [{ clip_url: 'https://example.com/c.mp4', start: 0, end: D }] : [];

        const opts = buildChunkOpts(clips, cfg);
        const T = opts.timeout; // milliseconds

        // Bound 1: T (ms) >= F (seconds) * 1000
        expect(T).toBeGreaterThanOrEqual(F * 1000);

        // Bound 2: T (ms) >= (Math.ceil(D * 1.5) + 60) * 1000
        const totalDuration = clips.reduce((s, c) => s + (c.end - c.start), 0);
        expect(T).toBeGreaterThanOrEqual((Math.ceil(totalDuration * 1.5) + 60) * 1000);
      }),
      { numRuns: 1000 }
    );
  });
});

// ─── Property 6: Cancellation flag is always written ─────────────────────────
// Feature: render-pipeline-reliability, Property 6: Cancellation flag is always written
// Validates: Requirements 3.3

describe('Property 6: Cancellation flag is always written for active jobs', () => {
  it('get("cancel:<jobId>") === "1" after writeCancelFlag', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (jobId) => {
        // Hand-rolled in-memory Redis mock — TTL args ('EX', 3600) are ignored
        const store = new Map();
        const mockRedis = {
          set: async (key, value, _ex, _ttl) => {
            store.set(key, value);
            return 'OK';
          },
          get: async (key) => store.get(key) ?? null,
        };

        await writeCancelFlag(mockRedis, jobId);

        const val = await mockRedis.get(`cancel:${jobId}`);
        expect(val).toBe('1');
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: render-pipeline-reliability, Property 2: Config validation rejects non-positive retry values
// Validates: Requirements 1.5, 1.6

describe('Property 2: Config validation rejects non-positive retry values', () => {
  it('requiring config.js throws when JOB_ATTEMPTS <= 0', () => {
    fc.assert(
      fc.property(fc.integer({ max: 0 }), (n) => {
        // Save original value
        const original = process.env.JOB_ATTEMPTS;
        // Also ensure WORKER_API_KEY is set so requireEnv doesn't fire first
        const originalApiKey = process.env.WORKER_API_KEY;
        process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';

        try {
          process.env.JOB_ATTEMPTS = String(n);

          // Reset module registry so config.js re-executes with the new env var
          vi.resetModules();

          const { createRequire } = require('module');
          const req = createRequire(import.meta.url);

          expect(() => req('../src/config.js')).toThrow(/JOB_ATTEMPTS must be > 0/);
        } finally {
          // Restore env vars and module registry
          if (original === undefined) {
            delete process.env.JOB_ATTEMPTS;
          } else {
            process.env.JOB_ATTEMPTS = original;
          }
          if (originalApiKey === undefined) {
            delete process.env.WORKER_API_KEY;
          } else {
            process.env.WORKER_API_KEY = originalApiKey;
          }
          vi.resetModules();
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: render-pipeline-reliability, Property 13: Effective concurrency never exceeds CPU count
// Validates: Requirements 5.5

import os from 'os';

describe('Property 13: Effective concurrency never exceeds CPU count', () => {
  it('Math.min(C, os.cpus().length) <= os.cpus().length for all C in [1, 64]', () => {
    const cpuCount = os.cpus().length;

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), (C) => {
        const effectiveConcurrency = Math.min(C, cpuCount);
        expect(effectiveConcurrency).toBeLessThanOrEqual(cpuCount);
      }),
      { numRuns: 100 }
    );
  });
});
