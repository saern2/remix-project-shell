-- render_clip_slices: persists the per-slot clip assignments made during
-- fixed-duration render preparation, so the Timeline UI can show them
-- and re-renders can reuse existing assignments without burning API quota.

create table if not exists render_clip_slices (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  scene_id         uuid not null references scenes(id) on delete cascade,
  slice_index      integer not null,
  clip_url         text not null,
  provider_clip_id text,
  duration_seconds numeric not null,
  created_at       timestamptz not null default now()
);

create index if not exists render_clip_slices_lookup
  on render_clip_slices (project_id, scene_id, slice_index);

-- RLS: users can only see slices for projects they own
alter table render_clip_slices enable row level security;

create policy "Users can view their own clip slices"
  on render_clip_slices for select
  using (
    project_id in (
      select id from projects where user_id = auth.uid()
    )
  );

create policy "Service role can manage clip slices"
  on render_clip_slices for all
  using (true)
  with check (true);
