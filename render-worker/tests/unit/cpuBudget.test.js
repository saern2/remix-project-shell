'use strict';

/**
 * The encode thread budget.
 *
 * The divisor was totalWorkerSlots, which counted two kinds of slot that never
 * encode anything:
 *
 *   - the legacy `render` queue (2 slots). With CHUNK_SIZE set every job is
 *     chunked, so that queue never runs — it reserved a quarter of the machine
 *     for work that does not exist.
 *   - stitch slots (2). Stitch concatenates with -c:v copy, so it is I/O and
 *     muxing, not encode cpu.
 *
 * On the 8 vCPU host that gave floor(8/8) = 1 thread per chunk. Benchmarked on
 * that hardware at 1080p30 CRF 23:
 *
 *   threads=1  1.44x realtime
 *   threads=2  3.20x realtime   <- the knee, 2.2x the throughput of one
 *   threads=4  3.44x realtime   <- a fourth thread buys 7%
 *
 * Dividing by chunk concurrency alone gives floor(8/4) = 2, landing exactly on
 * the knee.
 */
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../src/config.js');

/** Loads config fresh with a pretended cpu count and env. */
function loadConfig({ cpuCount, env = {} }) {
  const realCpus = os.cpus;
  os.cpus = () => new Array(cpuCount).fill({ model: 'test', speed: 0, times: {} });

  const saved = {};
  const applied = {
    WORKER_API_KEY: 'test-key',
    REDIS_URL: 'redis://localhost:6379/9',
    ...env,
  };
  for (const [key, value] of Object.entries(applied)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    delete require.cache[require.resolve(CONFIG_PATH)];
    return require(CONFIG_PATH);
  } finally {
    os.cpus = realCpus;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(CONFIG_PATH)];
  }
}

describe('the production host: 8 vCPU, 4 chunk slots', () => {
  it('gives each chunk 2 threads, the measured knee', () => {
    const config = loadConfig({ cpuCount: 8, env: { WORKER_CONCURRENCY_CHUNKS: '4' } });
    expect(config.ffmpegThreads).toBe(2);
  });

  it('divides by chunk slots, not by every slot', () => {
    const config = loadConfig({ cpuCount: 8, env: { WORKER_CONCURRENCY_CHUNKS: '4' } });
    expect(config.encodeWorkerSlots).toBe(4);
    // totalWorkerSlots still exists for ffmpegMaxProcesses; it just no longer
    // decides the thread budget. floor(8/8) = 1 was the old, wrong answer.
    expect(config.totalWorkerSlots).toBe(8);
    expect(config.ffmpegThreads).not.toBe(
      Math.floor(config.detectedCpuCount / config.totalWorkerSlots),
    );
  });

  it('is unaffected by the legacy queue concurrency', () => {
    // The legacy render queue never runs when chunking is on, so changing its
    // concurrency must not move the encode budget at all.
    const withLegacy = loadConfig({
      cpuCount: 8,
      env: { WORKER_CONCURRENCY_CHUNKS: '4', WORKER_CONCURRENCY: '2' },
    });
    const withoutLegacy = loadConfig({
      cpuCount: 8,
      env: { WORKER_CONCURRENCY_CHUNKS: '4', WORKER_CONCURRENCY: '1' },
    });
    expect(withLegacy.ffmpegThreads).toBe(withoutLegacy.ffmpegThreads);
  });

  it('is unaffected by stitch concurrency, which does not re-encode', () => {
    const two = loadConfig({
      cpuCount: 8,
      env: { WORKER_CONCURRENCY_CHUNKS: '4', WORKER_CONCURRENCY_STITCHES: '2' },
    });
    const four = loadConfig({
      cpuCount: 8,
      env: { WORKER_CONCURRENCY_CHUNKS: '4', WORKER_CONCURRENCY_STITCHES: '4' },
    });
    expect(two.ffmpegThreads).toBe(four.ffmpegThreads);
  });
});

describe('the cap', () => {
  it('stops at 2 threads even on a large host', () => {
    // 32 cpus / 4 chunks would be 8 threads, but x264 returns almost nothing
    // past 2 — the cpu is better spent on more concurrent chunks.
    const config = loadConfig({ cpuCount: 32, env: { WORKER_CONCURRENCY_CHUNKS: '4' } });
    expect(config.ffmpegThreads).toBe(2);
  });

  it('is configurable for hardware that has not been benchmarked', () => {
    const config = loadConfig({
      cpuCount: 32,
      env: { WORKER_CONCURRENCY_CHUNKS: '4', MAX_FFMPEG_THREADS: '4' },
    });
    expect(config.ffmpegThreads).toBe(4);
  });
});

describe('small hosts still get a working budget', () => {
  it('never drops below one thread', () => {
    const config = loadConfig({ cpuCount: 2, env: { WORKER_CONCURRENCY_CHUNKS: '4' } });
    expect(config.ffmpegThreads).toBeGreaterThanOrEqual(1);
  });

  it('caps chunk concurrency at the cpu count before dividing', () => {
    // 2 cpus with 4 requested chunk slots: the effective concurrency is 2, so
    // the budget is floor(2/2) = 1 rather than floor(2/4) = 0.
    const config = loadConfig({ cpuCount: 2, env: { WORKER_CONCURRENCY_CHUNKS: '4' } });
    expect(config.encodeWorkerSlots).toBe(2);
    expect(config.ffmpegThreads).toBe(1);
  });
});

describe('an explicit setting always wins', () => {
  it('honours FFMPEG_THREADS and skips auto-sizing', () => {
    const config = loadConfig({
      cpuCount: 8,
      env: { WORKER_CONCURRENCY_CHUNKS: '4', FFMPEG_THREADS: '3' },
    });
    expect(config.ffmpegThreads).toBe(3);
  });
});
