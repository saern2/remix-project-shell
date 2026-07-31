alter table public.projects
  add column if not exists niche text not null default 'general';

alter table public.projects
  drop constraint if exists projects_niche_check;

alter table public.projects
  add constraint projects_niche_check
  check (niche ~ '^[a-z][a-z0-9_-]{0,31}$');

alter table public.clip_candidates
  drop constraint if exists clip_candidates_provider_check;

alter table public.clip_candidates
  add constraint clip_candidates_provider_check
  check (provider in ('pexels', 'pixabay', 'nasa'));

alter table public.provider_usage
  drop constraint if exists provider_usage_provider_check;

alter table public.provider_usage
  add constraint provider_usage_provider_check
  check (provider in ('pexels', 'pixabay', 'nasa', 'assemblyai', 'groq_whisper', 'deepgram'));
