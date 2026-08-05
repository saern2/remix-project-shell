-- Round 7: let the worker recover from an oversized source without failing the chunk.
--
-- A 235 MB Pixabay rendition was selected against the worker's 150 MB
-- MAX_CLIP_BYTES ceiling. The Content-Length pre-check rejected it correctly,
-- but rejection failed the whole chunk, so every render that drew that clip
-- burned its first attempt. The watchdog work made this recoverable; it did not
-- make it free.
--
-- These columns carry the OTHER renditions of the same source — smaller
-- variants of the identical footage, already present in the provider search
-- response we had at match time. The worker walks them in order when a download
-- is rejected. No extra provider requests at match time, and no HEAD per
-- candidate: the alternatives were always in hand, just discarded.
--
-- Same source throughout, so a fallback changes the file and never the shot,
-- which is what keeps clip uniqueness and scene relevance intact.

alter table public.render_clip_slices
  add column if not exists fallback_urls jsonb not null default '[]'::jsonb;

alter table public.clip_candidates
  add column if not exists fallback_urls jsonb not null default '[]'::jsonb;

comment on column public.render_clip_slices.fallback_urls is
  'Smaller renditions of the same source clip, best-first, for the render worker to fall back to when the primary URL is rejected as oversized. Empty when the provider offers no smaller variant.';

comment on column public.clip_candidates.fallback_urls is
  'Smaller renditions of the same source clip, best-first, for the render worker to fall back to when the primary URL is rejected as oversized.';
