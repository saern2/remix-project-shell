-- Round D: motion explainers (server-side, bring-your-own-key).
--
-- Two pieces:
--
-- 1. user_provider_keys — the user's AI-provider API key, AES-256-GCM
--    encrypted app-side (MOTION_KEY_ENCRYPTION_SECRET in the app's server
--    env) BEFORE it reaches this table. SERVICE-ROLE ONLY: zero grants to
--    authenticated, no RLS policies — the browser structurally cannot read
--    a row, encrypted or not. The app returns only {saved, key_tail}.
--
-- 2. projects gains 'generating_motion' — the honest name for a project
--    whose explainer is being generated on the motion worker (30-60 min,
--    tab-close survivable). Same reasoning as Round B's
--    generating_narration: reusing an existing status would make a live
--    server job indistinguishable from an abandoned one.
--
-- Ceiling sharing needs NO schema change: a motion submission creates an
-- ordinary render_jobs row (status 'queued', settings {"mode":"motion"}),
-- so Round A's platform-wide in-flight count includes motion jobs without
-- touching render-inflight.ts — renders and motion jobs share one bound
-- from both directions.

create table if not exists public.user_provider_keys (
  user_id uuid primary key references public.users(id) on delete cascade,
  -- AES-256-GCM: base64(iv || ciphertext || tag), encrypted app-side.
  ciphertext text not null,
  -- Last 4 characters, for "…x4Kd saved" display. Never the key itself.
  key_tail text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deliberately NO grant to authenticated and NO policies: service_role only.
alter table public.user_provider_keys enable row level security;
grant all on public.user_provider_keys to service_role;

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check check (
  status = any (array[
    'draft',
    'uploading',
    'uploaded',
    'transcribing',
    'generating_narration',
    'generating_motion',
    'generating_scenes',
    'matching_footage',
    'ready',
    'rendering',
    'completed',
    'failed'
  ])
);

-- Verification: both rows should come back.
select 'user_provider_keys (table)' as check_name,
       (to_regclass('public.user_provider_keys') is not null)::text as present
union all
select 'projects allow generating_motion',
       exists (
         select 1 from pg_constraint
         where conname = 'projects_status_check'
           and pg_get_constraintdef(oid) like '%generating_motion%'
       )::text;
