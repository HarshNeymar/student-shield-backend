DROP POLICY IF EXISTS "anyone reads session recordings" ON storage.objects;
CREATE POLICY "authenticated reads session recordings"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'session-recordings');