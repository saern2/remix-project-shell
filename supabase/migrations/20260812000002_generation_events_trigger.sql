-- ── Capture: one generation_events row per terminal project transition ──────
--
-- WHY A TRIGGER RATHER THAN CALL-SITE INSTRUMENTATION. A project reaches a
-- terminal status from twelve distinct places: five in the render lifecycle
-- (pollRenderJob's terminal short-circuit, its worker-404 path, its two main
-- paths, and cancelRenderJob), three in the pipeline (markProjectFailed plus
-- two direct writes in advanceFromTranscribing), and four in the browser
-- (projects.new.tsx's upload failures, which run under the user's own JWT and
-- cannot reach a service-role insert at all). Instrumenting twelve call sites
-- guarantees the thirteenth is missed. The trigger sits under all of them,
-- including the client-side four, and cannot be bypassed by a new path.

-- ── Derived values, defined ONCE ────────────────────────────────────────────
-- The trigger and the backfill must classify identically: if they disagree,
-- reconstructed history and measured history are not comparable and the whole
-- table is untrustworthy. Rather than duplicate the SQL in two migrations and
-- hope they stay in step, both call this one function. Parity is structural,
-- not a matter of review.
--
-- STABLE, not SECURITY DEFINER: it is only ever called from the SECURITY
-- DEFINER trigger below (where it already runs with the definer's rights) or
-- from a migration. Execute is revoked from client roles so it cannot be used
-- to read another user's project shape.
create or replace function public.generation_event_payload(
  p_project_id uuid,
  p_status text
)
returns table (
  event_type text,
  scene_count integer,
  audio_duration_seconds numeric,
  render_duration_ms bigint
)
language sql
stable
set search_path = public
as $$
  with latest_render as (
    -- "Most recent" needs a tiebreaker: two render jobs created in the same
    -- microsecond would otherwise order nondeterministically, and the trigger
    -- and the backfill could then classify the same project differently.
    select rj.status, rj.started_at, rj.completed_at
    from public.render_jobs rj
    where rj.project_id = p_project_id
    order by rj.created_at desc, rj.id desc
    limit 1
  )
  select
    case
      when p_status = 'completed' then 'completed'
      -- A user cancel writes render_jobs.status = 'cancelled' and THEN
      -- projects.status = 'failed', in that order and in separate
      -- transactions, so the cancelled row is committed and visible here.
      --
      -- Only the MOST RECENT render job counts. Checking "any cancelled render
      -- job" would misread a retried project: cancel render 1, retry, render 2
      -- genuinely fails — the old cancelled row would classify that failure as
      -- 'cancelled', and the unique index would then silently drop it as a
      -- duplicate of the event already written. The failure would vanish.
      when p_status = 'failed'
        and (select lr.status from latest_render lr) = 'cancelled' then 'cancelled'
      else 'failed'
    end as event_type,
    (select count(*) from public.scenes s where s.project_id = p_project_id)::integer
      as scene_count,
    (
      select a.duration_sec
      from public.audio_assets a
      where a.project_id = p_project_id
      order by a.created_at desc, a.id desc
      limit 1
    ) as audio_duration_seconds,
    (
      -- NULL when the render never started or never finished. An unstarted
      -- render has no duration; inventing 0 would read as an instant render.
      select (extract(epoch from (lr.completed_at - lr.started_at)) * 1000)::bigint
      from latest_render lr
      where lr.started_at is not null
        and lr.completed_at is not null
    ) as render_duration_ms;
$$;

revoke all on function public.generation_event_payload(uuid, text) from public, anon, authenticated;

comment on function public.generation_event_payload(uuid, text) is
  'Single source of truth for generation_events derived columns. Called by both the capture trigger and the backfill so reconstructed and measured history classify identically.';

-- ── The trigger function ────────────────────────────────────────────────────
create or replace function public.record_generation_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload record;
begin
  -- Re-check of the trigger's own WHEN clause. Redundant while the trigger is
  -- attached as defined below, and deliberately so: it keeps the guard true if
  -- this function is ever attached to another trigger without the clause.
  if not (
    OLD.status is distinct from NEW.status
    and NEW.status in ('completed', 'failed')
  ) then
    return NEW;
  end if;

  select * into v_payload
  from public.generation_event_payload(NEW.id, NEW.status);

  insert into public.generation_events (
    user_id,
    project_id,
    event_type,
    scene_count,
    audio_duration_seconds,
    render_duration_ms,
    failure_stage,
    failure_reason,
    backfilled
  )
  values (
    NEW.user_id,
    NEW.id,
    v_payload.event_type,
    v_payload.scene_count,
    v_payload.audio_duration_seconds,
    v_payload.render_duration_ms,
    -- The stage the project was in when it left it. This is the ONLY place
    -- that fact exists: `projects` has no failure-stage column, and once the
    -- status has moved, the previous value is gone. The backfill therefore
    -- cannot recover it for historical rows.
    case when v_payload.event_type = 'completed' then null else OLD.status end,
    case when v_payload.event_type = 'completed' then null else NEW.error_message end,
    false
  )
  -- The pipeline is browser-poll driven: two overlapping polls can both observe
  -- the same terminal transition. Double-counting is the failure mode this
  -- table exists to avoid, so the conflict is expected and swallowed.
  on conflict (project_id, event_type) do nothing;

  return NEW;
exception
  when others then
    -- Capturing a statistic must never fail a render, a cancel, or an upload.
    -- But it must not disappear either: this surfaces in Postgres logs with the
    -- project id and the SQLSTATE, so a systematic failure is visible rather
    -- than showing up as a quietly shrinking count.
    raise warning 'record_generation_event failed for project %: % (SQLSTATE %)',
      NEW.id, SQLERRM, SQLSTATE;
    return NEW;
end;
$$;

comment on function public.record_generation_event() is
  'AFTER UPDATE trigger on projects. Writes one generation_events row per terminal transition. Never raises: a failure to record a statistic must not fail the update that produced it.';

-- ── Attachment ──────────────────────────────────────────────────────────────
-- The WHEN clause is the performance guard, not an optimisation. Matching
-- writes `projects` two to three times per poll (matching_lock_at on acquire
-- and release, matching_idle_rounds on nearly every invocation) — on the order
-- of 60-170 UPDATEs per project, none of which change status. PostgreSQL
-- evaluates WHEN without invoking the function, so for all of those the
-- function body is never entered and the payload subqueries are never planned.
drop trigger if exists trg_projects_generation_event on public.projects;
create trigger trg_projects_generation_event
  after update on public.projects
  for each row
  when (
    OLD.status is distinct from NEW.status
    and NEW.status in ('completed', 'failed')
  )
  execute function public.record_generation_event();
