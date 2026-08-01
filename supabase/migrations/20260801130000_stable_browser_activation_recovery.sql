-- Allows an administrator to recover an accidentally exhausted user secret
-- without rotating or revealing it. The row lock prevents reset/activation races.
create or replace function public.reset_access_secret_activations(
  p_secret_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret public.user_access_secrets%rowtype;
  v_revoked_count integer := 0;
begin
  if not exists (
    select 1
    from public.users as actor
    where actor.id = p_actor_user_id
      and actor.role = 'admin'
      and actor.approval_status = 'approved'
  ) then
    raise exception 'Forbidden';
  end if;

  select uas.* into v_secret
  from public.user_access_secrets as uas
  where uas.id = p_secret_id
    and uas.status in ('active', 'exhausted')
  for update;

  if not found then
    return false;
  end if;

  update public.access_activations as aa
  set revoked_at = coalesce(aa.revoked_at, clock_timestamp())
  where aa.secret_id = v_secret.id
    and aa.revoked_at is null;
  get diagnostics v_revoked_count = row_count;

  update public.user_access_secrets as uas
  set
    status = 'active',
    activation_count = 0,
    failed_attempt_count = 0,
    failed_window_started_at = null
  where uas.id = v_secret.id;

  insert into public.access_security_events(
    event_type,
    user_id,
    secret_id,
    actor_user_id,
    metadata
  ) values (
    'secret_activations_reset',
    v_secret.user_id,
    v_secret.id,
    p_actor_user_id,
    jsonb_build_object('revoked_activation_count', v_revoked_count)
  );

  return true;
end;
$$;

revoke all on function public.reset_access_secret_activations(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reset_access_secret_activations(uuid, uuid) to service_role;
