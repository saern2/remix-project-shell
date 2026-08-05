'use strict';

/**
 * ffmpegBuilder.js
 *
 * Builds FFmpeg filter graphs for the render pipeline.
 *
 * KEY DESIGN DECISIONS:
 *
 * 1. Per-clip normalisation BEFORE concat (the v1 bug fix):
 *    Every input clip — regardless of source resolution or fps — is passed
 *    through: scale (increase) → crop → setsar → fps.  Only after all
 *    streams are uniform is concat invoked.  Using
 *    force_original_aspect_ratio=increase + crop fills the target canvas
 *    completely with no black bars (cover behaviour, not letterbox).
 *
 * 2. -filter_complex_script <file> (the large-graph fix):
 *    For 50+ clip projects, the filter graph string would exceed OS
 *    command-line argument limits if passed inline with -filter_complex.
 *    We always write the graph to a temp file and use -filter_complex_script.
 *
 * 3. Audio excluded from the filter graph:
 *    Synthetic clips carry no audio; only the voiceover audio_url track
 *    is muxed in at the final encode step.
 *
 * 4. Transitions:
 *    - 'hard-cut': plain concat, no xfade.
 *    - 'crossfade': xfade=transition=fade chained between consecutive clips.
 *    Wipe variants deferred until crossfade is proven solid.
 */

const fs = require('fs');
const path = require('path');

const SUPPORTED_TRANSITIONS = new Set(['hard-cut', 'crossfade']);

/**
 * Per-clip frame counts on a CUMULATIVE timeline.
 *
 * The bug this replaces: each clip was trimmed independently with
 * `trim=duration=D`, and the `fps` filter resolves a D-second input to
 * round(D x fps) frames. The sub-frame remainder in [-0.5, +0.5) frames was
 * therefore discarded per clip instead of being carried into the next one, so
 * the total length of a render was a random walk around the audio duration
 * rather than a fixed function of it (measured: -1.11 frames over 240 clips,
 * but unbounded in principle and random in SIGN — when it lands negative,
 * `-shortest` silently truncates the tail of the narration).
 *
 * Instead of asking each clip for a duration, ask the shared timeline where
 * this clip's boundary falls. Clip i gets
 *     round(cumulativeEnd_i x fps) - round(cumulativeEnd_(i-1) x fps)
 * frames, so consecutive counts telescope: the frames emitted for the whole
 * job are exactly round(totalDuration x fps), independent of how the total is
 * split into clips or chunks.
 *
 * `timelineOffsetSeconds` is what makes that hold ACROSS chunks. Each chunk is
 * rendered by a separate process with its own graph, so without the offset each
 * chunk would restart the timeline at zero and re-introduce up to half a frame
 * of error per chunk boundary.
 *
 * @param {Array<{start:number,end:number}>} clips
 * @param {number} fps
 * @param {number} timelineOffsetSeconds - seconds of finished timeline preceding this chunk
 * @returns {number[]} frame count per clip
 */
function computeClipFrameCounts(clips, fps, timelineOffsetSeconds = 0) {
  const offset = Number.isFinite(timelineOffsetSeconds) ? Math.max(0, timelineOffsetSeconds) : 0;
  let cumulativeSeconds = offset;
  let emittedFrames = Math.round(offset * fps);

  return clips.map((clip) => {
    cumulativeSeconds += clip.end - clip.start;
    const boundaryFrame = Math.round(cumulativeSeconds * fps);
    // A clip shorter than half a frame would round to zero frames, which would
    // hand concat an empty stream. Force one frame and let the running total
    // absorb it — the next clip's count comes out one lower, so the timeline
    // self-corrects instead of drifting.
    const frameCount = Math.max(1, boundaryFrame - emittedFrames);
    emittedFrames += frameCount;
    return frameCount;
  });
}

function buildNormFilter(inputIndex, outLabel, width, height, fps, frameCount) {
  // tpad pads past the end of short sources so `trim` always has frameCount
  // frames to take; the extra second is cloned frames that trim drops
  // immediately, so it costs nothing to encode.
  const padSeconds = Number((frameCount / fps + 1).toFixed(6));
  // Note: stream specifier [N:v] selects the video stream of the Nth input.
  return (
    `[${inputIndex}:v]setpts=PTS-STARTPTS,` +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
    `setsar=1,` +
    `fps=${fps},` +
    `tpad=stop_mode=clone:stop_duration=${padSeconds},` +
    // end_frame, not duration: an exact frame count is the whole point. With
    // `duration` the count would be re-derived from a timestamp and re-rounded.
    `trim=end_frame=${frameCount},` +
    `setpts=PTS-STARTPTS` +
    `${outLabel}`
  );
}

/**
 * Returns a chained crossfade (xfade) filter fragment.
 *
 * @param {string} inA        - Input label A, e.g. '[v0]'
 * @param {string} inB        - Input label B, e.g. '[v1]'
 * @param {string} outLabel   - Output label, e.g. '[xf0]'
 * @param {number} duration   - Transition duration in seconds
 * @param {number} offset     - xfade offset (end of clip A minus transition_duration)
 */
function buildXfadeFilter(inA, inB, outLabel, duration, offset) {
  return `${inA}${inB}xfade=transition=fade:duration=${duration}:offset=${offset}${outLabel}`;
}

/**
 * Builds the complete FFmpeg filtergraph for a render job, writes it to a
 * temp file, and returns the path to that file plus the final video label.
 *
 * @param {object} params
 * @param {Array<{clip_url:string, start:number, end:number}>} params.clips
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.fps
 * @param {string} params.transition        - 'hard-cut' | 'crossfade'
 * @param {number} params.transitionDuration - seconds
 * @param {string} params.tempDir           - existing temp dir to write script file into
 * @returns {{ scriptPath: string, finalVideoLabel: string }}
 */
function buildFilterGraph({
  clips,
  width,
  height,
  fps,
  transition,
  transitionDuration,
  tempDir,
  timelineOffsetSeconds = 0,
}) {
  if (!SUPPORTED_TRANSITIONS.has(transition)) {
    throw new Error(
      `Unsupported transition: "${transition}". Supported: ${[...SUPPORTED_TRANSITIONS].join(', ')}`
    );
  }

  const n = clips.length;
  const lines = [];

  const w = width % 2 === 0 ? width : width - 1;
  const h = height % 2 === 0 ? height : height - 1;

  // Frame counts come from the shared timeline, not from each clip in isolation.
  const frameCounts = computeClipFrameCounts(clips, fps, timelineOffsetSeconds);

  // ── Step 1: Normalise every input clip ──────────────────────────────────
  for (let i = 0; i < n; i++) {
    lines.push(buildNormFilter(i, `[v${i}]`, w, h, fps, frameCounts[i]));
  }

  let finalLabel;

  if (n === 1) {
    // Single clip — no concat or transition needed
    finalLabel = '[v0]';
  } else if (transition === 'hard-cut') {
    // ── Step 2a: Hard-cut concat ─────────────────────────────────────────
    const inputLabels = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
    finalLabel = '[vout]';
    lines.push(`${inputLabels}concat=n=${n}:v=1:a=0${finalLabel}`);
  } else {
    // ── Step 2b: Crossfade chain via xfade ───────────────────────────────
    // Durations come from the frame counts actually emitted, so the xfade
    // offsets line up with real stream lengths rather than requested ones.
    const durations = frameCounts.map((frames) => frames / fps);
    const td = transitionDuration;

    // xfade offset for each transition = Σ(durations[0..i]) - (i+1)*td
    let xfIn_A = '[v0]';
    let cumulativeDuration = durations[0];

    for (let i = 0; i < n - 1; i++) {
      const offset = Math.max(0, cumulativeDuration - td);
      const outLabel = i === n - 2 ? '[vout]' : `[xf${i}]`;
      lines.push(buildXfadeFilter(xfIn_A, `[v${i + 1}]`, outLabel, td, offset.toFixed(6)));
      xfIn_A = outLabel;
      cumulativeDuration += durations[i + 1] - td; // overlap reduces total length
    }

    finalLabel = '[vout]';
  }

  const graphContent = lines.join(';\n') + '\n';
  const scriptPath = path.join(tempDir, 'filtergraph.txt');
  fs.writeFileSync(scriptPath, graphContent, 'utf8');

  return { scriptPath, finalVideoLabel: finalLabel };
}

module.exports = { buildFilterGraph, computeClipFrameCounts, SUPPORTED_TRANSITIONS };
