-- Two independent fixes found while auditing which migrations had been applied.

-- ── 1. Administrators are not subject to the two-project limit ───────────────
--
-- The limit is a capacity guard for regular accounts. Administrators operate the
-- platform and need to create projects to reproduce and diagnose user problems,
-- which the trigger made impossible: it counted rows and raised for everyone.
--
-- Enforced here rather than only in the UI because the trigger is the actual
-- gate — the client insert goes straight to PostgREST, so a UI-only exemption
-- would still be rejected by the database.
create or replace function public.enforce_two_project_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Administrators are exempt. Checked first so an admin insert takes no lock
  -- and does no counting.
  if exists (
    select 1
    from public.users as u
    where u.id = new.user_id
      and u.role = 'admin'
  ) then
    return new;
  end if;

  -- Serialize project creation per owner so concurrent tabs cannot exceed the limit.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  if (
    select count(*)
    from public.projects
    where user_id = new.user_id
  ) >= 2 then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_LIMIT_REACHED',
      detail = 'A user may own at most two projects.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_two_project_limit() from public, anon, authenticated;
grant execute on function public.enforce_two_project_limit() to service_role;

comment on function public.enforce_two_project_limit() is
  'Enforces the two-project ownership limit for regular accounts. Administrators are exempt.';

-- ── 2. render_jobs.status must allow 'cancelled' ─────────────────────────────
--
-- cancelRenderJob writes status = 'cancelled', but the check constraint from the
-- original schema only allowed queued/downloading/rendering/completed/failed. The
-- UPDATE is not error-checked, so every cancellation silently violated the
-- constraint and left the job row saying 'rendering' forever while the project
-- moved to failed. That mismatch is exactly what a stale poll then reads.
alter table public.render_jobs
  drop constraint if exists render_jobs_status_check;

alter table public.render_jobs
  add constraint render_jobs_status_check
  check (status in ('queued', 'downloading', 'rendering', 'completed', 'failed', 'cancelled'));
