-- Create the render-outputs storage bucket (private; service_role uploads via signed URLs)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'render-outputs',
  'render-outputs',
  false,
  524288000,
  array['video/mp4', 'video/webm']
)
on conflict (id) do nothing;

-- RLS: authenticated users can read objects under their own project folders.
-- Path pattern: render-outputs/{project_id}/{job_id}.mp4
create policy "render-outputs: own project read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'render-outputs'
    and (storage.foldername(name))[1] in (
      select id::text from public.projects where user_id = auth.uid()
    )
  );

-- RLS: service_role can insert/update/delete (used for signed upload URL operations)
create policy "render-outputs: service_role insert"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'render-outputs');

create policy "render-outputs: service_role update"
  on storage.objects for update
  to service_role
  using (bucket_id = 'render-outputs');

create policy "render-outputs: service_role delete"
  on storage.objects for delete
  to service_role
  using (bucket_id = 'render-outputs');
