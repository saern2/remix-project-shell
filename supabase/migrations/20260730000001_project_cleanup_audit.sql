create index if not exists idx_projects_created_at
  on public.projects (created_at);

create table if not exists public.project_cleanup_audit (
  id bigserial primary key,
  project_id uuid not null,
  project_name text,
  project_created_at timestamptz,
  project_status text,
  deleted_at timestamptz not null default now(),
  file_count_removed integer not null default 0 check (file_count_removed >= 0),
  bytes_freed bigint not null default 0 check (bytes_freed >= 0),
  active_render_cancelled boolean not null default false,
  cancelled_render_job_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now()
);

create index if not exists idx_project_cleanup_audit_project_id
  on public.project_cleanup_audit (project_id);

create index if not exists idx_project_cleanup_audit_deleted_at
  on public.project_cleanup_audit (deleted_at desc);

alter table public.project_cleanup_audit enable row level security;

revoke all on public.project_cleanup_audit from anon, authenticated;
grant all on public.project_cleanup_audit to service_role;

create or replace function public.cleanup_delete_project_with_audit(
  p_project_id uuid,
  p_project_name text,
  p_project_created_at timestamptz,
  p_project_status text,
  p_file_count_removed integer,
  p_bytes_freed bigint,
  p_active_render_cancelled boolean,
  p_cancelled_render_job_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_cleanup_audit (
    project_id,
    project_name,
    project_created_at,
    project_status,
    deleted_at,
    file_count_removed,
    bytes_freed,
    active_render_cancelled,
    cancelled_render_job_ids
  )
  values (
    p_project_id,
    p_project_name,
    p_project_created_at,
    p_project_status,
    now(),
    greatest(coalesce(p_file_count_removed, 0), 0),
    greatest(coalesce(p_bytes_freed, 0), 0),
    coalesce(p_active_render_cancelled, false),
    coalesce(p_cancelled_render_job_ids, '{}'::uuid[])
  );

  delete from public.projects
  where id = p_project_id;

  if not found then
    raise exception 'Project % was not deleted during cleanup.', p_project_id;
  end if;
end;
$$;

revoke all on function public.cleanup_delete_project_with_audit(
  uuid,
  text,
  timestamptz,
  text,
  integer,
  bigint,
  boolean,
  uuid[]
) from public, anon, authenticated;

grant execute on function public.cleanup_delete_project_with_audit(
  uuid,
  text,
  timestamptz,
  text,
  integer,
  bigint,
  boolean,
  uuid[]
) to service_role;
