
-- handle_new_user runs from auth trigger only; revoke from API roles
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

-- has_role / get_user_school / is_company_admin only need authenticated
REVOKE EXECUTE ON FUNCTION public.has_role(UUID, app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_school(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_company_admin(UUID) FROM PUBLIC, anon;

-- Ensure set_updated_at has stable search_path (it's not SECURITY DEFINER but linter flagged)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
