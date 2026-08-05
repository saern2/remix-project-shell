-- Round 7, Problem 3: make a stuck render visible.
--
-- A render hung one chunk short for minutes. The UI had nothing to show: the
-- job's status stayed "rendering", chunks_completed simply stopped moving at
-- 12/13, progress_pct sat at 0, and `error` was null because nothing had failed
-- yet. The user saw "12 of 13 segments rendered" and a Cancel button, forever.
--
-- `error` is the wrong channel for this — it is terminal, and the poll handler
-- treats a non-null error on a finished job as a failure. A stall is not a
-- failure: the watchdog may still kill and retry the chunk successfully. This
-- column carries the non-terminal warning, and is cleared the moment the render
-- makes progress again.

alter table public.render_jobs
  add column if not exists stall_notice text;

comment on column public.render_jobs.stall_notice is
  'Non-terminal warning about a render that is taking abnormally long (e.g. a chunk past half its watchdog budget, or being retried). Null when healthy. Distinct from `error`, which is terminal.';
