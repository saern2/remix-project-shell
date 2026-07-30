-- Run this after deploying cleanup-expired-projects and setting:
--   1. Edge Function secret CLEANUP_CRON_SECRET
--   2. Vault secret cleanup_expired_projects_secret with the same value
--   3. Vault secret project_url with https://fkinlreqbihdcnhputfh.supabase.co
--
-- Hourly is intentional for a 30-hour retention window: old projects are
-- removed promptly without making cleanup compete with user-facing workloads.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('cleanup-expired-projects-hourly')
where exists (
  select 1
  from cron.job
  where jobname = 'cleanup-expired-projects-hourly'
);

select cron.schedule(
  'cleanup-expired-projects-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/cleanup-expired-projects',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'cleanup_expired_projects_secret')
    ),
    body := '{"dryRun":false,"limit":50}'::jsonb
  ) as request_id;
  $$
);
