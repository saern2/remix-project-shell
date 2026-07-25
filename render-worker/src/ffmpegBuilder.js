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
 *    through: scale → pad → setsar → fps.  Only after all streams are
 *    uniform is concat invoked.
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

function buildNormFilter(inputIndex, outLabel, width, height, fps) {
  // Note: stream specifier [N:v] selects the video stream of the Nth input.
  return (
    `[${inputIndex}:v]setpts=PTS-STARTPTS,` +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
    `setsar=1,` +
    `fps=${fps}` +
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
function buildFilterGraph({ clips, width, height, fps, transition, transitionDuration, tempDir }) {
  if (!SUPPORTED_TRANSITIONS.has(transition)) {
    throw new Error(
      `Unsupported transition: "${transition}". Supported: ${[...SUPPORTED_TRANSITIONS].join(', ')}`
    );
  }

  const n = clips.length;
  const lines = [];

  const w = width % 2 === 0 ? width : width - 1;
  const h = height % 2 === 0 ? height : height - 1;

  // ── Step 1: Normalise every input clip ──────────────────────────────────
  for (let i = 0; i < n; i++) {
    lines.push(buildNormFilter(i, `[v${i}]`, w, h, fps));
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
    // Compute per-clip durations (end - start)
    const durations = clips.map((c) => c.end - c.start);
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

module.exports = { buildFilterGraph, SUPPORTED_TRANSITIONS };
