-- Round 18, item 5: tell a queued project where it is in line.
--
-- Five ~45-minute projects were admitted at once on 2026-08-07. Every one of
-- them crawled, all five finish lines converged, and the last project spent
-- 15m10s between its final chunk and its video — almost all of it waiting behind
-- other projects' stitches. The worker now caps concurrent renders and queues
-- the rest, which makes finishing times sequential AND knowable.
--
-- Knowable is the part that needs a column. A queued project is
-- indistinguishable from a stuck one on screen: status "queued", no segments
-- done, nothing moving, no explanation. `stall_notice` is the wrong channel —
-- it is a WARNING about a render that is misbehaving, and rendering it for a
-- project that is simply third in line would be alarming and false.
--
-- Two numbers rather than a sentence, so the wording stays in the app where it
-- can be changed without a migration, and so the estimate can be labelled as an
-- estimate at the point it is shown.

alter table public.render_jobs
  add column if not exists queue_position integer,
  add column if not exists queue_estimate_seconds integer;

comment on column public.render_jobs.queue_position is
  '1-based position among projects waiting for a render slot, or null when this project is not waiting. Set from the worker''s admission queue on each poll.';

comment on column public.render_jobs.queue_estimate_seconds is
  'Rough seconds until this project is expected to start, derived from measured per-chunk time and chunk count. An ESTIMATE — must be presented as one. Null when unknown.';
