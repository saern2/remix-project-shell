create or replace function public.is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.users u where u.id = _user_id and u.role = 'admin')
$$;

revoke execute on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

create or replace function public.increment_pexels_key_usage(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pexels_api_keys
     set request_count = request_count + 1,
         last_used_at = now()
   where id = p_id;
end;
$$;

revoke execute on function public.increment_pexels_key_usage(uuid) from public;
grant execute on function public.increment_pexels_key_usage(uuid) to service_role;