-- Round 8: restore the PROJECT-WIDE stock corpus.
--
-- Round 6 sliced matching into small time-budgeted invocations. The slicing was
-- correct; what went wrong is that clustering came with it. matchStockCorpus
-- clustered only the SLICE's demands, so a 5-scene slice produced 5 buckets and
-- searched 5 fresh queries. Across 29 slices that is ~145 distinct cluster
-- queries instead of the ~37 a whole-project clustering produces — the measured
-- 244 searchCacheMisses against 33 hits.
--
-- The second, worse consequence: assignment could only see its own slice's
-- pools — dozens of candidates instead of thousands. Project-wide uniqueness
-- then drained those small pools and late scenes found everything reserved,
-- which is how a 145-scene project failed because 5 scenes could not be unique.
--
-- This table restores the round-2 design under the round-6 time budget. Buckets
-- are clustered ONCE over every scene in the project and persisted here; the
-- pools are then filled in incrementally across invocations, and assignment
-- reads the whole set. Candidates are stored distilled and capped so loading the
-- entire corpus stays one small query rather than the multi-megabyte read that
-- round 6 removed from the hot path.

create table if not exists public.project_stock_corpus (
  project_id uuid not null references public.projects(id) on delete cascade,
  bucket_id text not null,
  query text not null,
  tokens jsonb not null default '[]'::jsonb,
  demand_ids jsonb not null default '[]'::jsonb,
  -- Distilled StockVideo[]: only the fields ranking, uniqueness and download
  -- need. Capped per bucket so the whole-project load stays bounded.
  candidates jsonb not null default '[]'::jsonb,
  -- Providers already searched for this bucket, so a bucket half-filled when an
  -- invocation ran out of budget resumes instead of restarting.
  providers_done jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, bucket_id)
);

alter table public.project_stock_corpus enable row level security;
revoke all on public.project_stock_corpus from public, anon, authenticated;
grant all on public.project_stock_corpus to service_role;

create index if not exists project_stock_corpus_project_idx
  on public.project_stock_corpus (project_id);

comment on table public.project_stock_corpus is
  'Per-project stock footage corpus: query buckets clustered once over all scenes, with their distilled candidate pools. Built incrementally across matching invocations; assignment reads the whole set so uniqueness draws from thousands of candidates rather than one slice''s worth.';

comment on column public.project_stock_corpus.providers_done is
  'Providers already searched for this bucket. A bucket that ran out of time mid-build resumes from here rather than re-searching.';
