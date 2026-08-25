-- Round B: server-side TTS needs a project state that exists BEFORE audio does.
--
-- The browser TTS path persisted nothing until generation completed. Server-side
-- generation necessarily changes that: the WAV's storage path and the failure
-- surface both need a project id, so the row is created first. This status is
-- the honest name for that window. Reusing 'uploading' was rejected: a
-- server-side job in flight would be indistinguishable from an abandoned manual
-- upload, which is a silent-state lie by another name.
--
-- The value list is the live constraint (20260723132411) plus
-- 'generating_narration'. Idempotent: DROP IF EXISTS + ADD.

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check check (
  status = any (array[
    'draft',
    'uploading',
    'uploaded',
    'transcribing',
    'generating_narration',
    'generating_scenes',
    'matching_footage',
    'ready',
    'rendering',
    'completed',
    'failed'
  ])
);

-- Verification: expect one row whose definition contains 'generating_narration'.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'projects_status_check';
