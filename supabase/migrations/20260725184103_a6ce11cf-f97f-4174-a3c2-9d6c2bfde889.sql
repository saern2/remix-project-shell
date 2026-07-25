ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_category_check
  CHECK (category IS NULL OR category IN ('war', 'crime'));