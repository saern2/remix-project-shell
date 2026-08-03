import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import { createRequire } from 'module';

process.env.WORKER_API_KEY = 'test-api-key-secret';
process.env.NODE_ENV = 'test';
process.env.JOB_ATTEMPTS = '3';
process.env.JOB_BACKOFF_DELAY_MS = '5000';

const API_KEY = 'test-api-key-secret';
const _require = createRequire(import.meta.url);
const { cancelJobsByPrefix } = _require('../src/cancelJobs.js');

let mockWaiting = [];
let mockDelayed = [];
let mockWaitingChildren = [];
let mockActive = [];

const mockWriteCancelFlag = vi.fn(async () => {});

function makeFakeJob(id, state) {
  return {
    id,
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => {}),
  };
}

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

  app.post('/jobs/:id/cancel', requireApiKey, async (req, res) => {
    const jobId = req.params.id;
    try {
      const queues = [
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

      const result = await cancelJobsByPrefix({
        jobId,
        queues,
        redis: {},
        writeCancelFlag: mockWriteCancelFlag,
        logger: { warn: vi.fn() },
      });

      return res.status(200).json({
        cancelled: true,
        cancelled_count: result.cancelledCount,
        matched_count: result.matchedCount,
        vanished_count: result.vanishedCount,
        job_id: jobId,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to cancel job', detail: err.message });
    }
  });

  return app;
}

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

  it('returns 200 when the job ID has already left every queue', async () => {
    const res = await supertest(app)
      .post('/jobs/unknown-job-id/cancel')
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.cancelled_count).toBe(0);
    expect(res.body.matched_count).toBe(0);
    expect(res.body.job_id).toBe('unknown-job-id');
  });

  it('returns 200 and removes a queued job', async () => {
    const jobId = 'job-queued-123';
    const fakeJob = makeFakeJob(jobId, 'waiting');
    mockWaiting = [fakeJob];

    const res = await supertest(app)
      .post(`/jobs/${jobId}/cancel`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled_count).toBe(1);
    expect(fakeJob.remove).toHaveBeenCalledTimes(1);
    expect(mockWriteCancelFlag).not.toHaveBeenCalled();
  });

  it('returns 200 and writes a cancel flag for an active job', async () => {
    const jobId = 'job-active-456';
    const fakeJob = makeFakeJob(jobId, 'active');
    mockActive = [fakeJob];

    const res = await supertest(app)
      .post(`/jobs/${jobId}/cancel`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled_count).toBe(1);
    expect(mockWriteCancelFlag).toHaveBeenCalledWith(expect.anything(), jobId);
    expect(fakeJob.remove).not.toHaveBeenCalled();
  });

  it('ignores an undefined queue entry and still cancels the matching job', async () => {
    const jobId = 'job-racy-scan-789';
    const fakeJob = makeFakeJob(jobId, 'waiting');
    mockWaiting = [undefined, fakeJob];

    const res = await supertest(app)
      .post(`/jobs/${jobId}/cancel`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled_count).toBe(1);
    expect(res.body.vanished_count).toBe(0);
    expect(fakeJob.remove).toHaveBeenCalledTimes(1);
  });

  it('continues when one matching job vanishes during state lookup', async () => {
    const jobId = 'job-racy-state-012';
    const vanishedJob = makeFakeJob(`${jobId}-chunk-0`, 'waiting');
    vanishedJob.getState.mockRejectedValueOnce(new Error('Missing key for job'));
    const remainingJob = makeFakeJob(`${jobId}-chunk-1`, 'waiting');
    mockWaiting = [vanishedJob, remainingJob];

    const res = await supertest(app)
      .post(`/jobs/${jobId}/cancel`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.cancelled_count).toBe(1);
    expect(res.body.matched_count).toBe(2);
    expect(res.body.vanished_count).toBe(1);
    expect(remainingJob.remove).toHaveBeenCalledTimes(1);
  });
});
