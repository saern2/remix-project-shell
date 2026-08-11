-- ── get_generation_stats: every number the /stats page needs, in one call ───
--
-- WHY A DATABASE FUNCTION. PostgREST cannot express the two things this page
-- depends on. The 30-day chart must render a day with no generations as a
-- zero-height bar rather than a gap, which needs generate_series left-joined
-- against the events — there is no PostgREST syntax for that. And the page
-- needs six aggregations in ONE round trip, not six requests or one bulk fetch
-- reduced in JavaScript.
--
-- SECURITY. SECURITY DEFINER, so it bypasses RLS and can serve platform scope.
-- That makes the scope argument load-bearing: execute is revoked from anon and
-- authenticated and granted only to service_role, so the only caller is the
-- getGenerationStats server function, which checks isCallerAdmin before it ever
-- passes p_scope => 'platform'. Same shape as check_access_activation and the
-- other service_role-only functions in this schema.
--
-- TIMEZONE. "Today" and the daily buckets are computed in the caller's
-- timezone, not UTC: a user in UTC-7 looking at the page at 6pm should not see
-- an empty "today" because the server has already rolled over. An unusable or
-- absent zone falls back to UTC rather than failing the page.

create or replace function public.get_generation_stats(
  p_scope text,
  p_user_id uuid,
  p_tz text default 'UTC'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_platform boolean := (p_scope = 'platform');
  v_tz text := 'UTC';
  v_today date;
  v_today_stats jsonb;
  v_prev_stats jsonb;
  v_lifetime jsonb;
  v_daily jsonb;
  v_outcomes jsonb;
  v_ranked jsonb;
  v_recent jsonb;
  v_active integer;
  v_range_start timestamptz;
begin
  -- An invalid IANA name would otherwise raise and take the whole page down
  -- for a cosmetic setting.
  begin
    perform now() at time zone coalesce(p_tz, 'UTC');
    v_tz := coalesce(p_tz, 'UTC');
  exception
    when others then
      v_tz := 'UTC';
  end;

  v_today := (now() at time zone v_tz)::date;

  -- Cards 1-3, for the two windows the toggle offers, plus the previous day so
  -- the UI can show a delta for "Today". Lifetime has no previous period and
  -- deliberately gets none.
  --
  -- Minutes and the headline count are COMPLETED only: a failed generation
  -- produced no video, so counting its audio length as video minutes would
  -- overstate output. The success-rate denominator is every event, which is
  -- why it is counted separately here.
  select
    jsonb_build_object(
      'completed', count(*) filter (where event_type = 'completed'),
      'total', count(*),
      'seconds', coalesce(sum(audio_duration_seconds) filter (where event_type = 'completed'), 0)
    )
  into v_today_stats
  from public.generation_events
  where (v_platform or user_id = p_user_id)
    and (created_at at time zone v_tz)::date = v_today;

  select
    jsonb_build_object(
      'completed', count(*) filter (where event_type = 'completed'),
      'total', count(*),
      'seconds', coalesce(sum(audio_duration_seconds) filter (where event_type = 'completed'), 0)
    )
  into v_prev_stats
  from public.generation_events
  where (v_platform or user_id = p_user_id)
    and (created_at at time zone v_tz)::date = v_today - 1;

  select
    jsonb_build_object(
      'completed', count(*) filter (where event_type = 'completed'),
      'total', count(*),
      'seconds', coalesce(sum(audio_duration_seconds) filter (where event_type = 'completed'), 0)
    )
  into v_lifetime
  from public.generation_events
  where (v_platform or user_id = p_user_id);

  -- The lifetime label is read from the data, never assumed. It is the start of
  -- RECORDED history, which is later than the product's first generation:
  -- capture did not exist before Phase 1 and the projects deleted before then
  -- are not recoverable.
  select min(created_at)
  into v_range_start
  from public.generation_events
  where (v_platform or user_id = p_user_id);

  -- Fixed 30-day window, independent of the Today/Lifetime toggle. The
  -- generate_series is the whole point: every day in the window appears,
  -- including the ones with nothing in them.
  select coalesce(
    jsonb_agg(jsonb_build_object('day', d.day, 'count', d.count) order by d.day),
    '[]'::jsonb
  )
  into v_daily
  from (
    select
      series.day::date as day,
      count(e.id) as count
    from generate_series(v_today - 29, v_today, interval '1 day') as series(day)
    left join public.generation_events e
      on (e.created_at at time zone v_tz)::date = series.day::date
     and e.event_type = 'completed'
     and (v_platform or e.user_id = p_user_id)
    group by series.day
  ) d;

  -- Outcome mix over all recorded history, not the selected window: a donut of
  -- one day is noise. Zero rows for a type is information (there have been no
  -- failures), so the UI is expected to render the absence rather than hide it.
  select coalesce(
    jsonb_agg(jsonb_build_object('event_type', o.event_type, 'count', o.count) order by o.event_type),
    '[]'::jsonb
  )
  into v_outcomes
  from (
    select event_type, count(*) as count
    from public.generation_events
    where (v_platform or user_id = p_user_id)
    group by event_type
  ) o;

  if v_platform then
    -- Who is generating. Falls back to the user id when a profile row is gone,
    -- so a deleted account still shows its output rather than disappearing.
    select coalesce(
      jsonb_agg(jsonb_build_object('label', r.label, 'count', r.count) order by r.count desc, r.label),
      '[]'::jsonb
    )
    into v_ranked
    from (
      select
        coalesce(u.email, e.user_id::text) as label,
        count(*) as count
      from public.generation_events e
      left join public.users u on u.id = e.user_id
      where e.event_type = 'completed'
      group by coalesce(u.email, e.user_id::text)
      order by count(*) desc
      limit 10
    ) r;
  else
    -- A single user's own output, banded by project size. Bands are fixed so
    -- the axis does not move between visits.
    select coalesce(
      jsonb_agg(jsonb_build_object('label', b.label, 'count', b.count) order by b.sort),
      '[]'::jsonb
    )
    into v_ranked
    from (
      select band.label, band.sort, count(e.id) as count
      from (values ('<50', 1), ('50-100', 2), ('100-200', 3), ('200+', 4)) as band(label, sort)
      left join public.generation_events e
        on e.user_id = p_user_id
       and e.event_type = 'completed'
       and band.label = case
             when coalesce(e.scene_count, 0) < 50 then '<50'
             when e.scene_count < 100 then '50-100'
             when e.scene_count < 200 then '100-200'
             else '200+'
           end
      group by band.label, band.sort
    ) b;
  end if;

  -- Ten most recent, newest first. render_duration_ms is render job start to
  -- finish, which includes clip downloading — the UI labels it "render time"
  -- and must not present it as encode speed.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
  into v_recent
  from (
    select
      e.id,
      e.created_at,
      e.event_type,
      e.scene_count,
      e.audio_duration_seconds,
      e.render_duration_ms,
      e.backfilled,
      case when v_platform then coalesce(u.email, e.user_id::text) else null end as user_label
    from public.generation_events e
    left join public.users u on u.id = e.user_id
    where (v_platform or e.user_id = p_user_id)
    order by e.created_at desc
    limit 10
  ) t;

  -- Card 4 is CURRENT STATE, not history: it comes from projects, not from
  -- generation_events, and is never filtered by the time toggle.
  select count(*)
  into v_active
  from public.projects
  where status in ('rendering', 'matching_footage')
    and (v_platform or user_id = p_user_id);

  return jsonb_build_object(
    'scope', case when v_platform then 'platform' else 'user' end,
    'timezone', v_tz,
    'today', v_today_stats,
    'previous_day', v_prev_stats,
    'lifetime', v_lifetime,
    'range_start', v_range_start,
    'daily', v_daily,
    'outcomes', v_outcomes,
    'ranked', v_ranked,
    'recent', v_recent,
    'active_now', v_active
  );
end;
$$;

revoke all on function public.get_generation_stats(text, uuid, text) from public, anon, authenticated;
grant execute on function public.get_generation_stats(text, uuid, text) to service_role;

comment on function public.get_generation_stats(text, uuid, text) is
  'All /stats panels in one call, aggregated in SQL. SECURITY DEFINER and service_role-only: the scope argument is enforced by getGenerationStats, which requires admin before passing platform scope.';
