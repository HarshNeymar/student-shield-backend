-- Storage bucket for counseling session recordings
INSERT INTO storage.buckets (id, name, public) VALUES ('session-recordings', 'session-recordings', true)
ON CONFLICT (id) DO NOTHING;

-- Policies: company admin manages, members read
DROP POLICY IF EXISTS "company admin manages session recordings" ON storage.objects;
CREATE POLICY "company admin manages session recordings"
ON storage.objects FOR ALL
USING (bucket_id = 'session-recordings' AND public.has_role(auth.uid(), 'company_admin'))
WITH CHECK (bucket_id = 'session-recordings' AND public.has_role(auth.uid(), 'company_admin'));

DROP POLICY IF EXISTS "anyone reads session recordings" ON storage.objects;
CREATE POLICY "anyone reads session recordings"
ON storage.objects FOR SELECT
USING (bucket_id = 'session-recordings');