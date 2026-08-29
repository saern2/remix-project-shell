/**
 * Item 3's fault matrix, one injection per case: the job core runs against
 * fake engine/render deps, so 402, 401, turn cap, wall clock, Chrome death
 * and the unreachable template fallback are each a one-line fault rather
 * than a mocked network. Worker-death-mid-job is covered at the app layer
 * (a vanished/failed job fails the project honestly) — a killed process has
 * no code left to test here.
 */

import { describe, expect, it } from 'vitest';
import { runMotionJob } from '../src/motionJob.js';
import { MotionJobFailure, describeEngineError } from '../src/failures.js';

const INPUT = { brief: 'A 20-second SaaS dashboard explainer.', model: 'glm-5.3', maxTurns: 5, wallClockSeconds: 600 };

function deps(overrides = {}) {
  return {
    apiKey: 'sk-user-key',
    createProject: () => ({
      dir: '/job/projects/p',
      htmlFile: '/job/projects/p/index.html',
      exportsDir: '/job/projects/p/exports',
      name: 'p',
    }),
    generate: async () => ({ usedFallback: false, stopReason: 'complete', files: {} }),
    render: async () => '/job/projects/p/exports/out.mp4',
    harvestNewestMp4: () => null,
    emitProgress: () => {},
    now: () => Date.now(),
    ...overrides,
  };
}

describe('success paths', () => {
  it('harvests the MP4 the agent rendered mid-loop instead of rendering twice (D8)', async () => {
    let rendered = false;
    const result = await runMotionJob(INPUT, deps({
      harvestNewestMp4: () => '/job/projects/p/exports/agent-made.mp4',
      render: async () => {
        rendered = true;
        return '/never';
      },
    }));
    expect(result.mp4Path).toBe('/job/projects/p/exports/agent-made.mp4');
    expect(rendered).toBe(false);
  });

  it('renders explicitly when the agent did not', async () => {
    const result = await runMotionJob(INPUT, deps());
    expect(result.mp4Path).toBe('/job/projects/p/exports/out.mp4');
  });

  it('passes the key in memory only: options.apiKey and configOverrides.apiKey (D2)', async () => {
    let seen = null;
    await runMotionJob(INPUT, deps({
      generate: async (_messages, options) => {
        seen = { apiKey: options.apiKey, overrideKey: options.configOverrides.apiKey };
        return { usedFallback: false, stopReason: 'complete' };
      },
    }));
    expect(seen).toEqual({ apiKey: 'sk-user-key', overrideKey: 'sk-user-key' });
  });
});

describe('failure honesty (Item 3)', () => {
  it('the unreachable template fallback fails loudly if it ever fires (D1)', async () => {
    await expect(
      runMotionJob(INPUT, deps({ generate: async () => ({ usedFallback: true, stopReason: 'complete' }) })),
    ).rejects.toThrow(/no explainer was generated/);
  });

  it("Anymotion's own turn limit is a worded failure, never a partial success", async () => {
    await expect(
      runMotionJob(INPUT, deps({ generate: async () => ({ usedFallback: false, stopReason: 'turn-limit' }) })),
    ).rejects.toThrow(/did not converge within 5 agent turns/);
  });

  it('our tighter turn cap aborts via the per-turn event and words the same failure (D3)', async () => {
    await expect(
      runMotionJob(INPUT, deps({
        generate: async (_messages, options) => {
          for (let n = 1; n <= 10; n++) {
            options.emit({ type: 'turn', n, of: 150 });
            if (options.signal.aborted) {
              const err = new Error('aborted');
              throw err;
            }
          }
          return { usedFallback: false, stopReason: 'complete' };
        },
      })),
    ).rejects.toThrow(/did not converge within 5 agent turns/);
  });

  it('the wall clock aborts a stalled provider and says which ceiling fired (D3)', async () => {
    await expect(
      runMotionJob(
        { ...INPUT, wallClockSeconds: 0.05 },
        deps({
          generate: (_messages, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        }),
      ),
    ).rejects.toThrow(/was still running after 0 minutes/);
  });

  it('provider errors pass straight through as thrown errors, never swallowed', async () => {
    const providerError = Object.assign(new Error('API Error 402'), {
      status: 402,
      explained: '402 Payment Required — the account behind this key is out of credit at agentrouter.org.',
    });
    await expect(
      runMotionJob(INPUT, deps({ generate: async () => { throw providerError; } })),
    ).rejects.toBe(providerError);
  });
});

describe('describeEngineError — the words the user reads', () => {
  it('402: credit or daily-batch unavailability, with the verified alternatives named', () => {
    const message = describeEngineError(
      Object.assign(new Error('x'), { status: 402, explained: '402 Payment Required — out of credit.' }),
    );
    expect(message).toContain('out of credit');
    expect(message).toContain('daily batches');
    expect(message).toContain('GLM or DeepSeek');
    expect(message).toContain('verified working');
  });

  it('401: key rejected, with the provider detail attached', () => {
    const message = describeEngineError(
      Object.assign(new Error('x'), { status: 401, explained: '401 Unauthorized — your API key was rejected.' }),
    );
    expect(message).toContain('rejected');
    expect(message).toContain('save it again');
  });

  it("Anymotion's explained message passes through verbatim when present", () => {
    const message = describeEngineError(
      Object.assign(new Error('boom'), { status: 429, explained: '429 rate limited — wait and retry.' }),
    );
    expect(message).toBe('429 rate limited — wait and retry.');
  });

  it('Chrome failing to launch is named a platform problem, not a user problem', () => {
    const message = describeEngineError(new Error('Failed to launch the browser process! chromium: not found'));
    expect(message).toContain('platform problem');
    expect(message).toContain('not your brief');
  });

  it('MotionJobFailure is an Error and its message survives BullMQ failedReason', () => {
    const failure = new MotionJobFailure('worded');
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('worded');
  });
});
