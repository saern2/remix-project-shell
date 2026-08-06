-- A matching_footage stage that can never end.
--
-- A 524-scene project froze at 503 matched. The lock was healthy (acquired and
-- released every poll), the corpus was full (40 buckets, 0 empty, 4,800
-- candidates), and the 21 unmatched scenes were the CONTIGUOUS TAIL — idx 503
-- through 523 — each with a valid visual_query. Invocations took 78ms, far too
-- little to attempt any work.
--
-- Three conditions had to hold at once for it to spin forever:
--
--   1. the pending set came out empty or unprocessable, so no work was done
--   2. the completion check disagreed, so the stage could not reach ready
--   3. 21 unmatched was below the failure threshold (max(2, ceil(524*0.1)) = 53)
--      added the round before, so it could not fail either
--
-- The threshold was right. What it removed was the accidental terminal
-- condition that a hard failure used to provide, and nothing replaced it. This
-- column is the replacement: a count of consecutive invocations that matched
-- nothing new. After a small number of them the stage stops, one way or the
-- other. No project polls forever again, whatever the underlying cause.

alter table public.projects
  add column if not exists matching_idle_rounds integer not null default 0;

comment on column public.projects.matching_idle_rounds is
  'Consecutive matching_footage invocations that matched zero new scenes. Reset to 0 whenever a scene is matched. When it reaches the configured limit the stage terminates — completing if few enough scenes are unmatched, failing otherwise — so matching can never loop indefinitely.';

-- Reset for any project currently stuck, so the watchdog starts counting from a
-- clean slate rather than immediately terminating a healthy run mid-flight.
update public.projects
set matching_idle_rounds = 0
where status = 'matching_footage';
