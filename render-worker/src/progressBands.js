'use strict';

/**
 * Progress-bar bands, sized to measured wall-time shares.
 *
 * THE OLD BANDS LIED TWICE. Chunks mapped to 0-45 and the stitch wrote 50, 90,
 * 100 at its three internal transitions — so "30 of 30 segments rendered"
 * displayed as 44%, and the last 12-14% of real work occupied 56% of the bar
 * while freezing twice: once for the whole concat (nothing between 50 and 90)
 * and once for the whole upload (nothing between 90 and 100).
 *
 * MEASURED 2026-08-15, two concurrent ~45-minute 1080p projects (captures
 * 65/66): chunk encoding 22m51s / 21m12s ≈ 86% of render wall time, combining
 * 1m35s / 2m12s ≈ 7%, uploading 1m07s / 1m23s ≈ 5%. The bands below match
 * those shares, so the bar advances at roughly the same real-time rate in
 * every phase — its speed means the same thing at 20% as at 95%.
 *
 * THE SHARES SHIFT WITH LOAD SHAPE, AND THE ERROR IS BOUNDED. The measurement
 * is two concurrent projects; a solo render gets all four chunk slots and a
 * less contended CPU, so its chunk phase shrinks relative to stitch+upload
 * (which are mostly serial/IO and barely change). If the true split moves to,
 * say, 80/12/8, a solo render's bar runs slightly fast through chunks and
 * slightly slow after 86% — a pacing error of a few percentage points, never a
 * freeze and never a regression to the 45→50→90 cliffs, because every band
 * still ANIMATES from its own live signal (chunk completions, ffmpeg out_time,
 * bytes uploaded). Weights only decide pacing; movement is real everywhere.
 */

/** Chunk encoding: 0 → 86, driven by chunks_completed / chunks_total. */
const CHUNK_BAND_END = 86;

/**
 * Combining (concat + audio mux): 86 → 93, driven by ffmpeg's out_time against
 * the timeline duration. 93, not 94: the +faststart second pass ("Finalizing
 * for playback") holds the bar at 93 so upload's start is visible as its own
 * movement.
 */
const COMBINE_BAND_END = 93;

/** Uploading: 94 → 100, driven by bytes sent over bytes total. */
const UPLOAD_BAND_START = 94;

/**
 * Seconds of output already written, parsed from an ffmpeg progress line.
 *
 * ffmpeg emits `time=HH:MM:SS.cc` on its stats lines (the same ones the
 * worker already relays to the log). Returns null for lines without one, and
 * for the `time=-00:00:00.06` negative-start artifact ffmpeg prints on the
 * first frames — a negative time is not progress.
 */
function parseFfmpegOutTimeSeconds(line) {
  const match = /(?:^|\s)time=(-?)(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(String(line ?? ''));
  if (!match) return null;
  if (match[1] === '-') return null;
  return Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

module.exports = {
  CHUNK_BAND_END,
  COMBINE_BAND_END,
  UPLOAD_BAND_START,
  parseFfmpegOutTimeSeconds,
};
