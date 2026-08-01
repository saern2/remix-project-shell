-- Approved administrators authenticate with credentials only. Regular users still
-- require an administrator-issued access secret and trusted-client activation.

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
  select uas.* into v_secret
  from public.user_access_secrets as uas
  where uas.user_id = p_user_id and uas.status in ('active', 'exhausted')
  for update;

  if not found then
    return query select 'denied'::text, 0, 5;
    return;
  end if;

  if exists (
    select 1
    from public.access_activations as aa
    where aa.secret_id = v_secret.id
      and aa.client_token_hash = p_client_token_hash
      and aa.revoked_at is null
  ) then
    update public.access_activations as aa
      set last_seen_at = v_now
      where aa.secret_id = v_secret.id and aa.client_token_hash = p_client_token_hash;
    update public.user_access_secrets as uas
      set last_used_at = v_now
      where uas.id = v_secret.id;
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
    update public.user_access_secrets as uas
      set status = 'exhausted'
      where uas.id = v_secret.id;
    return query select 'exhausted'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  insert into public.access_activations(secret_id, user_id, client_token_hash)
    values (v_secret.id, p_user_id, p_client_token_hash);
  update public.user_access_secrets as uas set
    activation_count = uas.activation_count + 1,
    status = case
      when uas.activation_count + 1 >= uas.max_activations then 'exhausted'
      else 'active'
    end,
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

revoke all on function public.activate_access_secret(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.activate_access_secret(uuid, text, text) to service_role;

-- Remove any obsolete administrator secrets and trusted-client activations.
update public.access_activations as aa
set revoked_at = coalesce(aa.revoked_at, now())
where aa.user_id in (
  select u.id from public.users as u where u.role = 'admin'
);

update public.user_access_secrets as uas
set
  status = 'revoked',
  revoked_at = coalesce(uas.revoked_at, now()),
  revocation_reason = coalesce(uas.revocation_reason, 'Administrator credential-only access')
where uas.user_id in (
  select u.id from public.users as u where u.role = 'admin'
)
and uas.status in ('active', 'exhausted');

create or replace function public.has_platform_account_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users as u
    where u.id = auth.uid()
      and u.approval_status = 'approved'
      and (
        u.role = 'admin'
        or exists (
          select 1
          from public.user_access_secrets as uas
          where uas.user_id = u.id
            and uas.status in ('active', 'exhausted')
            and uas.activation_count > 0
        )
      )
  );
$$;

revoke all on function public.has_platform_account_access() from public, anon;
grant execute on function public.has_platform_account_access() to authenticated, service_role;
