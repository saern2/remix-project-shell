-- Phase 3 approval gate hardening.
-- Users may read their own profile, but approval/role changes must go through
-- admin server functions using the service role.

drop policy if exists "own profile" on public.users;

create policy "Users can read own profile"
  on public.users
  for select
  to authenticated
  using (auth.uid() = id);

grant select on public.users to authenticated;
grant all on public.users to service_role;
