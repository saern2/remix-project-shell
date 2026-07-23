CREATE POLICY "own render-outputs read" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'render-outputs'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.projects WHERE user_id = auth.uid()
  )
);