-- A project can hold an admission slot and still not be encoding.
--
-- Measured 2026-08-09: a 49-chunk project sat at "Rendering, 0 of 49 segments"
-- for 2,193 seconds -- 36.5 minutes -- because all four chunk workers were busy
-- with three older projects. The operator read it as a stall and closed the tab.
-- It had not stalled: it then rendered all 49 chunks in 24 minutes. Its sibling
-- did the same thing for 2,044 seconds.
--
-- Correct behaviour, displayed as failure. This is the third distinct queue in
-- this system that has looked like a hang, so the columns exist to make the
-- waiting state say it is waiting -- exactly as stitch_state/stitches_ahead
-- already do for the stitch queue.
--
-- Two columns rather than a sentence, so the wording lives in the app where it
-- can change without a migration.

alter table public.render_jobs
  add column if not exists chunk_state text,
  add column if not exists chunks_ahead integer;

comment on column public.render_jobs.chunk_state is
  'While no chunk has finished: "waiting" (admitted, but every chunk worker is busy with other projects) or "encoding" (a chunk is on a worker now). Null once chunks start completing, or when unknown.';

comment on column public.render_jobs.chunks_ahead is
  'Chunks from other projects genuinely in front of this one -- queued at a better priority, plus those already on a worker. Null when unknown.';
