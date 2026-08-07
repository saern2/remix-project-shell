'use strict';

/**
 * The 502s: encodes must yield the cpu to the API.
 *
 * The server handlers were audited for synchronous work first — they are all
 * async Redis/BullMQ I/O, and the JSON body is capped at 1 MB — so the 502s
 * during the five-project run point at OS-level saturation: 4 encodes x 2
 * threads plus stitches ran at the SAME scheduling priority as node, so the
 * accept queue and timers were serviced late and the reverse proxy gave up.
 *
 * The remedy is niceness, and these tests pin that both ffmpeg invocations
 * carry it, that the default actually demotes (a configured 0 would silently
 * restore the starvation), and that the config rejects a negative value, which
 * would put encodes ABOVE node — the inversion of the point.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const fs = require('fs');
const path = require('path');

process.env.WORKER_API_KEY = process.env.WORKER_API_KEY || 'test-key';
const config = require('../../src/config');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderJob.js'), 'utf8');

describe('ffmpeg runs below node', () => {
  it('defaults to a positive niceness', () => {
    expect(config.ffmpegNiceness).toBeGreaterThan(0);
    expect(config.ffmpegNiceness).toBeLessThanOrEqual(19);
  });

  it('nices every ffmpeg invocation, encode and stitch alike', () => {
    // Both call sites — a bare ffmpeg() would spawn at niceness 0 and the
    // starvation would return through whichever path kept it.
    const niced = SOURCE.match(/ffmpeg\(\{ niceness: config\.ffmpegNiceness \}\)/g) ?? [];
    const bare = SOURCE.match(/ffmpeg\(\)/g) ?? [];
    expect(niced.length).toBe(2);
    expect(bare.length).toBe(0);
  });

  it('is wired through fluent-ffmpeg, which renices after spawn', () => {
    // Pinned because this is the mechanism the whole fix rests on: fluent-ffmpeg
    // applies options.niceness via renice on POSIX. If a future refactor swaps
    // the library, the niceness has to move with it.
    const fluent = fs.readFileSync(
      path.join(__dirname, '../../node_modules/fluent-ffmpeg/lib/processor.js'),
      'utf8',
    );
    expect(fluent).toMatch(/options\.niceness/);
  });
});
