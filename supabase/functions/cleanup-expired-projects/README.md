# cleanup-expired-projects

Deletes projects whose `projects.created_at` is older than 30 hours, regardless of status.

Default invocation is a dry run. Destructive cleanup only runs when the request body contains:

```json
{ "dryRun": false, "limit": 50 }
```

For destructive testing against disposable projects, pass explicit project IDs.
The project must still be older than 30 hours:

```json
{
  "dryRun": false,
  "limit": 1,
  "projectIds": ["00000000-0000-4000-8000-000000000000"]
}
```

Required Edge Function secrets:

- `CLEANUP_CRON_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SB_SERVICE_ROLE_KEY`
- `RENDER_WORKER_URL`
- `RENDER_WORKER_API_KEY`

Invocation must include:

```text
x-cleanup-secret: <CLEANUP_CRON_SECRET>
```

Deletion order per project:

1. If an expired project has `render_jobs.status in ('rendering', 'stitching')`, call `POST /jobs/:id/cancel`.
2. Poll `GET /jobs/:id` until `cancelled`, `completed`, `failed`, or `404`.
3. If cancellation fails or times out, skip that project for this run.
4. Delete `audio_assets.storage_path` objects from the `audio` bucket.
5. Delete all objects under `render-outputs/{project_id}/`.
6. Call `cleanup_delete_project_with_audit`, which inserts the audit record and deletes the project row in one database transaction.

Schedule hourly with `schedule.sql` after deploying the function and setting the matching Vault secrets.
