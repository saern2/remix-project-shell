create index if not exists idx_projects_user_id
  on public.projects (user_id);

create or replace function public.enforce_two_project_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

drop trigger if exists enforce_two_project_limit_before_insert on public.projects;
create trigger enforce_two_project_limit_before_insert
before insert on public.projects
for each row execute function public.enforce_two_project_limit();

comment on function public.enforce_two_project_limit() is
  'Enforces the global two-project ownership limit without deleting existing rows.';
