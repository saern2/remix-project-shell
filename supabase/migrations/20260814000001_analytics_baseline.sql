-- ── A labelled baseline for the generations that predate capture ───────────
--
-- generation_events began capturing on 2026-08-12. The operator's own records
-- count 607 completed videos since 2026-08-03; the table holds 216. The 391
-- missing generations were deleted before capture existed and are UNRECOVERABLE
-- — no user_id, no audio duration, no scene count.
--
-- WHY NOT BACKFILL generation_events. Inventing 391 rows would need a user_id, a
-- duration and a timestamp for each, and every one of those would be a guess.
-- They would then flow into the per-user ranking, the outcomes donut, the daily
-- chart and every future average, and nothing downstream could tell the guesses
-- from the measurements. One labelled number that is added in exactly one place
-- is honest; 391 fabricated rows are not.
--
-- SO: this table is a single row, added to the PLATFORM LIFETIME totals only.
-- The Today toggle, the 30-day chart, the outcomes donut, the ranked panel and
-- the recent-generations table all describe measured events and stay measured.
--
-- VIDEO MINUTES ARE AN ESTIMATE. 391 x 25 minutes is the operator's figure, not
-- a measurement, and the note column says so where it cannot be separated from
-- the number.

create table if not exists public.analytics_baseline (
  -- One row, enforced. This is a constant, not a log.
  id smallint primary key default 1 check (id = 1),
  generations_completed integer not null check (generations_completed >= 0),
  -- Stored rather than assumed equal to completed. The success-rate denominator
  -- needs it, and burying "all 391 succeeded" inside the RPC would hide the
  -- weakest assumption on the page. Failures in this window were manually
  -- deleted to free project slots, so the true total is unknown and this is a
  -- FLOOR.
  generations_total integer not null check (generations_total >= generations_completed),
  -- ESTIMATE, not a measurement. See the note.
  video_minutes integer not null check (video_minutes >= 0),
  effective_from date not null,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.analytics_baseline enable row level security;

revoke all on public.analytics_baseline from public, anon;
grant all on public.analytics_baseline to service_role;
-- Admins may read it directly; nobody may write it except service_role.
grant select on public.analytics_baseline to authenticated;

drop policy if exists "analytics_baseline_admin_select" on public.analytics_baseline;
create policy "analytics_baseline_admin_select"
  on public.analytics_baseline
  for select
  to authenticated
  -- Inline rather than is_admin(): execute on that function is revoked from
  -- authenticated, so a policy calling it would fail for the very users it is
  -- meant to admit. Same shape as the admin policies in 20260726174707.
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

comment on table public.analytics_baseline is
  'Single labelled row for generations completed before generation_events existed. Added to PLATFORM LIFETIME totals only, never to per-user, per-day or outcome breakdowns.';
comment on column public.analytics_baseline.video_minutes is
  'ESTIMATE (generations x an assumed average length), not measured output.';
comment on column public.analytics_baseline.generations_total is
  'Floor, not a measurement: failures in the pre-capture window were manually deleted, so the true attempt count is unknown.';

-- The measured numbers behind this: 216 completed of 228 recorded events as of
-- 2026-08-14. on conflict do nothing so a re-run cannot clobber an operator
-- correction.
insert into public.analytics_baseline (
  id, generations_completed, generations_total, video_minutes, effective_from, note
)
values (
  1,
  391,
  391,
  9775,
  date '2026-08-03',
  'Reconstructed from operator records for 2026-08-03 to 2026-08-12, before generation_events existed. '
  || 'The underlying projects were deleted and cannot be recovered: no user, duration or scene count survives, '
  || 'which is why these are one labelled total rather than 391 rows. '
  || 'Video minutes are an ESTIMATE at 25 minutes per video, not measured audio length. '
  || 'Failures in this window were manually deleted to free project slots, so the attempt count is a FLOOR '
  || 'and the true success rate for the period is unknown.'
)
on conflict (id) do nothing;

-- ── get_generation_stats: add the baseline, in exactly one place ───────────
--
-- Everything below is byte-identical to 20260813000001 except the block marked
-- BASELINE and the extra key in the returned object. v_lifetime is the only
-- aggregate touched, and only for platform scope.

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
  v_baseline public.analytics_baseline%rowtype;
  v_baseline_json jsonb := null;
begin
  begin
    perform now() at time zone coalesce(p_tz, 'UTC');
    v_tz := coalesce(p_tz, 'UTC');
  exception
    when others then
      v_tz := 'UTC';
  end;

  v_today := (now() at time zone v_tz)::date;

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

  -- Deliberately still the first MEASURED event, not the baseline's start date.
  -- The UI needs both: this is where measurement begins, and the baseline block
  -- below says what precedes it.
  select min(created_at)
  into v_range_start
  from public.generation_events
  where (v_platform or user_id = p_user_id);

  -- ── BASELINE ────────────────────────────────────────────────────────────
  -- Platform lifetime only. Not today, not the previous day, not the daily
  -- series, not the outcomes, not the ranking, not the recent list — those
  -- describe events that were measured, and a number with no event behind it
  -- must not appear among them.
  --
  -- to_regclass so the function still installs and runs where the table has not
  -- been created yet: /stats degrades to measured-only instead of failing.
  if v_platform and to_regclass('public.analytics_baseline') is not null then
    select * into v_baseline from public.analytics_baseline where id = 1;
    if found then
      v_lifetime := jsonb_build_object(
        'completed', (v_lifetime ->> 'completed')::bigint + v_baseline.generations_completed,
        'total', (v_lifetime ->> 'total')::bigint + v_baseline.generations_total,
        'seconds', (v_lifetime ->> 'seconds')::numeric + (v_baseline.video_minutes::numeric * 60)
      );
      v_baseline_json := jsonb_build_object(
        'generations_completed', v_baseline.generations_completed,
        'generations_total', v_baseline.generations_total,
        'video_minutes', v_baseline.video_minutes,
        'effective_from', v_baseline.effective_from,
        'note', v_baseline.note
      );
    end if;
  end if;

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
    'baseline', v_baseline_json,
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
  'All /stats panels in one call, aggregated in SQL. SECURITY DEFINER and service_role-only: the scope argument is enforced by getGenerationStats, which requires admin before passing platform scope. Platform LIFETIME totals include analytics_baseline; every other panel is measured events only.';
