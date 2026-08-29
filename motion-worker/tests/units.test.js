/**
 * The small sharp pieces: key crypto (with the no-plaintext-in-Redis pin),
 * the render gate, ETA math, MP4 harvesting, the orphan sweep's live-job
 * guard, and submission validation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.MOTION_WORKER_API_KEY ||= 'test-key';
process.env.MOTION_WORKER_KEY_SECRET ||= 'test-secret';

const { encryptKey, decryptKey } = await import('../src/keyCrypto.js');
const { renderGateOpen, RENDER_CHUNK_ACTIVE_KEY } = await import('../src/renderGate.js');
const { estimateWaitSeconds } = await import('../src/jobStats.js');
const { harvestNewestMp4 } = await import('../src/harvest.js');
const { sweepOrphans } = await import('../src/sweep.js');
const { validateSubmission } = await import('../src/validate.js');

describe('keyCrypto (D5)', () => {
  it('round-trips, and the ciphertext never contains the plaintext', () => {
    const key = 'sk-user-abcdef1234567890';
    const ct = encryptKey(key, 'secret-1');
    expect(ct).not.toContain(key);
    expect(Buffer.from(ct, 'base64').toString('latin1')).not.toContain(key);
    expect(decryptKey(ct, 'secret-1')).toBe(key);
  });

  it('a different secret or a tampered byte refuses to decrypt', () => {
    const ct = encryptKey('sk-user-key', 'secret-1');
    expect(() => decryptKey(ct, 'secret-2')).toThrow();
    const raw = Buffer.from(ct, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptKey(raw.toString('base64'), 'secret-1')).toThrow();
  });

  it('unique IVs: the same key encrypts differently every time', () => {
    expect(encryptKey('sk-k', 's')).not.toBe(encryptKey('sk-k', 's'));
  });
});

describe('render gate (V4)', () => {
  const fakeRedis = (impl) => ({ llen: impl });

  it('reads exactly bull:render-chunk:active and opens only below the threshold', async () => {
    let asked = null;
    const open = await renderGateOpen(fakeRedis(async (k) => ((asked = k), 0)));
    expect(asked).toBe('bull:render-chunk:active');
    expect(RENDER_CHUNK_ACTIVE_KEY).toBe('bull:render-chunk:active');
    expect(open).toBe(true);
    expect(await renderGateOpen(fakeRedis(async () => 1))).toBe(false);
    expect(await renderGateOpen(fakeRedis(async () => 4))).toBe(false);
  });

  it('an unreadable gate HOLDS — never starts a 42-minute burst blind', async () => {
    expect(await renderGateOpen(fakeRedis(async () => { throw new Error('down'); }))).toBe(false);
  });
});

describe('ETA math (Item 2 / D10)', () => {
  it('quotes everything ahead plus your own job at the measured median', () => {
    // Depth 1 (you, one active): 2 jobs' worth. Seeded median 2539s ≈ 42m.
    expect(estimateWaitSeconds({ position: 1, medianSeconds: 2539, concurrency: 1, activeCount: 1 })).toBe(5078);
    // Depth 3 behind one active job ≈ the two-hours-plus the operator named.
    const last = estimateWaitSeconds({ position: 3, medianSeconds: 2539, concurrency: 1, activeCount: 1 });
    expect(last).toBe(4 * 2539);
    expect(last / 3600).toBeGreaterThan(2);
  });

  it('first in line with nothing active is one median', () => {
    expect(estimateWaitSeconds({ position: 1, medianSeconds: 2539, concurrency: 1, activeCount: 0 })).toBe(2539);
  });
});

describe('harvestNewestMp4 (D8)', () => {
  it('picks the newest non-empty mp4; missing dir is null, never a throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
    fs.writeFileSync(path.join(dir, 'old.mp4'), 'aa');
    fs.utimesSync(path.join(dir, 'old.mp4'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    fs.writeFileSync(path.join(dir, 'empty.mp4'), '');
    fs.writeFileSync(path.join(dir, 'new.mp4'), 'bb');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    expect(harvestNewestMp4(dir)).toBe(path.join(dir, 'new.mp4'));
    expect(harvestNewestMp4(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('orphan sweep (D6) — age alone never decides', () => {
  function makeJobDir(root, name, ageMs) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'frame.png'), 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  }

  it('sweeps old+dead, keeps old+live, keeps fresh, keeps on liveness error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
    makeJobDir(root, 'old-dead', 3 * 60 * 60 * 1000);
    makeJobDir(root, 'old-live', 3 * 60 * 60 * 1000);
    makeJobDir(root, 'fresh-dead', 60 * 1000);
    makeJobDir(root, 'old-unknown', 3 * 60 * 60 * 1000);

    const { swept, kept } = await sweepOrphans({
      tmpDir: root,
      graceMs: 2 * 60 * 60 * 1000,
      isJobLive: async (id) => {
        if (id === 'old-unknown') throw new Error('redis down');
        return id === 'old-live';
      },
      now: () => Date.now(),
    });

    expect(swept).toEqual(['old-dead']);
    expect(kept.sort()).toEqual(['fresh-dead', 'old-live', 'old-unknown']);
    expect(fs.existsSync(path.join(root, 'old-dead'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'old-live'))).toBe(true);
  });
});

describe('submission validation', () => {
  const good = () => ({
    job_id: 'motion-p1',
    brief: 'A 20-second SaaS analytics dashboard explainer with five scenes.',
    model: 'glm-5.3',
    api_key: 'sk-user',
    upload_url: 'https://x.supabase.co/storage/v1/object/upload/sign/render-outputs/p/j.mp4',
  });

  it('accepts the contract shape', () => {
    expect(validateSubmission(good())).toBeNull();
  });

  it.each([
    [(b) => delete b.job_id, 'job_id'],
    [(b) => (b.brief = 'short'), 'at least 10'],
    [(b) => (b.brief = 'x'.repeat(20_001)), 'under 20,000'],
    [(b) => (b.model = ''), 'model'],
    [(b) => (b.api_key = ''), 'api_key'],
    [(b) => (b.upload_url = 'http://insecure'), 'https'],
  ])('refuses malformed payloads with named reasons', (mutate, fragment) => {
    const body = good();
    mutate(body);
    expect(validateSubmission(body)).toContain(fragment);
  });
});
