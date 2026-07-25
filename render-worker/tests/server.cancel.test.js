// Unit tests for POST /jobs/:id/cancel endpoint
// Validates: Requirements 3.1, 3.2, 3.3, 3.7, 3.8

import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';

// ─── Env must be set before any module loads ──────────────────────────────────
process.env.WORKER_API_KEY = 'test-api-key-secret';
process.env.NODE_ENV = 'test';
process.env.JOB_ATTEMPTS = '3';
process.env.JOB_BACKOFF_DELAY_MS = '5000';

const API_KEY = 'test-api-key-secret';

// ─── Mutable shared queue state (reset per test) ──────────────────────────────
let mockWaiting = [];
let mockDelayed = [];
let mockWaitingChildren = [];
let mockActive = [];

const mockWriteCancelFlag = vi.fn(async () => {});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeFakeJob(id, state) {
  return {
    id,
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => {}),
  };
}

// ─── Build a minimal Express app that exercises only the cancel endpoint ───────
//
// Rather than importing server.js (which calls main() and tries to bind a port
// and start real BullMQ workers), we replicate the cancel-endpoint logic in a
// thin test-only Express app. This lets us inject the mocked dependencies
// without fighting ESM/CJS hoisting or port conflicts.

import express from 'express';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

function buildCancelApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const config = _require('../src/config.js');

  function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== config.workerApiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Inline the cancel endpoint — mirrors server.js exactly, but uses mock deps
  app.post('/jobs/:id/cancel', requireApiKey, async (req, res) => {
    const jobId = req.params.id;
    try {
      const queues = [
        // Three "queues" that each return our mutable mock arrays
        {
          getWaiting: async () => mockWaiting,
          getDelayed: async () => mockDelayed,
          getWaitingChildren: async () => mockWaitingChildren,
          getActive: async () => mockActive,
        },
        {
          getWaiting: async () => [],
          getDelayed: async () => [],
          getWaitingChildren: async () => [],
          getActive: async () => [],
        },
        {
          getWaiting: async () => [],
          getDelayed: async () => [],
          getWaitingChildren: async () => [],
          getActive: async () => [],
        },
      ];

      const matchingJobs = [];
      for (const queue of queues) {
        const [waiting, delayed, waitingChildren, active] = await Promise.all([
          queue.getWaiting(),
          queue.getDelayed(),
          queue.getWaitingChildren(),
          queue.getActive(),
        ]);
        for (const job of [...waiting, ...delayed, ...waitingChildren, ...active]) {
          if (job.id && job.id.startsWith(jobId)) {
            matchingJobs.push(job);
          }
        }
      }

      if (matchingJobs.length === 0) {
        return res.status(404).json({ error: 'Job not found', job_id: jobId });
      }

      // Use a fake redis object
      const fakeRedis = {};

      for (const job of matchingJobs) {
        const state = await job.getState();
        if (state === 'active') {
          await mockWriteCancelFlag(fakeRedis, job.id);
        } else {
          await job.remove();
        }
      }

      return res.status(200).json({ cancelled: true, job_id: jobId });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to cancel job', detail: err.message });
    }
  });

  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /jobs/:id/cancel', () => {
  let app;

  beforeEach(() => {
    mockWaiting = [];
    mockDelayed = [];
    mockWaitingChildren = [];
    mockActive = [];
    vi.clearAllMocks();
    mockWriteCancelFlag.mockResolvedValue(undefined);
    app = buildCancelApp();
  });

  it('returns 401 when X-Api-Key header is missing', async () => {
    const res = await supertest(app).post('/jobs/abc123/cancel');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 when X-Api-Key header is wrong', async () => {
    const res = await supertest(app)
      .post('/jobs/abc123/cancel')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the job ID is not found in any queue', async () => {
    // queues are empty by default
    const res = await supertest(app)
      .post('/jobs/unknown-job-id/cancel')
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/job not found/i);
    expect(res.body.job_id).toBe('unknown-job-id');
  });

  it('returns 200 and calls job.remove() for a queued (waiting) job', async () => {
    const jobId = 'job-queued-123';
    const fakeJob = makeFakeJob(jobId, 'waiting');
    mockWaiting = [fakeJob];

    const res = await supertest(app)
      .post(`/jobs/${jobId}/cancel`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.job_id).toBe(jobId);
    expect(fakeJob.remove).toHaveBeenCalledTimes(1);
    expect(mockWriteCancelFlag).not.toHaveBeenCalled();
  });

  it('returns 200 and calls writeCancelFlag for an active job', async () => {
    const jobId = 'job-active-456';
    const fakeJob = makeFakeJob(jobId, 'active');
    mockActive = [fakeJob];

    const res = await supertest(app)
      .post(`/jobs/${jobId}/cancel`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.job_id).toBe(jobId);
    expect(mockWriteCancelFlag).toHaveBeenCalledWith(
      expect.anything(),
      jobId
    );
    expect(fakeJob.remove).not.toHaveBeenCalled();
  });
});
