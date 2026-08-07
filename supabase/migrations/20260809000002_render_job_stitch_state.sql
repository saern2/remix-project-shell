-- Round 18, item 4a: make the stitch phase visible.
--
-- Once every chunk finishes, the panel showed "51 of 51 segments rendered" and
-- nothing else for as long as the stitch took — 15m10s in the worst observed
-- case. Two different things happen in that window and they deserve different
-- sentences: the stitch may be RUNNING (combining, then uploading), or it may
-- not have started because both stitch slots are busy, in which case the worker
-- knows exactly how many are ahead of it.
--
-- Not folded into `status`: its check constraint deliberately lists terminal
-- and coarse states the cancel/poll machinery depends on, and "waiting to
-- combine" is a refinement of "rendering", not a new lifecycle state.

alter table public.render_jobs
  add column if not exists stitch_state text,
  add column if not exists stitches_ahead integer;

alter table public.render_jobs
  drop constraint if exists render_jobs_stitch_state_check;

alter table public.render_jobs
  add constraint render_jobs_stitch_state_check
  check (stitch_state is null or stitch_state in ('waiting', 'combining', 'uploading'));

comment on column public.render_jobs.stitch_state is
  'Phase of the final combine once all chunks are rendered: waiting (no stitch slot free), combining, or uploading. Null while chunks are still rendering and after completion.';

comment on column public.render_jobs.stitches_ahead is
  'When stitch_state = waiting: how many other projects'' stitches are queued ahead of this one. Null otherwise or when unknown.';
