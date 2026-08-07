-- ============================================================================
-- IDEMPOTENT CATCH-UP SCRIPT
--
-- Paste the whole thing into the Supabase SQL editor and run it. It brings a
-- database up to the schema this build expects, and re-running it is harmless:
-- every statement is "if not exists", "create or replace", or a drop-then-create
-- of something whose definition is stated here in full.
--
-- It does NOT touch data. Migrations that only backfilled or re-aligned existing
-- rows (20260728000001, 20260729000001, 20260729000002, 20260723073022,
-- 20260801120000's admin-secret revocation) are left out on purpose — they were
-- one-time repairs against data that may since have changed, and replaying them
-- would rewrite rows the app has legitimately updated since. Their SCHEMA parts
-- (columns, indexes, constraints) are included.
--
-- Section headings name the migration file each block comes from, so anything
-- that errors can be traced back.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 20260720055907: base schema ─────────────────────────────────────────────

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  plan_tier text not null default 'free' check (plan_tier in ('free','pro','business')),
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null default 'Untitled project',
  status text not null default 'draft',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audio_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  duration_sec numeric,
  file_size_bytes bigint,
  mime_type text,
  created_at timestamptz not null default now()
);

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  audio_asset_id uuid references public.audio_assets(id) on delete set null,
  provider text not null check (provider in ('assemblyai','groq_whisper','deepgram','openai_whisper')),
  full_text text not null,
  word_timestamps jsonb,
  language text default 'en',
  created_at timestamptz not null default now()
);

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  transcript_id uuid not null references public.transcripts(id) on delete cascade,
  idx integer not null,
  start_ts numeric not null,
  end_ts numeric not null,
  text text not null,
  visual_query text,
  status text not null default 'pending' check (status in ('pending','query_ready','matched','selected','failed')),
  created_at timestamptz not null default now(),
  unique (project_id, idx)
);

create table if not exists public.clip_candidates (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references public.scenes(id) on delete cascade,
  provider text not null,
  provider_clip_id text not null,
  url text not null,
  thumbnail_url text,
  width integer,
  height integer,
  duration_sec numeric,
  score numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.selected_clips (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references public.scenes(id) on delete cascade,
  clip_candidate_id uuid not null references public.clip_candidates(id) on delete cascade,
  in_point numeric not null default 0,
  out_point numeric not null,
  created_at timestamptz not null default now(),
  unique (scene_id)
);

create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'queued',
  progress_pct integer not null default 0 check (progress_pct between 0 and 100),
  settings jsonb not null,
  output_url text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_usage (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  usage_date date not null default current_date,
  request_count integer not null default 0,
  cache_hit_count integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (provider, usage_date)
);

create index if not exists idx_projects_user_id on public.projects(user_id);
create index if not exists idx_projects_status on public.projects(status);
create index if not exists idx_audio_assets_project_id on public.audio_assets(project_id);
create index if not exists idx_transcripts_project_id on public.transcripts(project_id);
create index if not exists idx_scenes_project_id on public.scenes(project_id);
create index if not exists idx_scenes_status on public.scenes(status);
create index if not exists idx_clip_candidates_scene_id on public.clip_candidates(scene_id);
create index if not exists idx_clip_candidates_provider_clip on public.clip_candidates(provider, provider_clip_id);
create index if not exists idx_selected_clips_scene_id on public.selected_clips(scene_id);
create index if not exists idx_render_jobs_project_id on public.render_jobs(project_id);
create index if not exists idx_render_jobs_status on public.render_jobs(status);

alter table public.users enable row level security;
alter table public.projects enable row level security;
alter table public.audio_assets enable row level security;
alter table public.transcripts enable row level security;
alter table public.scenes enable row level security;
alter table public.clip_candidates enable row level security;
alter table public.selected_clips enable row level security;
alter table public.render_jobs enable row level security;
alter table public.provider_usage enable row level security;

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.audio_assets to authenticated;
grant select, insert, update, delete on public.transcripts to authenticated;
grant select, insert, update, delete on public.scenes to authenticated;
grant select, insert, update, delete on public.clip_candidates to authenticated;
grant select, insert, update, delete on public.selected_clips to authenticated;
grant select, insert, update, delete on public.render_jobs to authenticated;
grant all on public.users to service_role;
grant all on public.projects to service_role;
grant all on public.audio_assets to service_role;
grant all on public.transcripts to service_role;
grant all on public.scenes to service_role;
grant all on public.clip_candidates to service_role;
grant all on public.selected_clips to service_role;
grant all on public.render_jobs to service_role;
grant all on public.provider_usage to service_role;

drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own audio_assets" on public.audio_assets;
create policy "own audio_assets" on public.audio_assets for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "own transcripts" on public.transcripts;
create policy "own transcripts" on public.transcripts for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "own scenes" on public.scenes;
create policy "own scenes" on public.scenes for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "own clip_candidates" on public.clip_candidates;
create policy "own clip_candidates" on public.clip_candidates for all
  using (scene_id in (select s.id from public.scenes s join public.projects p on p.id = s.project_id where p.user_id = auth.uid()))
  with check (scene_id in (select s.id from public.scenes s join public.projects p on p.id = s.project_id where p.user_id = auth.uid()));

drop policy if exists "own selected_clips" on public.selected_clips;
create policy "own selected_clips" on public.selected_clips for all
  using (scene_id in (select s.id from public.scenes s join public.projects p on p.id = s.project_id where p.user_id = auth.uid()))
  with check (scene_id in (select s.id from public.scenes s join public.projects p on p.id = s.project_id where p.user_id = auth.uid()));

drop policy if exists "own render_jobs" on public.render_jobs;
create policy "own render_jobs" on public.render_jobs for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
  before update on public.projects for each row execute function public.set_updated_at();

drop trigger if exists trg_render_jobs_updated_at on public.render_jobs;
create trigger trg_render_jobs_updated_at
  before update on public.render_jobs for each row execute function public.set_updated_at();

-- Storage policies for the audio bucket. Dropped by name rather than in a loop
-- so that every create above has a visible matching drop.
drop policy if exists "audio: own project read" on storage.objects;
drop policy if exists "audio: own project insert" on storage.objects;
drop policy if exists "audio: own project update" on storage.objects;
drop policy if exists "audio: own project delete" on storage.objects;

create policy "audio: own project read" on storage.objects for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] in (select id::text from public.projects where user_id = auth.uid()));
create policy "audio: own project insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] in (select id::text from public.projects where user_id = auth.uid()));
create policy "audio: own project update" on storage.objects for update to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] in (select id::text from public.projects where user_id = auth.uid()));
create policy "audio: own project delete" on storage.objects for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] in (select id::text from public.projects where user_id = auth.uid()));

-- ── 20260720061238 / 20260720065512 / 20260725184103 / 20260725184553:
--    project columns and their final constraint state ───────────────────────

alter table public.projects add column if not exists provider_job_id text;
alter table public.projects add column if not exists aspect_ratio text not null default 'landscape';
alter table public.projects add column if not exists category text;
alter table public.projects add column if not exists clip_duration_seconds numeric;

alter table public.projects drop constraint if exists projects_aspect_ratio_check;
alter table public.projects add constraint projects_aspect_ratio_check
  check (aspect_ratio in ('landscape','portrait','square'));

-- 20260723132411 is the final status list.
alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check
  check (status = any (array['draft','uploading','uploaded','transcribing','generating_scenes','matching_footage','ready','rendering','completed','failed']));

alter table public.projects drop constraint if exists projects_clip_duration_seconds_check;
alter table public.projects add constraint projects_clip_duration_seconds_check
  check (clip_duration_seconds is null or (clip_duration_seconds between 3 and 6));

-- ── 20260720065512: stock_search_cache ──────────────────────────────────────

create table if not exists public.stock_search_cache (
  id uuid not null default gen_random_uuid() primary key,
  provider text not null,
  query text not null,
  orientation text not null,
  results jsonb not null,
  cached_at timestamptz not null default now(),
  unique (provider, query, orientation)
);
create index if not exists idx_stock_search_cache_lookup
  on public.stock_search_cache (provider, query, orientation, cached_at desc);
grant all on public.stock_search_cache to service_role;
alter table public.stock_search_cache enable row level security;

-- ── 20260720074534 / 20260802000001: provider usage functions ───────────────

create or replace function public.increment_provider_usage(
  p_provider text, p_date date, p_cache_hit boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.provider_usage (provider, usage_date, request_count, cache_hit_count)
  values (p_provider, p_date,
    case when p_cache_hit then 0 else 1 end,
    case when p_cache_hit then 1 else 0 end)
  on conflict (provider, usage_date) do update set
    request_count   = public.provider_usage.request_count + excluded.request_count,
    cache_hit_count = public.provider_usage.cache_hit_count + excluded.cache_hit_count,
    updated_at      = now();
end;
$$;

create or replace function public.increment_provider_usage_counts(
  p_provider text, p_date date, p_request_count integer, p_cache_hit_count integer
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.provider_usage (provider, usage_date, request_count, cache_hit_count)
  values (p_provider, p_date, greatest(p_request_count, 0), greatest(p_cache_hit_count, 0))
  on conflict (provider, usage_date) do update set
    request_count = public.provider_usage.request_count + excluded.request_count,
    cache_hit_count = public.provider_usage.cache_hit_count + excluded.cache_hit_count;
end;
$$;

-- ── 20260723000000 / 20260723132446: render-outputs bucket ──────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('render-outputs', 'render-outputs', false, 524288000, array['video/mp4', 'video/webm'])
on conflict (id) do nothing;

drop policy if exists "render-outputs: own project read" on storage.objects;
create policy "render-outputs: own project read" on storage.objects for select to authenticated
  using (bucket_id = 'render-outputs' and (storage.foldername(name))[1] in (select id::text from public.projects where user_id = auth.uid()));

drop policy if exists "own render-outputs read" on storage.objects;
create policy "own render-outputs read" on storage.objects for select to authenticated
  using (bucket_id = 'render-outputs' and (storage.foldername(name))[1] in (select id::text from public.projects where user_id = auth.uid()));

drop policy if exists "render-outputs: service_role insert" on storage.objects;
create policy "render-outputs: service_role insert" on storage.objects for insert to service_role
  with check (bucket_id = 'render-outputs');
drop policy if exists "render-outputs: service_role update" on storage.objects;
create policy "render-outputs: service_role update" on storage.objects for update to service_role
  using (bucket_id = 'render-outputs');
drop policy if exists "render-outputs: service_role delete" on storage.objects;
create policy "render-outputs: service_role delete" on storage.objects for delete to service_role
  using (bucket_id = 'render-outputs');

-- ── 20260725101708: render_jobs chunk counters ──────────────────────────────

alter table public.render_jobs
  add column if not exists chunks_total integer default null,
  add column if not exists chunks_completed integer default null;

-- ── 20260726000001 / 20260802000001 / 20260805140000: render_clip_slices ────

create table if not exists public.render_clip_slices (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  scene_id         uuid not null references public.scenes(id) on delete cascade,
  slice_index      integer not null,
  clip_url         text not null,
  provider_clip_id text,
  duration_seconds numeric not null,
  created_at       timestamptz not null default now()
);

alter table public.render_clip_slices
  add column if not exists timeline_start_seconds numeric,
  add column if not exists timeline_end_seconds numeric,
  add column if not exists thumbnail_url text,
  add column if not exists provider text,
  add column if not exists in_point_seconds numeric not null default 0,
  add column if not exists fallback_urls jsonb not null default '[]'::jsonb;

-- Fills only rows that predate the provider column; a no-op once applied.
update public.render_clip_slices
set provider = case when clip_url ilike '%images-assets.nasa.gov%' then 'nasa' else 'pexels' end
where provider is null;

alter table public.render_clip_slices alter column provider set default 'pexels';

do $$ begin
  if exists (select 1 from public.render_clip_slices where provider is null) then
    raise notice 'render_clip_slices.provider still has NULLs; leaving the column nullable.';
  else
    alter table public.render_clip_slices alter column provider set not null;
  end if;
end $$;

alter table public.render_clip_slices drop constraint if exists render_clip_slices_provider_check;
alter table public.render_clip_slices add constraint render_clip_slices_provider_check
  check (provider in ('pexels', 'pixabay', 'nasa'));

alter table public.render_clip_slices drop constraint if exists render_clip_slices_in_point_check;
alter table public.render_clip_slices add constraint render_clip_slices_in_point_check
  check (in_point_seconds >= 0);

create index if not exists render_clip_slices_lookup
  on public.render_clip_slices (project_id, scene_id, slice_index);
create unique index if not exists render_clip_slices_unique_slot
  on public.render_clip_slices (project_id, scene_id, slice_index);

alter table public.render_clip_slices enable row level security;

drop policy if exists "Users can view their own clip slices" on public.render_clip_slices;
create policy "Users can view their own clip slices" on public.render_clip_slices for select
  using (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "Service role can manage clip slices" on public.render_clip_slices;
create policy "Service role can manage clip slices" on public.render_clip_slices
  for all to service_role using (true) with check (true);

comment on column public.render_clip_slices.fallback_urls is
  'Smaller renditions of the same source clip, best-first, for the render worker to fall back to when the primary URL is rejected as oversized. Empty when the provider offers no smaller variant.';

-- ── 20260726174707 / 20260727000001 / 20260801000001: users + pexels keys ───

alter table public.users
  add column if not exists role text not null default 'user',
  add column if not exists approval_status text not null default 'pending',
  add column if not exists is_primary_admin boolean not null default false,
  add column if not exists full_name text,
  add column if not exists phone_e164 text;

alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check check (role in ('user','admin'));

alter table public.users drop constraint if exists users_approval_status_check;
alter table public.users add constraint users_approval_status_check
  check (approval_status in ('pending', 'approved', 'rejected', 'suspended'));

create unique index if not exists users_primary_admin_unique
  on public.users (is_primary_admin) where (is_primary_admin = true);

drop policy if exists "own profile" on public.users;
drop policy if exists "Users can read own profile" on public.users;
create policy "Users can read own profile" on public.users for select to authenticated
  using (auth.uid() = id);
grant select on public.users to authenticated;

create table if not exists public.pexels_api_keys (
  id uuid primary key default gen_random_uuid(),
  api_key text not null unique,
  is_active boolean not null default true,
  added_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  request_count integer not null default 0
);

alter table public.pexels_api_keys
  add column if not exists rate_limit_remaining integer,
  add column if not exists rate_limit_reset_at timestamptz;

create index if not exists pexels_api_keys_available_idx
  on public.pexels_api_keys (is_active, rate_limit_reset_at, rate_limit_remaining);

grant select, insert, update, delete on public.pexels_api_keys to authenticated;
grant all on public.pexels_api_keys to service_role;
alter table public.pexels_api_keys enable row level security;

drop policy if exists "Admins manage pexels keys" on public.pexels_api_keys;
create policy "Admins manage pexels keys" on public.pexels_api_keys for all to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

-- ── 20260726180755 / 20260802000001: key helper functions ───────────────────

create or replace function public.is_admin(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users u where u.id = _user_id and u.role = 'admin')
$$;

create or replace function public.increment_pexels_key_usage(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pexels_api_keys set request_count = request_count + 1, last_used_at = now()
  where id = p_id;
end;
$$;

create or replace function public.record_pexels_key_response(
  p_id uuid, p_remaining integer, p_reset_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pexels_api_keys set
    request_count = request_count + 1,
    last_used_at = now(),
    rate_limit_remaining = p_remaining,
    rate_limit_reset_at = p_reset_at,
    last_error = null,
    last_error_at = null
  where id = p_id;
end;
$$;

-- ── 20260730000001: project cleanup audit ───────────────────────────────────

create index if not exists idx_projects_created_at on public.projects (created_at);

create table if not exists public.project_cleanup_audit (
  id bigserial primary key,
  project_id uuid not null,
  project_name text,
  project_created_at timestamptz,
  project_status text,
  deleted_at timestamptz not null default now(),
  file_count_removed integer not null default 0 check (file_count_removed >= 0),
  bytes_freed bigint not null default 0 check (bytes_freed >= 0),
  active_render_cancelled boolean not null default false,
  cancelled_render_job_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now()
);
create index if not exists idx_project_cleanup_audit_project_id on public.project_cleanup_audit (project_id);
create index if not exists idx_project_cleanup_audit_deleted_at on public.project_cleanup_audit (deleted_at desc);
alter table public.project_cleanup_audit enable row level security;
revoke all on public.project_cleanup_audit from anon, authenticated;
grant all on public.project_cleanup_audit to service_role;

create or replace function public.cleanup_delete_project_with_audit(
  p_project_id uuid, p_project_name text, p_project_created_at timestamptz,
  p_project_status text, p_file_count_removed integer, p_bytes_freed bigint,
  p_active_render_cancelled boolean, p_cancelled_render_job_ids uuid[]
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_cleanup_audit (
    project_id, project_name, project_created_at, project_status, deleted_at,
    file_count_removed, bytes_freed, active_render_cancelled, cancelled_render_job_ids
  ) values (
    p_project_id, p_project_name, p_project_created_at, p_project_status, now(),
    greatest(coalesce(p_file_count_removed, 0), 0),
    greatest(coalesce(p_bytes_freed, 0), 0),
    coalesce(p_active_render_cancelled, false),
    coalesce(p_cancelled_render_job_ids, '{}'::uuid[])
  );
  delete from public.projects where id = p_project_id;
  if not found then
    raise exception 'Project % was not deleted during cleanup.', p_project_id;
  end if;
end;
$$;

-- ── 20260731000001 / 20260731000002: niche, provider and category ───────────

alter table public.projects add column if not exists niche text not null default 'general';

alter table public.projects drop constraint if exists projects_niche_check;
alter table public.projects add constraint projects_niche_check
  check (niche ~ '^[a-z][a-z0-9_-]{0,31}$');

alter table public.projects drop constraint if exists projects_category_check;
alter table public.projects add constraint projects_category_check
  check (category is null or category in ('war', 'crime', 'space'));

alter table public.clip_candidates drop constraint if exists clip_candidates_provider_check;
alter table public.clip_candidates add constraint clip_candidates_provider_check
  check (provider in ('pexels', 'pixabay', 'nasa'));

alter table public.clip_candidates
  add column if not exists fallback_urls jsonb not null default '[]'::jsonb;

comment on column public.clip_candidates.fallback_urls is
  'Smaller renditions of the same source clip, best-first, for the render worker to fall back to when the primary URL is rejected as oversized.';

alter table public.provider_usage drop constraint if exists provider_usage_provider_check;
alter table public.provider_usage add constraint provider_usage_provider_check
  check (provider in ('pexels', 'pixabay', 'nasa', 'assemblyai', 'groq_whisper', 'deepgram'));

-- ── 20260801000001: access requests, secrets, activations ───────────────────

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 100),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email_normalized text not null check (email_normalized = lower(btrim(email_normalized))),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  user_id uuid references public.users(id) on delete set null,
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists access_requests_active_email_unique
  on public.access_requests (email_normalized) where status in ('pending', 'approved');
create index if not exists access_requests_status_created_idx
  on public.access_requests (status, created_at desc);

create table if not exists public.user_access_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  secret_hash text not null unique check (char_length(secret_hash) = 64),
  secret_suffix text not null check (char_length(secret_suffix) = 4),
  status text not null default 'active' check (status in ('active', 'exhausted', 'revoked')),
  activation_count integer not null default 0 check (activation_count between 0 and 5),
  max_activations integer not null default 5 check (max_activations = 5),
  failed_attempt_count integer not null default 0 check (failed_attempt_count >= 0),
  failed_window_started_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.users(id) on delete set null,
  revocation_reason text
);
create unique index if not exists user_access_secrets_one_usable_per_user
  on public.user_access_secrets (user_id) where status in ('active', 'exhausted');
create index if not exists user_access_secrets_user_status_idx
  on public.user_access_secrets (user_id, status);

create table if not exists public.access_activations (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references public.user_access_secrets(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  client_token_hash text not null check (char_length(client_token_hash) = 64),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (secret_id, client_token_hash)
);
create index if not exists access_activations_user_client_idx
  on public.access_activations (user_id, client_token_hash) where revoked_at is null;

create table if not exists public.access_security_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  user_id uuid references public.users(id) on delete set null,
  secret_id uuid references public.user_access_secrets(id) on delete set null,
  request_id uuid references public.access_requests(id) on delete set null,
  actor_user_id uuid references public.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists access_security_events_created_idx
  on public.access_security_events (created_at desc);
create index if not exists access_security_events_user_idx
  on public.access_security_events (user_id, created_at desc);

alter table public.access_requests enable row level security;
alter table public.user_access_secrets enable row level security;
alter table public.access_activations enable row level security;
alter table public.access_security_events enable row level security;
revoke all on public.access_requests from anon, authenticated;
revoke all on public.user_access_secrets from anon, authenticated;
revoke all on public.access_activations from anon, authenticated;
revoke all on public.access_security_events from anon, authenticated;
grant all on public.access_requests to service_role;
grant all on public.user_access_secrets to service_role;
grant all on public.access_activations to service_role;
grant all on public.access_security_events to service_role;

-- 20260801120000 is the current definition of activate_access_secret.
create or replace function public.activate_access_secret(
  p_user_id uuid, p_secret_hash text, p_client_token_hash text
) returns table (outcome text, activation_count integer, max_activations integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_secret public.user_access_secrets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select uas.* into v_secret from public.user_access_secrets as uas
  where uas.user_id = p_user_id and uas.status in ('active', 'exhausted') for update;

  if not found then
    return query select 'denied'::text, 0, 5;
    return;
  end if;

  if exists (
    select 1 from public.access_activations as aa
    where aa.secret_id = v_secret.id and aa.client_token_hash = p_client_token_hash
      and aa.revoked_at is null
  ) then
    update public.access_activations as aa set last_seen_at = v_now
      where aa.secret_id = v_secret.id and aa.client_token_hash = p_client_token_hash;
    update public.user_access_secrets as uas set last_used_at = v_now where uas.id = v_secret.id;
    return query select 'trusted'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  if v_secret.failed_window_started_at is not null
     and v_secret.failed_window_started_at > v_now - interval '15 minutes'
     and v_secret.failed_attempt_count >= 10 then
    return query select 'rate_limited'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  if v_secret.secret_hash <> p_secret_hash then
    update public.user_access_secrets as uas set
      failed_window_started_at = case
        when uas.failed_window_started_at is null
          or uas.failed_window_started_at <= v_now - interval '15 minutes'
          then v_now else uas.failed_window_started_at end,
      failed_attempt_count = case
        when uas.failed_window_started_at is null
          or uas.failed_window_started_at <= v_now - interval '15 minutes'
          then 1 else uas.failed_attempt_count + 1 end
    where uas.id = v_secret.id;
    insert into public.access_security_events(event_type, user_id, secret_id)
      values ('secret_verification_failed', p_user_id, v_secret.id);
    return query select 'denied'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  if v_secret.status = 'exhausted' or v_secret.activation_count >= v_secret.max_activations then
    update public.user_access_secrets as uas set status = 'exhausted' where uas.id = v_secret.id;
    return query select 'exhausted'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  insert into public.access_activations(secret_id, user_id, client_token_hash)
    values (v_secret.id, p_user_id, p_client_token_hash);
  update public.user_access_secrets as uas set
    activation_count = uas.activation_count + 1,
    status = case when uas.activation_count + 1 >= uas.max_activations then 'exhausted' else 'active' end,
    failed_attempt_count = 0,
    failed_window_started_at = null,
    last_used_at = v_now
  where uas.id = v_secret.id
  returning uas.* into v_secret;
  insert into public.access_security_events(event_type, user_id, secret_id, metadata)
    values ('client_activated', p_user_id, v_secret.id,
      jsonb_build_object('activation_count', v_secret.activation_count));
  if v_secret.status = 'exhausted' then
    insert into public.access_security_events(event_type, user_id, secret_id, metadata)
      values ('secret_exhausted', p_user_id, v_secret.id,
        jsonb_build_object('activation_count', v_secret.activation_count));
  end if;
  return query select 'activated'::text, v_secret.activation_count, v_secret.max_activations;
end;
$$;

create or replace function public.check_access_activation(
  p_user_id uuid, p_client_token_hash text
) returns boolean language sql security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users u
    join public.user_access_secrets s on s.user_id = u.id
    join public.access_activations a on a.secret_id = s.id and a.user_id = u.id
    where u.id = p_user_id and u.approval_status = 'approved'
      and s.status in ('active', 'exhausted')
      and a.client_token_hash = p_client_token_hash and a.revoked_at is null
  );
$$;

-- ── 20260801130000: administrator secret recovery ───────────────────────────

create or replace function public.reset_access_secret_activations(
  p_secret_id uuid, p_actor_user_id uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_secret public.user_access_secrets%rowtype;
  v_revoked_count integer := 0;
begin
  if not exists (
    select 1 from public.users as actor
    where actor.id = p_actor_user_id and actor.role = 'admin' and actor.approval_status = 'approved'
  ) then
    raise exception 'Forbidden';
  end if;

  select uas.* into v_secret from public.user_access_secrets as uas
  where uas.id = p_secret_id and uas.status in ('active', 'exhausted') for update;
  if not found then return false; end if;

  update public.access_activations as aa
  set revoked_at = coalesce(aa.revoked_at, clock_timestamp())
  where aa.secret_id = v_secret.id and aa.revoked_at is null;
  get diagnostics v_revoked_count = row_count;

  update public.user_access_secrets as uas set
    status = 'active', activation_count = 0, failed_attempt_count = 0,
    failed_window_started_at = null
  where uas.id = v_secret.id;

  insert into public.access_security_events(event_type, user_id, secret_id, actor_user_id, metadata)
  values ('secret_activations_reset', v_secret.user_id, v_secret.id, p_actor_user_id,
    jsonb_build_object('revoked_activation_count', v_revoked_count));

  return true;
end;
$$;

-- ── 20260801000002 / 20260801120000: restrictive platform-access RLS ────────

create or replace function public.has_platform_account_access()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users as u
    where u.id = auth.uid() and u.approval_status = 'approved'
      and (
        u.role = 'admin'
        or exists (
          select 1 from public.user_access_secrets as uas
          where uas.user_id = u.id and uas.status in ('active', 'exhausted')
            and uas.activation_count > 0
        )
      )
  );
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'projects', 'audio_assets', 'transcripts', 'scenes', 'clip_candidates',
    'selected_clips', 'render_jobs', 'render_clip_slices'
  ] loop
    execute format('drop policy if exists "Verified platform access" on public.%I', table_name);
    execute format(
      'create policy "Verified platform access" on public.%I as restrictive for all to authenticated using ((select public.has_platform_account_access())) with check ((select public.has_platform_account_access()))',
      table_name
    );
  end loop;
end $$;

drop policy if exists "Verified platform audio access" on storage.objects;
create policy "Verified platform audio access" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'audio' or (select public.has_platform_account_access()))
  with check (bucket_id <> 'audio' or (select public.has_platform_account_access()));

drop policy if exists "Verified platform render access" on storage.objects;
create policy "Verified platform render access" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'render-outputs' or (select public.has_platform_account_access()))
  with check (bucket_id <> 'render-outputs' or (select public.has_platform_account_access()));

-- ── 20260802000001: NASA asset cache + cancel flag ──────────────────────────

create table if not exists public.nasa_asset_cache (
  nasa_id text primary key,
  files jsonb not null default '[]'::jsonb,
  duration_seconds numeric,
  duration_known boolean not null default false,
  thumbnail_url text,
  cached_at timestamptz not null default now()
);

-- 20260805000001
alter table public.nasa_asset_cache add column if not exists has_captions boolean;
comment on column public.nasa_asset_cache.has_captions is
  'Whether images-api.nasa.gov/captions has a .vtt/.srt track for this asset. NULL means not yet probed.';

alter table public.nasa_asset_cache enable row level security;
revoke all on public.nasa_asset_cache from public, anon, authenticated;
grant all on public.nasa_asset_cache to service_role;

alter table public.projects add column if not exists pipeline_cancel_requested_at timestamptz;

-- ── 20260804000001: matching advisory lock ──────────────────────────────────

alter table public.projects add column if not exists matching_lock_at timestamptz;
comment on column public.projects.matching_lock_at is
  'Advisory single-flight lock for the matching_footage stage. Set to now() while a poll is actively matching; cleared on return.';

-- ── 20260805120000: render stall notice ─────────────────────────────────────

alter table public.render_jobs add column if not exists stall_notice text;
comment on column public.render_jobs.stall_notice is
  'Non-terminal warning about a render that is taking abnormally long. Null when healthy. Distinct from `error`, which is terminal.';

-- ── 20260805160000: project-wide stock corpus ───────────────────────────────

create table if not exists public.project_stock_corpus (
  project_id uuid not null references public.projects(id) on delete cascade,
  bucket_id text not null,
  query text not null,
  tokens jsonb not null default '[]'::jsonb,
  demand_ids jsonb not null default '[]'::jsonb,
  candidates jsonb not null default '[]'::jsonb,
  providers_done jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, bucket_id)
);
alter table public.project_stock_corpus enable row level security;
revoke all on public.project_stock_corpus from public, anon, authenticated;
grant all on public.project_stock_corpus to service_role;
create index if not exists project_stock_corpus_project_idx
  on public.project_stock_corpus (project_id);

-- ── 20260731000003 + 20260806000001: project limit, admins exempt ───────────

create or replace function public.enforce_two_project_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.users as u where u.id = new.user_id and u.role = 'admin'
  ) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  if (select count(*) from public.projects where user_id = new.user_id) >= 2 then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_LIMIT_REACHED',
      detail = 'A user may own at most two projects.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_two_project_limit_before_insert on public.projects;
create trigger enforce_two_project_limit_before_insert
before insert on public.projects
for each row execute function public.enforce_two_project_limit();

comment on function public.enforce_two_project_limit() is
  'Enforces the two-project ownership limit for regular accounts. Administrators are exempt.';

-- ── 20260806000001: render_jobs may be cancelled ────────────────────────────

alter table public.render_jobs drop constraint if exists render_jobs_status_check;
alter table public.render_jobs add constraint render_jobs_status_check
  check (status in ('queued', 'downloading', 'rendering', 'completed', 'failed', 'cancelled'));

-- ── 20260808000001: matching progress watchdog ──────────────────────────────

alter table public.projects
  add column if not exists matching_idle_rounds integer not null default 0;

comment on column public.projects.matching_idle_rounds is
  'Consecutive matching_footage invocations that matched zero new scenes. When it reaches the configured limit the stage terminates, so matching can never loop indefinitely.';

-- ── 20260809000001: render queue position ───────────────────────────────────

alter table public.render_jobs
  add column if not exists queue_position integer,
  add column if not exists queue_estimate_seconds integer;

comment on column public.render_jobs.queue_position is
  '1-based position among projects waiting for a render slot, or null when this project is not waiting.';
comment on column public.render_jobs.queue_estimate_seconds is
  'Rough seconds until this project is expected to start. An ESTIMATE — must be presented as one. Null when unknown.';

-- ── 20260809000002: stitch phase visibility ─────────────────────────────────

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

-- ── 20260807000001: passwordless sign-in ────────────────────────────────────

alter table public.access_activations
  add column if not exists trusted_until timestamptz;

create index if not exists access_activations_trusted_idx
  on public.access_activations (user_id, client_token_hash)
  where revoked_at is null;

create table if not exists public.auth_login_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  email_normalized text not null,
  code_hash text check (code_hash is null or char_length(code_hash) = 64),
  client_token_hash text not null check (char_length(client_token_hash) = 64),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists auth_login_codes_live_unique
  on public.auth_login_codes (user_id, client_token_hash)
  where consumed_at is null and invalidated_at is null;
create index if not exists auth_login_codes_email_created_idx
  on public.auth_login_codes (email_normalized, created_at desc);
alter table public.auth_login_codes enable row level security;
revoke all on public.auth_login_codes from public, anon, authenticated;
grant all on public.auth_login_codes to service_role;

create table if not exists public.auth_login_failures (
  id bigint generated always as identity primary key,
  email_normalized text,
  ip_address text,
  stage text not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_login_failures_email_idx
  on public.auth_login_failures (email_normalized, created_at desc);
create index if not exists auth_login_failures_ip_idx
  on public.auth_login_failures (ip_address, created_at desc);
alter table public.auth_login_failures enable row level security;
revoke all on public.auth_login_failures from public, anon, authenticated;
grant all on public.auth_login_failures to service_role;

create or replace function public.revoke_activations_with_secret()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'revoked' and coalesce(old.status, '') <> 'revoked' then
    update public.access_activations
    set revoked_at = coalesce(revoked_at, now())
    where secret_id = new.id and revoked_at is null;

    update public.auth_login_codes
    set invalidated_at = coalesce(invalidated_at, now())
    where user_id = new.user_id and consumed_at is null and invalidated_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists revoke_activations_with_secret_trigger on public.user_access_secrets;
create trigger revoke_activations_with_secret_trigger
after update on public.user_access_secrets
for each row execute function public.revoke_activations_with_secret();

-- check_access_activation and activate_access_secret are redefined by
-- 20260807000001 (trusted-device expiry and constant-time comparison). Their
-- current bodies live in that migration; run it, or the file, to get them.

-- ── Function privileges (20260720055930, 20260720074558, 20260724042257,
--    20260727012002, 20260801053928, 20260801080041) ────────────────────────

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.increment_provider_usage(text, date, boolean) from public, anon, authenticated;
revoke execute on function public.increment_provider_usage_counts(text, date, integer, integer) from public, anon, authenticated;
revoke execute on function public.increment_pexels_key_usage(uuid) from public, anon, authenticated;
revoke execute on function public.record_pexels_key_response(uuid, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.is_admin(uuid) from public, anon, authenticated;
revoke all on function public.enforce_two_project_limit() from public, anon, authenticated;
revoke all on function public.activate_access_secret(uuid, text, text) from public, anon, authenticated;
revoke all on function public.check_access_activation(uuid, text) from public, anon, authenticated;
revoke all on function public.reset_access_secret_activations(uuid, uuid) from public, anon, authenticated;
revoke all on function public.has_platform_account_access() from public, anon, authenticated;
revoke all on function public.cleanup_delete_project_with_audit(uuid, text, timestamptz, text, integer, bigint, boolean, uuid[]) from public, anon, authenticated;
revoke all on function public.revoke_activations_with_secret() from public, anon, authenticated;

grant execute on function public.increment_provider_usage(text, date, boolean) to service_role;
grant execute on function public.increment_provider_usage_counts(text, date, integer, integer) to service_role;
grant execute on function public.increment_pexels_key_usage(uuid) to service_role;
grant execute on function public.record_pexels_key_response(uuid, integer, timestamptz) to service_role;
grant execute on function public.is_admin(uuid) to service_role;
grant execute on function public.enforce_two_project_limit() to service_role;
grant execute on function public.activate_access_secret(uuid, text, text) to service_role;
grant execute on function public.check_access_activation(uuid, text) to service_role;
grant execute on function public.reset_access_secret_activations(uuid, uuid) to service_role;
grant execute on function public.has_platform_account_access() to authenticated, service_role;
grant execute on function public.cleanup_delete_project_with_audit(uuid, text, timestamptz, text, integer, bigint, boolean, uuid[]) to service_role;
grant execute on function public.revoke_activations_with_secret() to service_role;

-- ── Verification: what you asked to confirm ─────────────────────────────────
-- Run this last. Every row should say 'present'.

select
  check_name,
  case when present then 'present' else 'MISSING' end as result
from (
  values
    ('render_jobs.stall_notice',        to_regclass('public.render_jobs') is not null and exists (select 1 from information_schema.columns where table_schema='public' and table_name='render_jobs' and column_name='stall_notice')),
    ('render_clip_slices.fallback_urls', exists (select 1 from information_schema.columns where table_schema='public' and table_name='render_clip_slices' and column_name='fallback_urls')),
    ('clip_candidates.fallback_urls',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='clip_candidates' and column_name='fallback_urls')),
    ('projects.matching_lock_at',        exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='matching_lock_at')),
    ('nasa_asset_cache.has_captions',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='nasa_asset_cache' and column_name='has_captions')),
    ('project_stock_corpus (table)',     to_regclass('public.project_stock_corpus') is not null),
    ('render_jobs allows cancelled',     exists (select 1 from pg_constraint where conname='render_jobs_status_check' and pg_get_constraintdef(oid) like '%cancelled%')),
    ('admins exempt from limit',         exists (select 1 from pg_proc where proname='enforce_two_project_limit' and prosrc like '%role = ''admin''%')),
    ('auth_login_codes (table)',         to_regclass('public.auth_login_codes') is not null),
    ('auth_login_failures (table)',      to_regclass('public.auth_login_failures') is not null),
    ('access_activations.trusted_until', exists (select 1 from information_schema.columns where table_schema='public' and table_name='access_activations' and column_name='trusted_until')),
    ('projects.matching_idle_rounds',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='matching_idle_rounds')),
    ('render_jobs.queue_position',       exists (select 1 from information_schema.columns where table_schema='public' and table_name='render_jobs' and column_name='queue_position')),
    ('render_jobs.stitch_state',         exists (select 1 from information_schema.columns where table_schema='public' and table_name='render_jobs' and column_name='stitch_state'))
) as checks(check_name, present);
