-- Ensure each fixed-duration render slot has at most one persisted clip.
-- This lets app code upsert missing/recomputed slots without deleting the
-- whole project's slice cache first.

with ranked as (
  select
    id,
    row_number() over (
      partition by project_id, scene_id, slice_index
      order by created_at desc, id desc
    ) as rn
  from public.render_clip_slices
)
delete from public.render_clip_slices r
using ranked d
where r.id = d.id
  and d.rn > 1;

create unique index if not exists render_clip_slices_unique_slot
  on public.render_clip_slices (project_id, scene_id, slice_index);
