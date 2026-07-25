// Unit tests for config.js defaults and startup validation
// Validates: Requirements 1.5, 1.6, 5.1, 5.2

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Store original env values so we can restore them after each test
let savedEnv = {};

function saveEnv(...keys) {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(...keys) {
  for (const key of keys) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  savedEnv = {};
}

/**
 * Load config.js in a fresh Node context by clearing the module from
 * the require cache, mutating env, requiring, then restoring.
 *
 * Vitest runs in ESM mode but the source is CJS — we use createRequire.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function loadConfig() {
  // Delete cached module so env changes take effect
  const key = require.resolve('../src/config.js');
  delete require.cache[key];
  // Also clear logger (required transitively) if cached
  const loggerKey = require.resolve('../src/logger.js');
  delete require.cache[loggerKey];
  return require('../src/config.js');
}

// ─── Default values ────────────────────────────────────────────────────────────

describe('config.js — defaults', () => {
  beforeEach(() => {
    // Ensure WORKER_API_KEY is set (required by config) and known defaults unset
    saveEnv('CHUNK_SIZE', 'MAX_DURATION_SECONDS', 'WORKER_API_KEY');
    process.env.WORKER_API_KEY = 'test-api-key';
    delete process.env.CHUNK_SIZE;
    delete process.env.MAX_DURATION_SECONDS;
  });

  afterEach(() => {
    restoreEnv('CHUNK_SIZE', 'MAX_DURATION_SECONDS', 'WORKER_API_KEY');
  });

  it('CHUNK_SIZE defaults to 12 when not set', () => {
    const config = loadConfig();
    expect(config.chunkSize).toBe(12);
  });

  it('MAX_DURATION_SECONDS defaults to 14400 when not set', () => {
    const config = loadConfig();
    expect(config.maxDurationSeconds).toBe(14400);
  });
});

// ─── Startup validation — JOB_ATTEMPTS ────────────────────────────────────────

describe('config.js — validation: JOB_ATTEMPTS', () => {
  beforeEach(() => {
    saveEnv('JOB_ATTEMPTS', 'WORKER_API_KEY');
    process.env.WORKER_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    restoreEnv('JOB_ATTEMPTS', 'WORKER_API_KEY');
  });

  it('throws when JOB_ATTEMPTS=0', () => {
    process.env.JOB_ATTEMPTS = '0';
    expect(() => loadConfig()).toThrow('JOB_ATTEMPTS must be > 0');
  });

  it('throws when JOB_ATTEMPTS is negative', () => {
    process.env.JOB_ATTEMPTS = '-1';
    expect(() => loadConfig()).toThrow('JOB_ATTEMPTS must be > 0');
  });

  it('does not throw when JOB_ATTEMPTS=1', () => {
    process.env.JOB_ATTEMPTS = '1';
    expect(() => loadConfig()).not.toThrow();
  });
});

// ─── Startup validation — JOB_BACKOFF_DELAY_MS ────────────────────────────────

describe('config.js — validation: JOB_BACKOFF_DELAY_MS', () => {
  beforeEach(() => {
    saveEnv('JOB_BACKOFF_DELAY_MS', 'WORKER_API_KEY');
    process.env.WORKER_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    restoreEnv('JOB_BACKOFF_DELAY_MS', 'WORKER_API_KEY');
  });

  it('throws when JOB_BACKOFF_DELAY_MS=0', () => {
    process.env.JOB_BACKOFF_DELAY_MS = '0';
    expect(() => loadConfig()).toThrow('JOB_BACKOFF_DELAY_MS must be > 0');
  });

  it('throws when JOB_BACKOFF_DELAY_MS is negative', () => {
    process.env.JOB_BACKOFF_DELAY_MS = '-500';
    expect(() => loadConfig()).toThrow('JOB_BACKOFF_DELAY_MS must be > 0');
  });

  it('does not throw when JOB_BACKOFF_DELAY_MS=100', () => {
    process.env.JOB_BACKOFF_DELAY_MS = '100';
    expect(() => loadConfig()).not.toThrow();
  });
});
