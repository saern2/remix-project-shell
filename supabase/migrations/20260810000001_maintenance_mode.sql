-- Maintenance mode: a platform-wide freeze the operator can toggle.
--
-- One row, enforced by a fixed primary key. A table that can only ever hold a
-- single row is the cheapest way to make "read the current state" a query that
-- cannot return an ambiguous answer -- no ordering, no "most recent", no
-- possibility of two rows disagreeing about whether the platform is frozen.
--
-- The env var MAINTENANCE_MODE overrides this in both directions and is
-- resolved in the application, not here: a database flag is useless during
-- database maintenance, which is exactly when the brake is needed most.

create table if not exists public.maintenance_state (
  id boolean primary key default true,
  enabled boolean not null default false,
  -- Optional operator note: "Back at 3pm", or anything else. Null means no
  -- estimate is given, which is honest and better than inventing one.
  message text,
  enabled_by uuid references public.users(id) on delete set null,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Belt and braces on the single row: the default cannot be relied on if an
  -- insert names the column explicitly.
  constraint maintenance_state_singleton check (id is true)
);

insert into public.maintenance_state (id, enabled)
  values (true, false)
  on conflict (id) do nothing;

alter table public.maintenance_state enable row level security;

-- Everyone signed in may READ it: users need to be told why an action was
-- refused, and the notice has to render on pages they can already see.
drop policy if exists "maintenance readable" on public.maintenance_state;
create policy "maintenance readable" on public.maintenance_state
  for select to authenticated using (true);

-- Nobody may WRITE it through the anon/authenticated key, admin or not. Toggling
-- goes through a server function that checks the role itself, so the write path
-- is one auditable place rather than a policy that has to stay in step with it.
grant select on public.maintenance_state to authenticated;
grant all on public.maintenance_state to service_role;

comment on table public.maintenance_state is
  'Single-row platform freeze flag. Overridden in both directions by the MAINTENANCE_MODE environment variable, which is resolved in the application.';
comment on column public.maintenance_state.message is
  'Optional operator note shown on the maintenance notice, e.g. "Back at 3pm". Null means no estimate is given.';
