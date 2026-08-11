-- ── Backfill: recover the history that is still recoverable ─────────────────
--
-- Runs AFTER the table and the trigger, so any project that reaches a terminal
-- status while this migration is being applied is captured live by the trigger
-- and skipped here by the unique index rather than counted twice.
--
-- WHY NOW, AND WHY THIS IS URGENT. The surviving history lives entirely in
-- `projects`, which is not durable: the in-app delete removes rows with no
-- audit trail (roughly ten projects went that way in a single afternoon), and
-- the 30-hour cleanup — currently dormant only because its pg_cron job has
-- never been installed — is built to delete every row older than 30 hours.
-- Every project in the table is already far past that. If the cleanup's
-- schedule is ever installed before this migration runs, there is nothing left
-- to reconstruct.
--
-- WHAT IT CANNOT RECOVER. failure_stage stays NULL for every backfilled row.
-- The stage a project failed at exists only as the PREVIOUS value of
-- projects.status, which the trigger reads as OLD.status at the moment of
-- transition. Once the status has moved, that value is gone. Guessing
-- "rendering" whenever a render job exists would be wrong for any project that
-- failed at matching after an earlier failed render, which the render-only
-- retry path makes an ordinary case. So it is left NULL and the dashboard must
-- show backfilled failures as stage-unknown.
--
-- Idempotent: ON CONFLICT DO NOTHING against the unique (project_id,
-- event_type) index. Re-running inserts nothing and overwrites nothing — in
-- particular it will not overwrite a row the trigger captured live
-- (backfilled = false) with a reconstructed one.

do $$
declare
  v_completed integer;
  v_failed integer;
  v_cancelled integer;
  v_total integer;
  v_eligible integer;
begin
  select count(*) into v_eligible
  from public.projects p
  where p.status in ('completed', 'failed');

  with inserted as (
    insert into public.generation_events (
      user_id,
      project_id,
      event_type,
      source,
      scene_count,
      audio_duration_seconds,
      render_duration_ms,
      failure_stage,
      failure_reason,
      backfilled,
      created_at
    )
    select
      p.user_id,
      p.id,
      g.event_type,
      'audio_upload',
      g.scene_count,
      g.audio_duration_seconds,
      g.render_duration_ms,
      -- Not recoverable after the fact. See above.
      null,
      case when g.event_type = 'completed' then null else p.error_message end,
      true,
      -- The moment the generation actually ended, not the moment it was
      -- recovered. projects.updated_at is the last write to the row, which for
      -- a terminal project is the terminal write itself.
      p.updated_at
    from public.projects p
    -- The SAME function the trigger uses. Not a copy of its logic: the same
    -- code path, so reconstructed rows cannot be classified differently from
    -- rows captured live.
    cross join lateral public.generation_event_payload(p.id, p.status) g
    where p.status in ('completed', 'failed')
    on conflict (project_id, event_type) do nothing
    returning event_type
  )
  select
    count(*) filter (where event_type = 'completed'),
    count(*) filter (where event_type = 'failed'),
    count(*) filter (where event_type = 'cancelled'),
    count(*)
  into v_completed, v_failed, v_cancelled, v_total
  from inserted;

  raise notice 'generation_events backfill: % row(s) inserted (completed=%, failed=%, cancelled=%) from % eligible project(s) with status in (completed, failed).',
    v_total, v_completed, v_failed, v_cancelled, v_eligible;

  if v_total <> v_eligible then
    -- Not an error: a second run legitimately inserts zero, and a project
    -- captured live by the trigger between the two counts is skipped here on
    -- purpose. It is reported so the operator can reconcile the numbers rather
    -- than discover a gap later.
    raise notice 'generation_events backfill: % eligible project(s) already had an event and were skipped.',
      v_eligible - v_total;
  end if;
end;
$$;
