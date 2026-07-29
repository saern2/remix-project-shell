with scene_spans as (
  select
    s.id,
    s.project_id,
    s.idx,
    s.start_ts,
    s.end_ts,
    lead(s.start_ts) over (partition by s.project_id order by s.idx, s.id) as next_start_ts
  from public.scenes s
),
aligned as (
  select
    r.id,
    round((s.start_ts + (r.slice_index * p.clip_duration_seconds))::numeric, 3) as timeline_start_seconds,
    round(
      least(
        case
          when s.next_start_ts is not null and s.next_start_ts > s.end_ts then s.next_start_ts
          else s.end_ts
        end,
        s.start_ts + ((r.slice_index + 1) * p.clip_duration_seconds)
      )::numeric,
      3
    ) as timeline_end_seconds
  from public.render_clip_slices r
  join scene_spans s on s.id = r.scene_id
  join public.projects p on p.id = r.project_id
  where p.clip_duration_seconds is not null
    and p.clip_duration_seconds > 0
)
update public.render_clip_slices r
set
  timeline_start_seconds = aligned.timeline_start_seconds,
  timeline_end_seconds = aligned.timeline_end_seconds,
  duration_seconds = greatest(0, aligned.timeline_end_seconds - aligned.timeline_start_seconds)
from aligned
where r.id = aligned.id;
