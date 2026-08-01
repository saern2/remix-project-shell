-- Apply only after the app is deployed and primary-admin access is bootstrapped.
-- Adds defense-in-depth for direct PostgREST and Storage API calls.
create or replace function public.has_platform_account_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users u
    join public.user_access_secrets s on s.user_id = u.id
    where u.id = auth.uid()
      and u.approval_status = 'approved'
      and s.status in ('active', 'exhausted')
      and s.activation_count > 0
  );
$$;
revoke all on function public.has_platform_account_access() from public, anon;
grant execute on function public.has_platform_account_access() to authenticated, service_role;

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
end;
$$;

drop policy if exists "Verified platform audio access" on storage.objects;
create policy "Verified platform audio access"
  on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'audio' or (select public.has_platform_account_access()))
  with check (bucket_id <> 'audio' or (select public.has_platform_account_access()));

drop policy if exists "Verified platform render access" on storage.objects;
create policy "Verified platform render access"
  on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'render-outputs' or (select public.has_platform_account_access()))
  with check (bucket_id <> 'render-outputs' or (select public.has_platform_account_access()));
