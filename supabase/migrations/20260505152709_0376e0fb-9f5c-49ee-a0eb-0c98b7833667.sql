CREATE OR REPLACE FUNCTION public.claim_company_admin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _count int;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _uid) THEN
    RAISE EXCEPTION 'Your login session has expired. Please sign in again.';
  END IF;

  SELECT count(*) INTO _count FROM public.user_roles WHERE role = 'company_admin';
  IF _count > 0 THEN
    RAISE EXCEPTION 'Company admin already exists';
  END IF;

  INSERT INTO public.profiles (id, full_name, email)
  SELECT u.id, COALESCE(u.raw_user_meta_data->>'full_name', u.email), u.email
  FROM auth.users u
  WHERE u.id = _uid
  ON CONFLICT (id) DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    email = COALESCE(EXCLUDED.email, public.profiles.email),
    updated_at = now();

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_uid, 'company_admin')
  ON CONFLICT DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_company_admin() TO authenticated;