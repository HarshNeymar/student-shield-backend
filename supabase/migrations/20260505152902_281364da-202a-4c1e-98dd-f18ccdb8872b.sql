REVOKE ALL ON FUNCTION public.claim_company_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_company_admin() TO authenticated;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_school(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid) TO authenticated;