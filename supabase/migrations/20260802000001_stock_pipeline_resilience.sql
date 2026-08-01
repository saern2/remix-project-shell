alter table public.pexels_api_keys
  add column if not exists rate_limit_remaining integer,
  add column if not exists rate_limit_reset_at timestamptz;

create index if not exists pexels_api_keys_available_idx
  on public.pexels_api_keys (is_active, rate_limit_reset_at, rate_limit_remaining);

create table if not exists public.nasa_asset_cache (
  nasa_id text primary key,
  files jsonb not null default '[]'::jsonb,
  duration_seconds numeric,
  duration_known boolean not null default false,
  thumbnail_url text,
  cached_at timestamptz not null default now()
);

alter table public.nasa_asset_cache enable row level security;
revoke all on public.nasa_asset_cache from public, anon, authenticated;
grant all on public.nasa_asset_cache to service_role;

alter table public.render_clip_slices
  add column if not exists provider text,
  add column if not exists in_point_seconds numeric not null default 0;

update public.render_clip_slices
set provider = case
  when clip_url ilike '%images-assets.nasa.gov%' then 'nasa'
  else 'pexels'
end
where provider is null;

alter table public.render_clip_slices
  alter column provider set default 'pexels',
  alter column provider set not null;

alter table public.render_clip_slices
  drop constraint if exists render_clip_slices_provider_check;
alter table public.render_clip_slices
  add constraint render_clip_slices_provider_check
  check (provider in ('pexels', 'pixabay', 'nasa'));

alter table public.render_clip_slices
  drop constraint if exists render_clip_slices_in_point_check;
alter table public.render_clip_slices
  add constraint render_clip_slices_in_point_check
  check (in_point_seconds >= 0);

alter table public.projects
  add column if not exists pipeline_cancel_requested_at timestamptz;

create or replace function public.record_pexels_key_response(
  p_id uuid,
  p_remaining integer,
  p_reset_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pexels_api_keys
  set
    request_count = request_count + 1,
    last_used_at = now(),
    rate_limit_remaining = p_remaining,
    rate_limit_reset_at = p_reset_at,
    last_error = null,
    last_error_at = null
  where id = p_id;
end;
$$;

revoke execute on function public.record_pexels_key_response(uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_pexels_key_response(uuid, integer, timestamptz)
  to service_role;

create or replace function public.increment_provider_usage_counts(
  p_provider text,
  p_date date,
  p_request_count integer,
  p_cache_hit_count integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.provider_usage (
    provider,
    usage_date,
    request_count,
    cache_hit_count
  ) values (
    p_provider,
    p_date,
    greatest(p_request_count, 0),
    greatest(p_cache_hit_count, 0)
  )
  on conflict (provider, usage_date) do update
  set
    request_count = public.provider_usage.request_count + excluded.request_count,
    cache_hit_count = public.provider_usage.cache_hit_count + excluded.cache_hit_count;
end;
$$;

revoke execute on function public.increment_provider_usage_counts(text, date, integer, integer)
  from public, anon, authenticated;
grant execute on function public.increment_provider_usage_counts(text, date, integer, integer)
  to service_role;
