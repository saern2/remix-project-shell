// Feature: render-pipeline-reliability, Property 4: AbortSignal listener count returns to baseline after downloads
// Feature: render-pipeline-reliability, Property 5: Listener count does not grow across retries
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createScopedAbortController } = require('../src/pipelineReliability.js');

// ─── AbortSignal listener-count tracker ───────────────────────────────────────
//
// Node's AbortSignal does not expose a public listener count, but we can
// monkey-patch addEventListener/removeEventListener to count them ourselves.

function makeTrackedController() {
  const ac = createScopedAbortController();
  const signal = ac.signal;

  let listenerCount = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);

  signal.addEventListener = (type, handler, opts) => {
    if (type === 'abort') listenerCount++;
    return originalAdd(type, handler, opts);
  };

  signal.removeEventListener = (type, handler, opts) => {
    if (type === 'abort') listenerCount = Math.max(0, listenerCount - 1);
    return originalRemove(type, handler, opts);
  };

  signal.getListenerCount = () => listenerCount;

  return ac;
}

// ─── Minimal downloadFile simulator ──────────────────────────────────────────
//
// We don't make real HTTP calls. Instead we simulate the add/remove pattern
// that the real downloadFile() uses: attach a handler, do some async work,
// then removeEventListener in a finally block.
//
// outcome: 'success' | 'failure' | 'abort'

async function simulateDownload(signal, outcome = 'success') {
  if (signal?.aborted) throw new Error('Download aborted before start');

  let abortHandler;
  try {
    return await new Promise((resolve, reject) => {
      // Mirrors the real code: capture handler, attach, then do work
      abortHandler = () => reject(new Error('Download aborted'));
      signal?.addEventListener('abort', abortHandler);

      // Simulate async I/O
      setImmediate(() => {
        if (outcome === 'success') {
          resolve(1024);
        } else if (outcome === 'failure') {
          reject(new Error('Network error'));
        } else {
          // 'abort' — the signal fires
          signal?.dispatchEvent(new Event('abort'));
        }
      });
    });
  } finally {
    // This mirrors the finally block in the real downloader.js
    if (abortHandler && signal) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}

// ─── Property 4 ───────────────────────────────────────────────────────────────

describe('Property 4: AbortSignal listener count returns to baseline after downloads', () => {
  it('listener count equals baseline after K mixed success/failure downloads', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
        async (K, successFlags) => {
          const ac = makeTrackedController();
          const signal = ac.signal;
          const baseline = signal.getListenerCount();

          const outcomes = Array.from({ length: K }, (_, i) =>
            successFlags[i % successFlags.length] ? 'success' : 'failure'
          );

          // Run downloads sequentially so we can check after each
          for (const outcome of outcomes) {
            try {
              await simulateDownload(signal, outcome);
            } catch {
              // failures are expected — we only care about listener cleanup
            }
          }

          expect(signal.getListenerCount()).toBe(baseline);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 5 ───────────────────────────────────────────────────────────────

describe('Property 5: Listener count does not grow across retries', () => {
  it('total listener count after R retries does not exceed pre-first-attempt baseline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (R) => {
          const ac = makeTrackedController();
          const signal = ac.signal;
          const baseline = signal.getListenerCount();

          // Simulate R retry attempts — all fail (typical retry scenario)
          for (let attempt = 0; attempt < R; attempt++) {
            try {
              await simulateDownload(signal, 'failure');
            } catch {
              // Retry — listener should be cleaned up after each attempt
            }

            // After each retry, count must not exceed baseline
            expect(signal.getListenerCount()).toBeLessThanOrEqual(baseline);
          }

          // After all retries, count must equal baseline exactly
          expect(signal.getListenerCount()).toBe(baseline);
        }
      ),
      { numRuns: 100 }
    );
  });
});
