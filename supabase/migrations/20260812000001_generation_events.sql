-- ── generation_events: durable lifetime generation history ──────────────────
--
-- WHY THIS TABLE EXISTS. Every fact about a generation currently lives in
-- `projects` and its cascade-linked children, and a project row is not durable:
-- the in-app delete removes it outright with no audit trail, and the 30-hour
-- cleanup is designed to remove it too. Lifetime counts were therefore
-- unrecoverable — roughly ten projects deleted in one afternoon took their
-- history with them, and every failed project ever run had already been
-- manually deleted to free slots under the old 2-project limit.
--
-- So this table is deliberately NOT a view over projects. It is an append-only
-- record that OUTLIVES the thing it describes:
--
--   * project_id is nullable and carries NO foreign key. A FK with cascade
--     would delete the history along with the project, and a FK with restrict
--     would break the delete. The column is a reference for joins while the
--     project still exists, and a tombstone identifier afterwards.
--   * user_id is NOT NULL and is copied, not joined. Attribution is the whole
--     point of the table, and `projects` will not be there to supply it later.
--   * created_at defaults to now(), but the backfill sets it explicitly from
--     projects.updated_at so reconstructed history lands on the date the
--     generation actually finished rather than the date it was recovered.
--
-- Rows are written by the trigger in the next migration, which is SECURITY
-- DEFINER. No client role is granted INSERT/UPDATE/DELETE, so the trigger is
-- the only writer and the table cannot be edited after the fact.

create table if not exists public.generation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  -- No FK, deliberately. See above.
  project_id uuid,
  event_type text not null check (event_type in ('completed', 'failed', 'cancelled')),
  -- Reserved for a future 'script' origin. Present now so the eventual second
  -- source does not require rewriting existing rows.
  source text not null default 'audio_upload',
  scene_count integer,
  audio_duration_seconds numeric,
  render_duration_ms bigint,
  failure_stage text,
  failure_reason text,
  -- Distinguishes reconstructed history from measured history. Backfilled rows
  -- carry a NULL failure_stage because the stage a project failed at is not
  -- recoverable after the fact.
  backfilled boolean not null default false,
  created_at timestamptz not null default now()
);

-- One event per outcome per project. This is what makes the trigger safe to
-- run twice: the pipeline is browser-poll driven, so a terminal transition can
-- be observed by two overlapping polls, and double-counting is the failure mode
-- this table exists to avoid. A project that fails and is then retried to
-- success legitimately holds two rows (one 'failed', one 'completed').
create unique index if not exists generation_events_project_event_key
  on public.generation_events (project_id, event_type);

create index if not exists generation_events_created_at_idx
  on public.generation_events (created_at desc);

create index if not exists generation_events_user_created_at_idx
  on public.generation_events (user_id, created_at desc);

alter table public.generation_events enable row level security;

-- Reads only. The absence of INSERT/UPDATE/DELETE policies is the write
-- protection: with RLS enabled and no permissive policy, no client role can
-- write regardless of grants. The SECURITY DEFINER trigger bypasses RLS as its
-- owner and is the sole writer.
drop policy if exists "Users read their own generation events" on public.generation_events;
create policy "Users read their own generation events"
  on public.generation_events
  for select
  to authenticated
  using (user_id = auth.uid());

-- Same inline predicate as every other admin policy in this schema
-- (pexels_api_keys, maintenance). Deliberately not is_admin(), which is granted
-- to service_role only and is therefore not callable by an authenticated user.
drop policy if exists "Admins read all generation events" on public.generation_events;
create policy "Admins read all generation events"
  on public.generation_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'admin'
    )
  );

grant select on public.generation_events to authenticated;
grant all on public.generation_events to service_role;

comment on table public.generation_events is
  'Append-only lifetime record of generation outcomes. Outlives the project it describes: project_id carries no foreign key so neither the in-app delete nor the 30-hour cleanup can remove history. Written only by trg_projects_generation_event.';

comment on column public.generation_events.backfilled is
  'True for rows reconstructed from surviving projects rows rather than captured at the moment the generation ended. Backfilled rows have a NULL failure_stage.';
