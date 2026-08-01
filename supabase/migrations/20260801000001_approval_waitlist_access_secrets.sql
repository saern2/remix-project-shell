-- Approval-only access, waitlist applications, and per-browser activations.
create extension if not exists pgcrypto;

alter table public.users
  add column if not exists full_name text,
  add column if not exists phone_e164 text;

alter table public.users drop constraint if exists users_approval_status_check;
alter table public.users
  add constraint users_approval_status_check
  check (approval_status in ('pending', 'approved', 'rejected', 'suspended'));

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
  on public.access_requests (email_normalized)
  where status in ('pending', 'approved');
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
  on public.user_access_secrets (user_id)
  where status in ('active', 'exhausted');
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
  on public.access_activations (user_id, client_token_hash)
  where revoked_at is null;

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

create or replace function public.activate_access_secret(
  p_user_id uuid,
  p_secret_hash text,
  p_client_token_hash text
)
returns table (outcome text, activation_count integer, max_activations integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret public.user_access_secrets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_secret
  from public.user_access_secrets
  where user_id = p_user_id and status in ('active', 'exhausted')
  for update;

  if not found then
    return query select 'denied'::text, 0, 5;
    return;
  end if;

  if exists (
    select 1 from public.access_activations
    where secret_id = v_secret.id
      and client_token_hash = p_client_token_hash
      and revoked_at is null
  ) then
    update public.access_activations
      set last_seen_at = v_now
      where secret_id = v_secret.id and client_token_hash = p_client_token_hash;
    update public.user_access_secrets set last_used_at = v_now where id = v_secret.id;
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
    update public.user_access_secrets set
      failed_window_started_at = case
        when failed_window_started_at is null or failed_window_started_at <= v_now - interval '15 minutes'
          then v_now else failed_window_started_at end,
      failed_attempt_count = case
        when failed_window_started_at is null or failed_window_started_at <= v_now - interval '15 minutes'
          then 1 else failed_attempt_count + 1 end
    where id = v_secret.id;
    insert into public.access_security_events(event_type, user_id, secret_id)
      values ('secret_verification_failed', p_user_id, v_secret.id);
    return query select 'denied'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  if v_secret.status = 'exhausted' or v_secret.activation_count >= v_secret.max_activations then
    update public.user_access_secrets set status = 'exhausted' where id = v_secret.id;
    return query select 'exhausted'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  insert into public.access_activations(secret_id, user_id, client_token_hash)
    values (v_secret.id, p_user_id, p_client_token_hash);
  update public.user_access_secrets set
    activation_count = activation_count + 1,
    status = case when activation_count + 1 >= max_activations then 'exhausted' else 'active' end,
    failed_attempt_count = 0,
    failed_window_started_at = null,
    last_used_at = v_now
  where id = v_secret.id
  returning * into v_secret;
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
  p_user_id uuid,
  p_client_token_hash text
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users u
    join public.user_access_secrets s on s.user_id = u.id
    join public.access_activations a on a.secret_id = s.id and a.user_id = u.id
    where u.id = p_user_id
      and u.approval_status = 'approved'
      and s.status in ('active', 'exhausted')
      and a.client_token_hash = p_client_token_hash
      and a.revoked_at is null
  );
$$;

revoke all on function public.activate_access_secret(uuid, text, text) from public, anon, authenticated;
revoke all on function public.check_access_activation(uuid, text) from public, anon, authenticated;
grant execute on function public.activate_access_secret(uuid, text, text) to service_role;
grant execute on function public.check_access_activation(uuid, text) to service_role;
