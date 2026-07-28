alter table public.render_clip_slices
  add column if not exists timeline_start_seconds numeric,
  add column if not exists timeline_end_seconds numeric,
  add column if not exists thumbnail_url text;

with aligned as (
  select
    r.id,
    round((s.start_ts + (r.slice_index * p.clip_duration_seconds))::numeric, 3) as timeline_start_seconds,
    round(
      least(
        s.end_ts,
        s.start_ts + ((r.slice_index + 1) * p.clip_duration_seconds)
      )::numeric,
      3
    ) as timeline_end_seconds
  from public.render_clip_slices r
  join public.scenes s on s.id = r.scene_id
  join public.projects p on p.id = r.project_id
  where p.clip_duration_seconds is not null
)
update public.render_clip_slices r
set
  timeline_start_seconds = aligned.timeline_start_seconds,
  timeline_end_seconds = aligned.timeline_end_seconds,
  duration_seconds = greatest(0, aligned.timeline_end_seconds - aligned.timeline_start_seconds)
from aligned
where r.id = aligned.id;

update public.render_clip_slices
set
  timeline_start_seconds = coalesce(timeline_start_seconds, 0),
  timeline_end_seconds = coalesce(timeline_end_seconds, duration_seconds)
where timeline_start_seconds is null
  or timeline_end_seconds is null;

alter table public.render_clip_slices
  alter column timeline_start_seconds set not null,
  alter column timeline_end_seconds set not null;
