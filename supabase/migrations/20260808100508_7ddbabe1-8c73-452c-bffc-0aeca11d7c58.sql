create table if not exists public.maintenance_state (
  id boolean primary key default true,
  enabled boolean not null default false,
  message text,
  enabled_by uuid references public.users(id) on delete set null,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint maintenance_state_singleton check (id is true)
);

insert into public.maintenance_state (id, enabled)
  values (true, false)
  on conflict (id) do nothing;

grant select on public.maintenance_state to authenticated;
grant all on public.maintenance_state to service_role;

alter table public.maintenance_state enable row level security;

drop policy if exists "maintenance readable" on public.maintenance_state;
create policy "maintenance readable" on public.maintenance_state
  for select to authenticated using (true);

comment on table public.maintenance_state is
  'Single-row platform freeze flag. Overridden in both directions by the MAINTENANCE_MODE environment variable, which is resolved in the application.';
comment on column public.maintenance_state.message is
  'Optional operator note shown on the maintenance notice, e.g. "Back at 3pm". Null means no estimate is given.';

alter table public.render_jobs
  add column if not exists chunk_state text,
  add column if not exists chunks_ahead integer;

comment on column public.render_jobs.chunk_state is
  'While no chunk has finished: "waiting" or "encoding". Null once chunks start completing, or when unknown.';
comment on column public.render_jobs.chunks_ahead is
  'Chunks from other projects genuinely in front of this one. Null when unknown.';