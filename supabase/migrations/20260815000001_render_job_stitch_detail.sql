-- Round 21, F3: the last 14% of a render is three phases, not two freezes.
--
-- MEASURED 2026-08-15 (captures 65/66, two ~45-minute 1080p projects): chunk
-- encoding is 86% of render wall time, combining 7%, uploading 5% — but the
-- progress bar mapped chunks to 0-45% and the stitch to three writes (50, 90,
-- 100), so "30 of 30 segments" displayed as 44% and the bar froze through the
-- whole combine and the whole upload of a 1.2 GB file.
--
-- Two additions let the worker say what is actually happening:
--
--   'finalizing'  — ffmpeg's +faststart second pass rewrites the entire output
--                   so it can start playing before it fully downloads (~89s on
--                   1.2 GB). ffmpeg's own progress stops moving during it, so
--                   without a name it is indistinguishable from a hang.
--   upload bytes  — total and sent, so "Uploading — 640 MB of 1.2 GB" replaces
--                   a frozen bar for the ~80s the upload takes at the storage
--                   side's ~15 MB/s per-connection ceiling.

alter table public.render_jobs
  drop constraint if exists render_jobs_stitch_state_check;

alter table public.render_jobs
  add constraint render_jobs_stitch_state_check
  check (stitch_state is null or stitch_state in ('waiting', 'combining', 'finalizing', 'uploading'));

alter table public.render_jobs
  add column if not exists upload_total_bytes bigint,
  add column if not exists upload_sent_bytes bigint;

comment on column public.render_jobs.stitch_state is
  'Phase of the final combine once all chunks are rendered: waiting (no stitch slot free), combining, finalizing (+faststart rewrite), or uploading. Null while chunks are still rendering and after completion.';

comment on column public.render_jobs.upload_total_bytes is
  'Size of the finished video being uploaded, while stitch_state = uploading. Null otherwise.';

comment on column public.render_jobs.upload_sent_bytes is
  'Bytes of the finished video already handed to the storage connection, while stitch_state = uploading. Null otherwise.';
