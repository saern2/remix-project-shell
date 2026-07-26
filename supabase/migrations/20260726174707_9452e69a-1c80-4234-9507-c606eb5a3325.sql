-- users columns (idempotent; already present)
alter table public.users add column if not exists role text not null default 'user';
alter table public.users add column if not exists approval_status text not null default 'pending';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_role_check') then
    alter table public.users add constraint users_role_check check (role in ('user','admin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_approval_status_check') then
    alter table public.users add constraint users_approval_status_check check (approval_status in ('pending','approved','rejected'));
  end if;
end $$;

-- pexels_api_keys table
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

grant select, insert, update, delete on public.pexels_api_keys to authenticated;
grant all on public.pexels_api_keys to service_role;

alter table public.pexels_api_keys enable row level security;

drop policy if exists "Admins manage pexels keys" on public.pexels_api_keys;
create policy "Admins manage pexels keys"
  on public.pexels_api_keys
  for all
  to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));