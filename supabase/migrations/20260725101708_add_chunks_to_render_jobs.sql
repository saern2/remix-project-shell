-- Add chunks_total and chunks_completed to render_jobs table
ALTER TABLE public.render_jobs
  ADD COLUMN IF NOT EXISTS chunks_total integer DEFAULT null,
  ADD COLUMN IF NOT EXISTS chunks_completed integer DEFAULT null;
