-- Round 6, Issue 6 / Issue B: bounded, resumable, single-flight footage matching.
--
-- The matching_footage stage runs inside a single poll invocation with no guard
-- against concurrent polls. When the client retried a slow/failed poll without
-- backoff, several 50s+ matching invocations stacked on top of each other and
-- saturated the serverless runtime, so unrelated requests (isAdmin, checkAccess)
-- blocked for tens of seconds.
--
-- This adds a lightweight, connection-pool-safe advisory lock: a timestamp column
-- the matching handler claims atomically before doing work and clears when it
-- returns. A second concurrent poll fails to claim it and returns immediately with
-- status matching_footage, so duplicate matching work is never started. The lock
-- is self-healing — a stale claim (holder crashed) is reclaimable after a TTL.

alter table public.projects
  add column if not exists matching_lock_at timestamptz;

comment on column public.projects.matching_lock_at is
  'Advisory single-flight lock for the matching_footage stage. Set to now() while a poll is actively matching; cleared on return. A value older than the handler TTL is treated as stale and reclaimable.';
