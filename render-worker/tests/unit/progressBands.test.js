'use strict';

/**
 * The progress bands and the ffmpeg time parser that animates the combine.
 *
 * The bands' widths are a measurement (2026-08-15: encode 86%, combine 7%,
 * upload 5%), so these tests pin the CONTRACT — ordering, coverage, and the
 * one-point gap that makes the finalizing hold visible — not the numbers
 * themselves. If a new measurement moves the split, update progressBands.js
 * and its comment; these tests should survive that.
 */
const {
  CHUNK_BAND_END,
  COMBINE_BAND_END,
  UPLOAD_BAND_START,
  parseFfmpegOutTimeSeconds,
} = require('../../src/progressBands');

describe('the bands partition 0-100 in phase order', () => {
  it('orders chunk < combine < upload < 100 with room for every band to move', () => {
    expect(CHUNK_BAND_END).toBeGreaterThan(0);
    expect(COMBINE_BAND_END).toBeGreaterThan(CHUNK_BAND_END);
    expect(UPLOAD_BAND_START).toBeGreaterThan(COMBINE_BAND_END);
    expect(UPLOAD_BAND_START).toBeLessThan(100);
  });

  it('holds finalizing at a point of its own', () => {
    // The +faststart pass parks at COMBINE_BAND_END; upload starts strictly
    // above it, so the jump to UPLOAD_BAND_START is visible movement.
    expect(UPLOAD_BAND_START - COMBINE_BAND_END).toBeGreaterThanOrEqual(1);
  });
});

describe('parseFfmpegOutTimeSeconds', () => {
  it('reads the time from a real stats line', () => {
    // Verbatim from the 2026-08-15 worker log.
    const line =
      'frame= 2432 fps= 26 q=-1.0 Lsize=   41324kB time=00:01:20.96 bitrate=4181.1kbits/s speed=0.863x';
    expect(parseFfmpegOutTimeSeconds(line)).toBeCloseTo(80.96, 2);
  });

  it('handles hours, since a 45-minute video is the reference workload', () => {
    expect(parseFfmpegOutTimeSeconds('time=01:02:03.50 bitrate=...')).toBeCloseTo(3723.5, 2);
  });

  it('rejects the negative-start artifact instead of reporting progress', () => {
    // ffmpeg prints time=-00:00:00.06 on the first frames of some inputs —
    // also verbatim from the log. Negative time is not progress.
    expect(
      parseFfmpegOutTimeSeconds('frame=   17 fps=5.6 q=29.0 size=0kB time=-00:00:00.06'),
    ).toBeNull();
  });

  it('returns null for lines without a time', () => {
    expect(parseFfmpegOutTimeSeconds('Press [q] to stop, [?] for help')).toBeNull();
    expect(parseFfmpegOutTimeSeconds('')).toBeNull();
    expect(parseFfmpegOutTimeSeconds(null)).toBeNull();
    // "bitrate=..." must not be misread; only a real time= field counts.
    expect(parseFfmpegOutTimeSeconds('overtime=00:01:00.00')).toBeNull();
  });
});
