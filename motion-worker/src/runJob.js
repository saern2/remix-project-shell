/**
 * The job child — one process per job, one key per process (D2).
 *
 * Input arrives as a single JSON line on STDIN (never argv — /proc-visible;
 * never env — /proc/PID/environ-visible): { brief, model, apiKey, maxTurns,
 * wallClockSeconds }. Output is JSON lines on stdout: progress events, then
 * exactly one {type:'result'} or {type:'failure'}. Exit code mirrors it.
 *
 * The parent sets ANYMOTION_PROJECTS_DIR and HOME to the per-job directory,
 * so Anymotion's workspace, any config it looks for, and every temp frame
 * all land inside one directory the parent deletes on every exit path.
 */

import { runMotionJob } from './motionJob.js';
import { describeEngineError, MotionJobFailure } from './failures.js';
import { harvestNewestMp4 } from './harvest.js';

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const input = await readStdinJson();

  // Imported here, after stdin is consumed, so a broken Anymotion install
  // fails with its own error inside the failure protocol rather than a
  // silent non-zero exit before the parent is listening.
  const { generateMotionGraphics } = await import('@anymotion-agent/anymotion/src/agent/ai-engine.js');
  const { renderVideo } = await import('@anymotion-agent/anymotion/src/render/video-renderer.js');
  const { createProject } = await import('@anymotion-agent/anymotion/src/project/workspace.js');

  const result = await runMotionJob(
    {
      brief: input.brief,
      model: input.model,
      maxTurns: input.maxTurns,
      wallClockSeconds: input.wallClockSeconds,
    },
    {
      apiKey: input.apiKey,
      createProject,
      generate: generateMotionGraphics,
      render: renderVideo,
      harvestNewestMp4,
      emitProgress: writeLine,
      now: () => Date.now(),
    },
  );
  writeLine({ type: 'result', mp4Path: result.mp4Path, turns: result.turns, wallSeconds: result.wallSeconds });
}

main().then(
  () => process.exit(0),
  (err) => {
    const message =
      err instanceof MotionJobFailure ? err.message : describeEngineError(err);
    writeLine({ type: 'failure', message });
    process.exit(1);
  },
);
