-- Minimal stand-in for the parts of the deployed schema that
-- generation_events depends on. Column types and the columns the trigger reads
-- mirror src/integrations/supabase/types.ts; anything the trigger never touches
-- is omitted so this file cannot drift into being a second schema definition.
--
-- Supabase supplies auth.uid() and the anon/authenticated/service_role roles.
-- A local cluster does not, so they are stubbed here. Nothing else is faked:
-- the migrations under test run verbatim against this.

create schema if not exists auth;

-- RLS policies reference auth.uid(). The trigger under test does not, so the
-- stub only has to exist and be the right type for the policies to compile.
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

create table if not exists public.users (
  id uuid primary key,
  email text,
  role text not null default 'user'
);

-- Production grants this (catch-up.sql:424). The admin read policy on
-- generation_events reads public.users inline, so without it the policy raises
-- "permission denied for table users" instead of evaluating.
grant select on public.users to authenticated;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  status text not null default 'draft',
  error_message text,
  matching_idle_rounds integer not null default 0,
  matching_lock_at timestamptz,
  pipeline_cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade
);

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  idx integer not null
);

create table if not exists public.audio_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  duration_sec numeric,
  created_at timestamptz not null default now()
);
