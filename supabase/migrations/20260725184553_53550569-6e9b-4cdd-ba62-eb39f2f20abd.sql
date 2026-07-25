ALTER TABLE public.projects
  ADD COLUMN clip_duration_seconds numeric NULL;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_clip_duration_seconds_check
  CHECK (clip_duration_seconds IS NULL OR (clip_duration_seconds BETWEEN 3 AND 6));