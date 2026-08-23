'use strict';

/**
 * CPU visibility (Round A, Item 4) — LOG ONLY, and these tests hold it there.
 *
 * The parsers are pure; readCgroupCpuQuota takes an injected readFile so v1,
 * v2 and no-cgroup machines are all testable on any host. The last test is the
 * order itself: this module must never be imported by config.js, because
 * feeding the cgroup number into sizing would silently halve ffmpegThreads
 * (min(2, floor(6/4)) = 1) — which is on the round's must-not-change list.
 */

const fs = require('fs');
const path = require('path');

process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';

const {
  parseCpuMax,
  parseCfsQuota,
  readCgroupCpuQuota,
  logCpuVisibility,
} = require('../../src/cpuVisibility');

describe('parseCpuMax (cgroup v2)', () => {
  it('reads the production box shape: NanoCpus=6e9 -> "600000 100000" -> 6 CPUs', () => {
    expect(parseCpuMax('600000 100000')).toBe(6);
    expect(parseCpuMax('600000 100000\n')).toBe(6);
  });

  it('an uncapped container says "max" and yields null', () => {
    expect(parseCpuMax('max 100000')).toBeNull();
  });

  it('degrades to null on garbage rather than inventing a number', () => {
    expect(parseCpuMax('')).toBeNull();
    expect(parseCpuMax('banana')).toBeNull();
    expect(parseCpuMax(undefined)).toBeNull();
    expect(parseCpuMax('-1 100000')).toBeNull();
  });
});

describe('parseCfsQuota (cgroup v1)', () => {
  it('reads quota/period pairs', () => {
    expect(parseCfsQuota('600000\n', '100000\n')).toBe(6);
  });

  it('-1 means no cap, and yields null', () => {
    expect(parseCfsQuota('-1', '100000')).toBeNull();
  });
});

describe('readCgroupCpuQuota', () => {
  it('prefers v2 when cpu.max is readable', () => {
    const result = readCgroupCpuQuota((p) => {
      if (p === '/sys/fs/cgroup/cpu.max') return '600000 100000\n';
      throw new Error('unexpected read: ' + p);
    });
    expect(result).toEqual({ version: 'v2', raw: '600000 100000', quotaCpus: 6 });
  });

  it('falls back to v1 files', () => {
    const result = readCgroupCpuQuota((p) => {
      if (p === '/sys/fs/cgroup/cpu.max') throw new Error('ENOENT');
      if (p === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '600000\n';
      if (p === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000\n';
      throw new Error('unexpected read: ' + p);
    });
    expect(result.version).toBe('v1');
    expect(result.quotaCpus).toBe(6);
  });

  it('reports honestly when no cgroup is readable', () => {
    const result = readCgroupCpuQuota(() => {
      throw new Error('ENOENT');
    });
    expect(result).toEqual({ version: null, raw: null, quotaCpus: null });
  });
});

describe('log only — the order that keeps sizing untouched', () => {
  it('emits one info line carrying both numbers side by side', () => {
    const lines = [];
    const fakeLogger = { info: (fields, msg) => lines.push({ fields, msg }) };
    const config = require('../../src/config');
    logCpuVisibility(fakeLogger, config);
    expect(lines).toHaveLength(1);
    const { fields, msg } = lines[0];
    expect(msg).toContain('log only');
    expect(fields.osCpus).toBeGreaterThan(0);
    expect(fields.sizedFrom).toBe(config.detectedCpuCount);
    expect(fields.ffmpegThreads).toBe(config.ffmpegThreads);
    // availableParallelism exists on Node 20; the field must be present either way.
    expect('availableParallelism' in fields).toBe(true);
    expect('cgroupQuotaCpus' in fields).toBe(true);
  });

  it('config.js does not import cpuVisibility — sizing cannot see the cgroup number', () => {
    const configSource = fs.readFileSync(path.resolve(__dirname, '../../src/config.js'), 'utf8');
    expect(configSource).not.toContain('cpuVisibility');
    expect(configSource).not.toContain('availableParallelism');
    expect(configSource).not.toContain('/sys/fs/cgroup');
  });
});
