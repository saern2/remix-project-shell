/**
 * One motion job, as pure logic around injected Anymotion functions.
 *
 * The real child entry (runJob.js) wires the actual library; tests wire
 * fakes and drive every failure path (Item 3). Nothing here imports
 * Anymotion, Redis, or the filesystem beyond what the deps provide — that
 * is what makes 402/401/turn-cap/wall-cap/Chrome-death each a one-line
 * fault injection instead of a mocked network.
 *
 * FAILURE HONESTY (Item 3, D1):
 *  - the CLI is never invoked, so its template fallback is unreachable;
 *  - the engine's own no-key fallback returns usedFallback:true — asserted
 *    false defensively, and a true value FAILS the job loudly;
 *  - API errors arrive as throws carrying err.explained — Anymotion's own
 *    worded 401/402/rate-limit messages — and pass through verbatim;
 *  - stopReason 'turn-limit' and our own aborts are worded failures, never
 *    a partial success.
 */

import { MotionJobFailure, describeStopReason, WALL_CLOCK_MARKER, TURN_CAP_MARKER } from './failures.js';

/**
 * Runs generation + render inside both caps (D3).
 *
 * @param {object} input   { brief, model, maxTurns, wallClockSeconds }
 * @param {object} deps    {
 *   apiKey,                       — plaintext, from stdin, memory-only
 *   createProject(brief, meta),   — Anymotion workspace (per-job dir via env)
 *   generate(messages, options),  — generateMotionGraphics
 *   render(options),              — renderVideo
 *   harvestNewestMp4(exportsDir), — D8: the agent may have rendered mid-loop
 *   emitProgress(event),          — advisory, parent-facing
 *   now(),                        — clock seam
 * }
 * @returns {Promise<{mp4Path: string, turns: number, wallSeconds: number}>}
 */
export async function runMotionJob(input, deps) {
  const startedAt = deps.now();
  const controller = new AbortController();
  let abortReason = null;
  const abortWith = (reason) => {
    if (!abortReason) abortReason = reason;
    controller.abort();
  };

  // Wall clock covers EVERYTHING — including renders the agent runs
  // mid-loop (D8: both measured runs rendered inside generation).
  const wallTimer = setTimeout(
    () => abortWith(WALL_CLOCK_MARKER),
    input.wallClockSeconds * 1000,
  );
  wallTimer.unref?.();

  try {
    const project = deps.createProject(input.brief, {
      prompt: input.brief,
      model: input.model,
      source: 'motion-worker',
    });

    let turnsSeen = 0;
    const result = await deps.generate(
      [{ role: 'user', content: input.brief }],
      {
        project,
        apiKey: deps.apiKey,
        model: input.model,
        signal: controller.signal,
        // The engine merges these into the loop's config: the key rides in
        // memory (V2/D2), and file writes need no interactive approval.
        configOverrides: {
          apiKey: deps.apiKey,
          model: input.model,
          fileApprovalMode: 'auto',
        },
        emit: (event) => {
          if (event.type === 'turn') {
            turnsSeen = event.n;
            // Our cap, imposed through Anymotion's own per-turn event (D3):
            // abort BEFORE the request for the turn past the budget goes out.
            if (event.n > input.maxTurns) abortWith(TURN_CAP_MARKER);
            deps.emitProgress({
              type: 'progress',
              phase: 'generating',
              turn: Math.min(event.n, input.maxTurns),
              maxTurns: input.maxTurns,
            });
          } else if (event.type === 'error' && event.fatal) {
            deps.emitProgress({ type: 'notice', text: String(event.text ?? '') });
          }
        },
      },
    );

    // Belt and braces on a path that should be unreachable (D1): the worker
    // refuses submissions without a key, so the engine's no-key template
    // fallback must never fire — and if it somehow does, that is a FAILED
    // job, never a delivered placeholder.
    if (result.usedFallback) {
      throw new MotionJobFailure(
        'The AI provider was never called and no explainer was generated. ' +
          'Nothing was charged and nothing was saved — please try again. ' +
          '(internal: engine returned usedFallback=true)',
      );
    }

    if (result.stopReason !== 'complete') {
      throw new MotionJobFailure(describeStopReason(result.stopReason, abortReason, input));
    }

    // D8: the agent usually renders mid-loop via its own render_video tool —
    // harvest the newest MP4 rather than assuming we produce the only one.
    let mp4Path = deps.harvestNewestMp4(project.exportsDir);
    if (!mp4Path) {
      deps.emitProgress({ type: 'progress', phase: 'rendering' });
      mp4Path = await deps.render({
        htmlFile: project.htmlFile,
        outputDir: project.exportsDir,
        resolution: '1080p',
        fps: 60,
        onProgress: (p) =>
          deps.emitProgress({ type: 'progress', phase: 'rendering', percent: p.percent }),
      });
    }

    return {
      mp4Path,
      turns: turnsSeen,
      wallSeconds: Math.round((deps.now() - startedAt) / 1000),
    };
  } catch (err) {
    // An abort we caused surfaces as whatever the loop was doing when the
    // signal fired; the honest message is the CAP that fired, not the
    // incidental exception shape.
    if (abortReason) {
      throw new MotionJobFailure(describeStopReason('aborted', abortReason, input));
    }
    throw err;
  } finally {
    clearTimeout(wallTimer);
  }
}
