DROP POLICY IF EXISTS "Service role can manage clip slices" ON public.render_clip_slices;

CREATE POLICY "Service role can manage clip slices"
ON public.render_clip_slices
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);